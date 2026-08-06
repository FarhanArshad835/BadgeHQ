/**
 * Monthly (DELIVERED-BASIS) P&L engine — the correct method from the build spec,
 * with the user's override that we do NOT use OMS: courier tracking is the
 * delivery authority and COGS comes from Shopify cost-per-item.
 *
 * This module computes ONE calendar month (IST) from the OrderFinancials /
 * OrderLineFinancials cache. It is deliberately split so each phase is testable:
 *   - revenueAndDelivered() → Phase 2 (revenue split + delivered counts)
 *   - deliveredCogs()       → Phase 3 (COGS on delivered units only)
 *   - health signals        → coverage / resolution / maturity (spec gates)
 * Freight, ad spend, GST/ops/overhead and the final assembly live in later
 * phases and plug into computeMonth() as they come online.
 *
 * Hard rules kept from the spec:
 *   - Delivered is the unit of truth. Per-unit metrics divide by delivered.
 *   - Never plug a gap. A missing input is null → "PENDING", never a default.
 *   - Rates use RESOLVED orders only; in-transit/unresolved are "not yet known",
 *     counted in placed but excluded from rate denominators.
 *   - Gross is PRE-discount; discounts are a separate deduction line.
 * Money is integer minor units (paise) as bigint throughout.
 */
import prisma from "../db.server";
import { isResolvedOutcome } from "./pnl-sync.server";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Half-open [start, end) UTC instants for an IST calendar month "YYYY-MM". */
export function monthWindowIst(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  // IST midnight on the 1st = UTC (IST − 5:30).
  const startIstMs = Date.UTC(y, m - 1, 1) - IST_OFFSET_MS;
  const endIstMs = Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - IST_OFFSET_MS;
  return { start: new Date(startIstMs), end: new Date(endIstMs) };
}

/** Days elapsed since the month ended (negative if the month hasn't ended). */
export function daysSinceMonthEnd(month: string): number {
  const { end } = monthWindowIst(month);
  return Math.floor((Date.now() - end.getTime()) / (24 * 60 * 60 * 1000));
}

export type RevenueDelivered = {
  // Revenue (paise).
  grossSaleMinor: bigint; // pre-discount (currentTotal + discounts)
  discountsMinor: bigint;
  netPlacedRevenueMinor: bigint; // gross − discounts
  deliveredRevenueMinor: bigint; // Σ order revenue WHERE delivered
  cancelledRtoRevenueMinor: bigint; // netPlaced − delivered (derived plug)
  refundsMinor: bigint;
  netSaleMinor: bigint; // delivered − refunds
  // Counts.
  placedOrders: number;
  deliveredOrders: number;
  rtoOrders: number;
  inTransitOrders: number;
  unresolvedOrders: number;
  deliveredPairs: number; // Σ qty on delivered orders
  // Health (spec gates, as signals not hard blocks).
  resolvedOrders: number;
  resolutionRate: number; // resolved / placed
  deliveredShareOfPlaced: number; // deliveredRevenue / netPlaced
};

/**
 * Phase 2: revenue split + delivered counts for a month, on the delivered basis.
 * Reads only the OrderFinancials rows placed in the month window.
 */
export async function revenueAndDelivered(shop: string, month: string): Promise<RevenueDelivered> {
  const { start, end } = monthWindowIst(month);
  const orders = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end } },
    select: {
      grossRevenueMinor: true,
      refundsMinor: true,
      discountsMinor: true,
      deliveryStatus: true,
    },
  });

  let grossSaleMinor = 0n;
  let discountsMinor = 0n;
  let deliveredRevenueMinor = 0n;
  let refundsMinor = 0n;
  let deliveredOrders = 0;
  let rtoOrders = 0;
  let inTransitOrders = 0;
  let unresolvedOrders = 0;
  let resolvedOrders = 0;

  for (const o of orders) {
    // Shopify currentTotal is post-discount; gross_sale is pre-discount, so add
    // the discount back. Discounts stay a SEPARATE line (never netted into gross
    // — the spec's diagnostic rule).
    grossSaleMinor += o.grossRevenueMinor + o.discountsMinor;
    discountsMinor += o.discountsMinor;
    refundsMinor += o.refundsMinor;

    const oc = o.deliveryStatus;
    if (oc === "delivered") {
      deliveredOrders++;
      deliveredRevenueMinor += o.grossRevenueMinor; // net-of-discount order value
    } else if (oc === "rto" || oc === "rto_in_transit") {
      rtoOrders++;
    } else if (oc === "in_transit" || oc === "no-awb" || oc === "unknown") {
      inTransitOrders++;
    }
    if (oc === "unresolved") unresolvedOrders++;
    if (isResolvedOutcome(oc)) resolvedOrders++;
  }

  const placedOrders = orders.length;
  const netPlacedRevenueMinor = grossSaleMinor - discountsMinor;
  const cancelledRtoRevenueMinor = netPlacedRevenueMinor - deliveredRevenueMinor;
  const netSaleMinor = deliveredRevenueMinor - refundsMinor;

  return {
    grossSaleMinor,
    discountsMinor,
    netPlacedRevenueMinor,
    deliveredRevenueMinor,
    cancelledRtoRevenueMinor,
    refundsMinor,
    netSaleMinor,
    placedOrders,
    deliveredOrders,
    rtoOrders,
    inTransitOrders,
    unresolvedOrders,
    deliveredPairs: 0, // filled by deliveredCogs (needs line rows) — set in computeMonth
    resolvedOrders,
    resolutionRate: placedOrders ? resolvedOrders / placedOrders : 0,
    deliveredShareOfPlaced: netPlacedRevenueMinor > 0n ? Number(deliveredRevenueMinor) / Number(netPlacedRevenueMinor) : 0,
  };
}

export type DeliveredCogs = {
  cogsMinor: bigint | null; // null if match rate < threshold (spec: halt, don't impute)
  cogsComplete: boolean; // every delivered line had a cost-per-item
  deliveredPairs: number; // Σ qty on delivered orders
  matchRate: number; // lines with cost / delivered lines
  weightedAvgCostPerPairMinor: bigint | null; // Σ(cost×qty)/Σqty — the correct weighted figure
};

/**
 * Phase 3: COGS on DELIVERED units only (RTO/cancelled units returned to stock
 * carry zero COGS — the spec's single most important modelling choice). COGS is
 * Shopify cost-per-item × delivered qty, joined via the delivered orders' line
 * rows. If any delivered line lacks a cost, cogsComplete=false; if the match
 * rate falls below 98% (spec Gate 3), cogsMinor is null (do not impute a guess).
 */
export async function deliveredCogs(shop: string, month: string): Promise<DeliveredCogs> {
  const { start, end } = monthWindowIst(month);

  // The delivered orders in the window.
  const delivered = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: "delivered" },
    select: { orderId: true },
  });
  const deliveredIds = delivered.map((d) => d.orderId);
  if (!deliveredIds.length) {
    return { cogsMinor: 0n, cogsComplete: true, deliveredPairs: 0, matchRate: 1, weightedAvgCostPerPairMinor: null };
  }

  const lines = await prisma.orderLineFinancials.findMany({
    where: { shop, orderId: { in: deliveredIds } },
    select: { quantity: true, lineCogsMinor: true, lineCogsComplete: true },
  });

  let cogsMinor = 0n;
  let deliveredPairs = 0;
  let linesWithCost = 0;
  let costedQty = 0n;
  for (const l of lines) {
    deliveredPairs += l.quantity;
    if (l.lineCogsComplete && l.lineCogsMinor != null) {
      cogsMinor += l.lineCogsMinor;
      linesWithCost++;
      costedQty += BigInt(l.quantity);
    }
  }

  const matchRate = lines.length ? linesWithCost / lines.length : 1;
  const cogsComplete = linesWithCost === lines.length;
  const weightedAvgCostPerPairMinor = costedQty > 0n ? cogsMinor / costedQty : null;

  // Spec Gate 3: below a 98% match rate, do NOT impute across the gap — surface
  // COGS as unknown (null) so the assembly shows it PENDING rather than wrong.
  const MATCH_THRESHOLD = 0.98;
  return {
    cogsMinor: matchRate >= MATCH_THRESHOLD ? cogsMinor : null,
    cogsComplete,
    deliveredPairs,
    matchRate,
    weightedAvgCostPerPairMinor,
  };
}
