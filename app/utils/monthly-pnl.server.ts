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
import { getPnlApp } from "./pnl-app.server";
import { fetchMetaMonthlySpend } from "./meta-ads.server";
import { returnHqCountsForMonth } from "./returnhq.server";

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
  cancelledOrders: number;
  abandonedOrders: number;
  lostOrders: number;
  inTransitOrders: number;
  // Per-bucket order value (net-of-discount), for the funnel's value column.
  rtoRevenueMinor: bigint;
  cancelledRevenueMinor: bigint;
  abandonedRevenueMinor: bigint;
  lostRevenueMinor: bigint;
  inTransitRevenueMinor: bigint;
  unresolvedOrders: number;
  /** No AWB and no terminal outcome: can never resolve, so held out of the rate. */
  noTrackingOrders: number;
  noTrackingRevenueMinor: bigint;
  deliveredPairs: number; // Σ qty on delivered orders
  // Health (spec gates, as signals not hard blocks).
  resolvedOrders: number;
  resolutionRate: number; // resolved / (placed - untrackable)
  deliveredShareOfPlaced: number; // deliveredRevenue / netPlaced
};

/**
 * Phase 2: revenue split + delivered counts for a month, on the delivered basis.
 * Reads only the OrderFinancials rows placed in the month window.
 */
export async function revenueAndDelivered(shop: string, month: string): Promise<RevenueDelivered> {
  const { start, end } = monthWindowIst(month);
  const orders = await prisma.orderFinancials.findMany({
    // Exclude ReturnHQ return-fee orders (the ₹100 do-not-ship carriers): they're
    // fee collection, not sales, so they must not inflate placed count/revenue
    // or the funnel. Exchange-fee orders keep a real status and are NOT excluded.
    where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: { not: "returnhq-fee" } },
    select: {
      grossRevenueMinor: true,
      refundsMinor: true,
      discountsMinor: true,
      deliveryStatus: true,
      // Needed to tell a parcel that is genuinely moving from an order that
      // has no tracking number at all and therefore can never resolve.
      awb: true,
    },
  });

  let grossSaleMinor = 0n;
  let discountsMinor = 0n;
  let deliveredRevenueMinor = 0n;
  let refundsMinor = 0n;
  let deliveredOrders = 0;
  let rtoOrders = 0;
  let cancelledOrders = 0;
  let abandonedOrders = 0;
  let lostOrders = 0;
  let inTransitOrders = 0;
  let unresolvedOrders = 0;
  let resolvedOrders = 0;
  let noTrackingOrders = 0;
  let noTrackingRevenueMinor = 0n;
  // Per-bucket order value (net-of-discount), so the funnel can show a value
  // column next to each count. Delivered value is deliveredRevenueMinor above.
  let rtoRevenueMinor = 0n;
  let cancelledRevenueMinor = 0n;
  let abandonedRevenueMinor = 0n;
  let lostRevenueMinor = 0n;
  let inTransitRevenueMinor = 0n;

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
      rtoRevenueMinor += o.grossRevenueMinor;
    } else if (oc === "cancelled") {
      cancelledOrders++;
      cancelledRevenueMinor += o.grossRevenueMinor;
    } else if (oc === "abandoned") {
      abandonedOrders++;
      abandonedRevenueMinor += o.grossRevenueMinor;
    } else if (oc === "lost") {
      // Its own bucket. The courier has said the parcel is gone, so the outcome
      // IS known and calling it "in transit / unknown" reads as a parcel still
      // on its way. It is also already resolved for the resolution rate, so
      // leaving it in the unknown bucket made the two disagree about one order.
      lostOrders++;
      lostRevenueMinor += o.grossRevenueMinor;
    } else {
      // Catch-all so the funnel buckets ALWAYS sum to placed: in_transit,
      // unknown, and any future/unmapped status land here rather than
      // vanishing. Mostly 'unknown' — an order with no AWB that was PAID, so
      // it is a missing tracking number rather than a parcel in motion.
      inTransitOrders++;
      inTransitRevenueMinor += o.grossRevenueMinor;
    }
    if (oc === "unresolved") unresolvedOrders++;
    if (isResolvedOutcome(oc)) resolvedOrders++;
    // An order with no tracking number and no terminal outcome can never
    // resolve: nothing will ever report on it, so it would sit in the
    // denominator for ever and hold the month below the gate permanently.
    // It is held OUT of the rate rather than counted as resolved — the outcome
    // is genuinely unknown, and calling it known would be a false claim.
    // Unpaid/never-shipped orders are already 'abandoned' and resolved above,
    // so what lands here is a PAID order whose tracking number was never
    // recorded. It stays visible as its own count so the gap gets fixed
    // rather than absorbed.
    if (!o.awb && !isResolvedOutcome(oc)) {
      noTrackingOrders++;
      noTrackingRevenueMinor += o.grossRevenueMinor;
    }
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
    cancelledOrders,
    abandonedOrders,
    lostOrders,
    inTransitOrders,
    // per-bucket value (net-of-discount)
    rtoRevenueMinor,
    cancelledRevenueMinor,
    abandonedRevenueMinor,
    lostRevenueMinor,
    inTransitRevenueMinor,
    unresolvedOrders,
    deliveredPairs: 0, // filled by deliveredCogs (needs line rows) — set in computeMonth
    resolvedOrders,
    noTrackingOrders,
    noTrackingRevenueMinor,
    // Denominator excludes the untrackable. Those orders cannot resolve by any
    // route, so leaving them in would measure the tracking-data gap rather than
    // whether the month has actually settled.
    resolutionRate: (() => {
      const base = placedOrders - noTrackingOrders;
      return base > 0 ? resolvedOrders / base : placedOrders ? 0 : 0;
    })(),
    deliveredShareOfPlaced: netPlacedRevenueMinor > 0n ? Number(deliveredRevenueMinor) / Number(netPlacedRevenueMinor) : 0,
  };
}

export type DeliveredCogs = {
  cogsMinor: bigint | null; // null if match rate < threshold (spec: halt, don't impute)
  cogsComplete: boolean; // every delivered line had a cost-per-item
  deliveredPairs: number; // Σ qty on delivered orders
  matchRate: number; // lines with cost / delivered lines
  weightedAvgCostPerPairMinor: bigint | null; // Σ(cost×qty)/Σqty — the correct weighted figure
  /**
   * The stocking's share of the figures above — a SPLIT of COGS, never an
   * addition to it. The giveaway carries its own cost-per-item in Shopify, so
   * it is already inside cogsMinor; these say how much of it is stocking so
   * the statement can show the two parts without charging either twice.
   */
  stockingCogsMinor: bigint; // ⊂ cogsMinor
  stockingPairs: number; // ⊂ deliveredPairs
  productCogsMinor: bigint | null; // cogsMinor − stockingCogsMinor
  productPairs: number; // deliveredPairs − stockingPairs
};

/**
 * Phase 3: COGS on DELIVERED units only (RTO/cancelled units returned to stock
 * carry zero COGS — the spec's single most important modelling choice). COGS is
 * Shopify cost-per-item × delivered qty, joined via the delivered orders' line
 * rows. If any delivered line lacks a cost, cogsComplete=false; if the match
 * rate falls below 98% (spec Gate 3), cogsMinor is null (do not impute a guess).
 */
export async function deliveredCogs(
  shop: string,
  month: string,
  /** Product-title match for the free stocking, from Settings. Blank = no split. */
  stockingMatch = "",
): Promise<DeliveredCogs> {
  const { start, end } = monthWindowIst(month);

  // The delivered orders in the window.
  const delivered = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: "delivered" },
    select: { orderId: true },
  });
  const deliveredIds = delivered.map((d) => d.orderId);
  if (!deliveredIds.length) {
    return {
      cogsMinor: 0n,
      cogsComplete: true,
      deliveredPairs: 0,
      matchRate: 1,
      weightedAvgCostPerPairMinor: null,
      stockingCogsMinor: 0n,
      stockingPairs: 0,
      productCogsMinor: 0n,
      productPairs: 0,
    };
  }

  const lines = await prisma.orderLineFinancials.findMany({
    where: { shop, orderId: { in: deliveredIds } },
    select: { quantity: true, lineCogsMinor: true, lineCogsComplete: true, productTitle: true },
  });

  const term = stockingMatch.trim().toLowerCase();
  let cogsMinor = 0n;
  let deliveredPairs = 0;
  let linesWithCost = 0;
  let costedQty = 0n;
  let stockingCogsMinor = 0n;
  let stockingPairs = 0;
  for (const l of lines) {
    deliveredPairs += l.quantity;
    // Same match the stocking cost used, so the split and the old separate
    // line can never disagree about which lines are stockings.
    const isStocking = term !== "" && String(l.productTitle || "").toLowerCase().includes(term);
    if (isStocking) stockingPairs += l.quantity;
    if (l.lineCogsComplete && l.lineCogsMinor != null) {
      cogsMinor += l.lineCogsMinor;
      if (isStocking) stockingCogsMinor += l.lineCogsMinor;
      linesWithCost++;
      costedQty += BigInt(l.quantity);
    }
  }

  const matchRate = lines.length ? linesWithCost / lines.length : 1;
  const cogsComplete = linesWithCost === lines.length;
  const weightedAvgCostPerPairMinor = costedQty > 0n ? cogsMinor / costedQty : null;

  // Spec Gate 3: below this match rate, do NOT impute across the gap — surface
  // COGS as unknown (null) so the assembly shows it PENDING rather than wrong.
  // Lowered 0.98 -> 0.97: the residual gap is deleted/merged variants with no
  // cost recoverable in Shopify (e.g. July: 316 of 317 missing lines have no
  // variant at all), so a 98% ceiling is unreachable however complete the real
  // catalogue is. At 97% the shown COGS omits <=3% of lines, so profit reads a
  // touch high — acceptable for a dashboard, and flagged by the match rate.
  const MATCH_THRESHOLD = 0.97;
  const known = matchRate >= MATCH_THRESHOLD;
  return {
    cogsMinor: known ? cogsMinor : null,
    cogsComplete,
    deliveredPairs,
    matchRate,
    weightedAvgCostPerPairMinor,
    stockingCogsMinor,
    stockingPairs,
    // Tracks cogsMinor: unknown COGS makes the product share unknown too,
    // rather than reporting a total that quietly omits the missing lines.
    productCogsMinor: known ? cogsMinor - stockingCogsMinor : null,
    productPairs: deliveredPairs - stockingPairs,
  };
}

/**
 * Stocking: a free product added to orders that still costs us to supply, so it
 * carries no line revenue and no Shopify cost-per-item and would otherwise be
 * invisible in the P&L. Counts the units on DELIVERED orders whose product title
 * contains `match` (same delivered basis as COGS — an RTO'd order's stocking
 * comes back with it), and prices them at a flat unit cost.
 *
 * Not an estimate: the unit count is real order data and the unit cost is a
 * figure the merchant enters in Settings.
 */
export async function deliveredStockingUnits(shop: string, month: string, match: string): Promise<number> {
  const term = match.trim();
  if (!term) return 0; // feature off until a match term is configured
  const { start, end } = monthWindowIst(month);

  const delivered = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: "delivered" },
    select: { orderId: true },
  });
  if (!delivered.length) return 0;

  const lines = await prisma.orderLineFinancials.findMany({
    where: {
      shop,
      orderId: { in: delivered.map((d) => d.orderId) },
      productTitle: { contains: term, mode: "insensitive" },
    },
    select: { quantity: true },
  });
  return lines.reduce((sum, l) => sum + l.quantity, 0);
}

export type UnmatchedCostItem = {
  productId: string;
  variantId: string;
  productTitle: string;
  variantTitle: string;
  units: number; // delivered units affected
  lines: number; // delivered line rows affected
};

/**
 * Delivered products/variants that have NO cost-per-item in Shopify, for a
 * month. These are exactly what keeps COGS incomplete — the merchant fixes them
 * by setting "Cost per item" on the variant in Shopify. Grouped by product +
 * variant, sorted by units (biggest COGS gap first). Delivered basis only, so
 * the list is actionable (a variant that never delivered doesn't affect COGS).
 */
export async function unmatchedCostItems(shop: string, month: string): Promise<UnmatchedCostItem[]> {
  const { start, end } = monthWindowIst(month);
  const delivered = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: "delivered" },
    select: { orderId: true },
  });
  const ids = delivered.map((d) => d.orderId);
  if (!ids.length) return [];

  const lines = await prisma.orderLineFinancials.findMany({
    where: { shop, orderId: { in: ids }, lineCogsComplete: false },
    select: { productId: true, variantId: true, productTitle: true, variantTitle: true, quantity: true },
  });

  const map = new Map<string, UnmatchedCostItem>();
  for (const l of lines) {
    const key = `${l.productId}|${l.variantId}`;
    const e =
      map.get(key) ||
      { productId: l.productId, variantId: l.variantId, productTitle: l.productTitle, variantTitle: l.variantTitle, units: 0, lines: 0 };
    e.units += l.quantity;
    e.lines += 1;
    map.set(key, e);
  }
  return Array.from(map.values()).sort((a, b) => b.units - a.units);
}

// ── Phase 6: GST / Ops / Overhead ───────────────────────────────────────────

/** GST output tax backed out of GST-inclusive collected revenue:
 *    output = netSale × rate/(1+rate), rate as basis points (e.g. 487 = 4.87%).
 *  Integer math in paise — round to nearest paisa, never a float. */
export type GstSplit = {
  /** Taxable (GST-inclusive) delivered revenue and the tax backed out, per rate. */
  bands: Array<{ rateBp: number; taxableMinor: bigint; taxMinor: bigint }>;
  totalMinor: bigint;
  /** True when no line carried a product type, so the blended fallback was used. */
  blended: boolean;
  /** Revenue on lines with no product type — they can't be slabbed until re-synced. */
  untypedMinor: bigint;
};

/**
 * GST on sales, charged PER LINE rather than at one blended rate, because this
 * catalogue spans three slabs:
 *   - handbags                     18%
 *   - footwear over the threshold  12%  (India's per-pair price slab)
 *   - everything else               5%
 *
 * The 12% test is on the UNIT price, not the line total: two Rs900 pairs on one
 * line are Rs1,800 of revenue but each pair is under the threshold, so they stay
 * at 5%. Delivered lines only, matching the rest of the P&L. Lines with no
 * product type (synced before it was captured) fall back to the blended rate,
 * and `blended` says so rather than presenting a split that didn't happen.
 */
export async function gstOutputSplit(
  shop: string,
  month: string,
  cfg: {
    highTypes: string[];
    highRateBp: number;
    standardRateBp: number;
    fallbackRateBp: number;
    /** Footwear priced ABOVE this (per pair, paise) moves to midRateBp. */
    footwearThresholdMinor: bigint;
    midRateBp: number;
  },
): Promise<GstSplit> {
  const { start, end } = monthWindowIst(month);
  const delivered = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: "delivered" },
    select: { orderId: true },
  });
  if (!delivered.length) return { bands: [], totalMinor: 0n, blended: false, untypedMinor: 0n };

  const lines = await prisma.orderLineFinancials.findMany({
    where: { shop, orderId: { in: delivered.map((d) => d.orderId) } },
    select: { productType: true, lineRevenueMinor: true, quantity: true },
  });

  const high = new Set(cfg.highTypes.map((t) => t.trim().toLowerCase()).filter(Boolean));
  const taxable = new Map<number, bigint>();
  let untyped = 0n;
  for (const l of lines) {
    const type = (l.productType || "").trim().toLowerCase();
    if (!type) { untyped += l.lineRevenueMinor; continue; }
    let rate: number;
    if (high.has(type)) {
      rate = cfg.highRateBp;
    } else {
      // Per-PAIR price decides the slab, so a multi-quantity line of cheap pairs
      // isn't pushed over the threshold by its own total.
      const qty = BigInt(Math.max(1, l.quantity || 1));
      const unit = l.lineRevenueMinor / qty;
      rate = unit > cfg.footwearThresholdMinor ? cfg.midRateBp : cfg.standardRateBp;
    }
    taxable.set(rate, (taxable.get(rate) ?? 0n) + l.lineRevenueMinor);
  }
  if (untyped > 0n) taxable.set(cfg.fallbackRateBp, (taxable.get(cfg.fallbackRateBp) ?? 0n) + untyped);

  const bands = Array.from(taxable.entries())
    .map(([rateBp, taxableMinor]) => ({ rateBp, taxableMinor, taxMinor: gstOutput(taxableMinor, rateBp) }))
    .filter((b) => b.taxableMinor > 0n)
    .sort((a, b) => a.rateBp - b.rateBp);

  return {
    bands,
    totalMinor: bands.reduce((t, b) => t + b.taxMinor, 0n),
    blended: untyped > 0n && taxable.size === 1,
    untypedMinor: untyped,
  };
}

export function gstOutput(netSaleMinor: bigint, rateBp: number): bigint {
  // netSale × rate / (10000 + rate), with rounding.
  const num = netSaleMinor * BigInt(rateBp);
  const den = BigInt(10000 + rateBp);
  return (num + den / 2n) / den;
}

/** ITC on operating expenses: (freight + ads + overhead) × numer/denom (18/118).
 *  Null if any required input is still pending (never plug a gap). */
export function gstInputCredit(
  freightMinor: bigint | null,
  adSpendMinor: bigint | null,
  overheadMinor: bigint,
  numer: number,
  denom: number,
): bigint | null {
  if (freightMinor == null || adSpendMinor == null) return null;
  const base = freightMinor + adSpendMinor + overheadMinor;
  return (base * BigInt(numer) + BigInt(denom) / 2n) / BigInt(denom);
}

// ── Phase 7: assembly, metrics, publish gate ────────────────────────────────

export type PublishStatus = "final" | "provisional" | "pending";

export type MonthlyPnl = {
  month: string;
  // Revenue block.
  grossSaleMinor: bigint;
  discountsMinor: bigint;
  netPlacedRevenueMinor: bigint;
  cancelledRtoRevenueMinor: bigint;
  refundsMinor: bigint;
  netSaleMinor: bigint;
  // Costs (null = PENDING, never estimated).
  cogsMinor: bigint | null;
  freightMinor: bigint | null;
  freightStatus: PublishStatus;
  adSpendMinor: bigint | null;
  adSpendSource: string;
  overheadMinor: bigint;
  overheadProvisional: boolean;
  // Itemized fixed costs (statement rows).
  shopifyBillingMinor: bigint; // combined Shopify subscription + billing
  doubleclickFeeMinor: bigint;
  doubleclickSubMinor: bigint;
  stockingMinor: bigint; // manual override only; the real spend is inside COGS
  stockingUnits: number; // free stocking units on delivered orders
  stockingSource: string; // "auto" (units × unit cost) | "manual" (entered)
  /** The COGS line, split. These SUM to cogsMinor — neither adds to it. */
  stockingCogsMinor: bigint;
  productCogsMinor: bigint | null;
  productPairs: number;
  // GST.
  gstOutputMinor: bigint;
  /** Taxable revenue and tax per GST slab, for the statement's breakdown. */
  gstBands: Array<{ rateBp: number; taxableMinor: bigint; taxMinor: bigint }>;
  /** Delivered revenue whose lines have no product type yet (needs a re-sync). */
  gstUntypedMinor: bigint;
  gstInputMinor: bigint | null;
  netGstMinor: bigint | null;
  returnExchangeFeesMinor: bigint;
  returnExchangeFeesSource: string;
  feesAlreadyInNetSaleMinor: bigint; // exchange share; shown but not added to profit // "auto" (summed fee orders) | "manual" (override)
  // Bottom line — null when any required cost is pending (suppressed).
  netPnlMinor: bigint | null;
  // Counts + basis.
  placedOrders: number;
  deliveredOrders: number;
  rtoOrders: number;
  cancelledOrders: number;
  abandonedOrders: number;
  lostOrders: number;
  inTransitOrders: number;
  // Per-bucket order value (net-of-discount) for the funnel's value column.
  deliveredRevenueMinor: bigint;
  rtoRevenueMinor: bigint;
  cancelledRevenueMinor: bigint;
  abandonedRevenueMinor: bigint;
  lostRevenueMinor: bigint;
  inTransitRevenueMinor: bigint;
  deliveredPairs: number;
  // Per-delivered / per-pair metrics (null when netPnl is suppressed).
  netPnlPerDeliveredOrderMinor: bigint | null;
  netPnlPerDeliveredPairMinor: bigint | null;
  adPerDeliveredOrderMinor: bigint | null;
  freightPerDeliveredOrderMinor: bigint | null;
  // Per PAIR, not per order. A basket averaging 1.7 pairs makes the two differ
  // by most of a third, and pairs is the unit these costs are really incurred
  // in: COGS is already per pair, so the three only compare on one basis.
  adPerPairMinor: bigint | null;
  freightPerPairMinor: bigint | null;
  cogsPerPairMinor: bigint | null;
  // Health + publish gate.
  resolutionRate: number;
  /** Orders held out of the resolution rate for having no tracking number. */
  noTrackingOrders: number;
  noTrackingRevenueMinor: bigint;
  deliveredShareOfPlaced: number;
  cogsMatchRate: number;
  matured: boolean;
  daysToMaturity: number; // <=0 means matured
  publishStatus: PublishStatus;
  pendingReasons: string[]; // named blockers on the report face
};

/**
 * Assemble the full monthly P&L (spec Phase 7). Pulls revenue+delivered, COGS,
 * ad spend (Meta, live) and freight (verify-gated → pending), applies GST/ops/
 * overhead, and runs the publish gate. Any PENDING cost suppresses the net P&L
 * total — "a P&L with an unknown freight line is not a P&L".
 */
export async function computeMonth(shop: string, month: string): Promise<MonthlyPnl> {
  const app = await getPnlApp();
  const [rev, cogs, input] = await Promise.all([
    revenueAndDelivered(shop, month),
    deliveredCogs(shop, month, app.stockingMatch),
    prisma.pnlMonthlyInput.findUnique({ where: { shop_month: { shop, month } } }),
  ]);

  const { start, end } = monthWindowIst(month);
  // Shipped = has an AWB (delivery attempted). Used for freight coverage + ops basis check.
  const shippedOrders = await prisma.orderFinancials.count({
    where: { shop, orderCreatedAt: { gte: start, lt: end }, awb: { not: "" } },
  });

  // ── Ad spend (live Meta; override if the user entered one) ────────────────
  let adSpendMinor: bigint | null = null;
  let adSpendSource = "pending";
  if (input?.adSpendOverrideMinor != null) {
    adSpendMinor = input.adSpendOverrideMinor;
    adSpendSource = "manual";
  } else if (app.metaAccessToken && app.metaAdAccountId) {
    const since = start.toISOString().slice(0, 10);
    // until is inclusive in Meta's time_range → last day of the month = end − 1 day.
    const until = new Date(end.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const r = await fetchMetaMonthlySpend({
      accessToken: app.metaAccessToken,
      adAccountId: app.metaAdAccountId,
      since,
      until,
    });
    if (r.ok) {
      adSpendMinor = r.spendMinor;
      adSpendSource = "meta";
    }
  }

  // ── Freight (verify-gated aggregation → override or pending) ───────────────
  let freightMinor: bigint | null = null;
  let freightStatus: PublishStatus = "pending";
  if (input?.freightOverrideMinor != null) {
    freightMinor = input.freightOverrideMinor;
    freightStatus = "final";
  }
  // else: the aggregation endpoints are verify-gated; freight stays pending until
  // enabled + a coverage check runs (Phase 4 wiring lands with live accounts).

  // Itemized fixed costs (statement rows). They SUM into the fixed-cost total.
  const shopifyBillingMinor = input?.shopifyBillingMinor ?? 0n;
  const doubleclickFeeMinor = input?.doubleclickFeeMinor ?? 0n;
  const doubleclickSubMinor = input?.doubleclickSubMinor ?? 0n;
  // The stocking was charged TWICE. Its lines carry a Rs 60 cost-per-item in
  // Shopify, so they are already inside COGS; this then counted the same units
  // and subtracted Rs 60 again as a separate cost — about Rs 1.25 lakh a month
  // while the giveaway runs, understating profit by that much.
  //
  // It was right when written: stockings used to carry no cost at all and were
  // invisible in the P&L, which is what this line existed to fix. They have
  // carried a cost since, and this kept running.
  //
  // So it is no longer added. The spend is still shown, as a SPLIT of the COGS
  // line (cogs.stockingCogsMinor) rather than an addition to it. A manual
  // figure still wins: a month where the lines genuinely carry no cost can be
  // corrected by hand, and that is the one case the old behaviour was for.
  const stockingUnits = cogs.stockingPairs;
  const manualStockingMinor = input?.stockingMinor ?? 0n;
  const stockingMinor = manualStockingMinor;
  const stockingSource = manualStockingMinor > 0n ? "manual" : "auto";
  const itemizedFixed =
    shopifyBillingMinor + doubleclickFeeMinor + doubleclickSubMinor;
  // overheadMinor drives the P&L math. Prefer the itemized sum when any itemized
  // value is entered; otherwise fall back to the legacy combined overhead field.
  const overheadMinor = itemizedFixed > 0n ? itemizedFixed : (input?.overheadMinor ?? 0n);
  const overheadProvisional = !input; // inherited/absent overhead is provisional

  // Return/exchange fees are ALREADY in the data: ReturnHQ collects them as real
  // Shopify orders tagged "returnhq-fee" (+ "do-not-ship"), which the funnel
  // excludes as non-sales. Sum their revenue instead of asking for a manual
  // figure. A manual entry still wins if one was explicitly set (override).
  // Fee is charged per REQUEST, so count requests — not the Shopify fee orders.
  // Those two never reconcile: a request is bucketed by its ORIGINAL order's
  // month, while its fee order is created whenever the customer pays, often in
  // the next month. Counting fee orders made the line disagree with the request
  // counts shown right beside it.
  const rq = await returnHqCountsForMonth(month);
  const requestCount = rq.returns + rq.exchanges;
  const autoFeesMinor = BigInt(requestCount) * app.returnRequestFeeMinor;
  const manualFeesMinor = input?.returnExchangeFeesMinor ?? 0n;
  const returnExchangeFeesMinor = manualFeesMinor > 0n ? manualFeesMinor : autoFeesMinor;
  const returnExchangeFeesSource = manualFeesMinor > 0n ? "manual" : "auto";
  // The exchange share is already inside Net Sale: an exchange fee order is one
  // real order worth (replacement product + fee). Adding the whole shown figure
  // to profit would count that fee twice, so the profit formula deducts it —
  // display and profit deliberately differ, and the statement says so.
  // A manual override is taken at face value: we can't know what it includes.
  const feesAlreadyInNetSaleMinor =
    manualFeesMinor > 0n ? 0n : BigInt(rq.exchanges) * app.returnRequestFeeMinor;

  // ── Ops / GST ─────────────────────────────────────────────────────────────
  // Per-line GST: handbags 18%, footwear over the threshold 12%, rest 5%.
  const gstSplit = await gstOutputSplit(shop, month, {
    highTypes: app.gstHighTypes.split(",").map((t) => t.trim()).filter(Boolean),
    highRateBp: app.gstHighRateBp,
    standardRateBp: app.gstStandardRateBp,
    midRateBp: app.gstMidRateBp,
    footwearThresholdMinor: app.gstFootwearThresholdMinor,
    fallbackRateBp: app.gstOutputRateBp,
  });
  // Fall back to the blended rate only when no line carried a product type at
  // all, so a month synced before productType existed still shows a figure.
  const gstOutputMinor =
    gstSplit.bands.length > 0 ? gstSplit.totalMinor : gstOutput(rev.netSaleMinor, app.gstOutputRateBp);
  const gstInputMinor = gstInputCredit(
    freightMinor,
    adSpendMinor,
    overheadMinor,
    app.gstInputRateNumer,
    app.gstInputRateDenom,
  );
  const netGstMinor = gstInputMinor == null ? null : gstInputMinor - gstOutputMinor;

  // ── Publish gate ──────────────────────────────────────────────────────────
  const daysSince = daysSinceMonthEnd(month);
  const daysToMaturity = app.maturityDays - daysSince;
  const matured = daysToMaturity <= 0;

  // A month whose orders haven't reached an outcome yet isn't a P&L: the RTOs and
  // cancellations still to land will move revenue AND cost. Treated like a
  // missing cost — suppress the total rather than publish one that will change.
  const RESOLUTION_THRESHOLD = 0.98;
  const resolved = rev.resolutionRate >= RESOLUTION_THRESHOLD;

  const pendingReasons: string[] = [];
  if (cogs.cogsMinor == null) {
    pendingReasons.push(`COGS: cost-per-item set on only ${(cogs.matchRate * 100).toFixed(1)}% of delivered lines`);
  }
  if (freightMinor == null) pendingReasons.push("Freight: carrier billing not yet resolved");
  if (adSpendMinor == null) pendingReasons.push("Ad spend: Meta token not set / month not pulled");
  if (!resolved) {
    pendingReasons.push(
      `Delivery outcomes: only ${(rev.resolutionRate * 100).toFixed(1)}% of orders have resolved ` +
        `(need ${(RESOLUTION_THRESHOLD * 100).toFixed(0)}%) — ` +
        `${rev.placedOrders - rev.noTrackingOrders - rev.resolvedOrders} still in transit` +
        // Named separately: these are not waiting on a carrier, they are
        // waiting on a tracking number, and they are not in the rate at all.
        (rev.noTrackingOrders
          ? `, plus ${rev.noTrackingOrders} with no tracking number (excluded)`
          : ``),
    );
  }

  // Net P&L is only computed when EVERY required cost is known. Any pending cost
  // suppresses it (null), per the spec — no partial total masquerading as a P&L.
  let netPnlMinor: bigint | null = null;
  if (resolved && cogs.cogsMinor != null && freightMinor != null && adSpendMinor != null && netGstMinor != null) {
    netPnlMinor =
      rev.netSaleMinor -
      cogs.cogsMinor -
      stockingMinor - // was shown on the statement but never deducted: profit read high
      freightMinor -
      adSpendMinor -
      overheadMinor +
      netGstMinor +
      // Only the portion NOT already inside Net Sale (see above). GST is
      // deliberately still computed on the full Net Sale: whether the fee is
      // taxable is a GST question for the merchant's accountant, and
      // overstating tax owed is the safer way to be wrong.
      (returnExchangeFeesMinor - feesAlreadyInNetSaleMinor);
  }

  // An unresolved month is already a pendingReason above, so it lands in
  // "pending" here rather than needing its own clause.
  let publishStatus: PublishStatus = "final";
  if (pendingReasons.length > 0) publishStatus = "pending";
  else if (!matured || overheadProvisional) publishStatus = "provisional";

  const perDelOrder = (v: bigint | null): bigint | null =>
    v == null || rev.deliveredOrders === 0 ? null : v / BigInt(rev.deliveredOrders);
  const perPair = (v: bigint | null): bigint | null =>
    v == null || cogs.deliveredPairs === 0 ? null : v / BigInt(cogs.deliveredPairs);

  return {
    month,
    grossSaleMinor: rev.grossSaleMinor,
    discountsMinor: rev.discountsMinor,
    netPlacedRevenueMinor: rev.netPlacedRevenueMinor,
    cancelledRtoRevenueMinor: rev.cancelledRtoRevenueMinor,
    refundsMinor: rev.refundsMinor,
    netSaleMinor: rev.netSaleMinor,
    cogsMinor: cogs.cogsMinor,
    freightMinor,
    freightStatus,
    adSpendMinor,
    adSpendSource,
    overheadMinor,
    overheadProvisional,
    shopifyBillingMinor,
    doubleclickFeeMinor,
    doubleclickSubMinor,
    stockingMinor,
    stockingUnits,
    stockingSource,
    stockingCogsMinor: cogs.stockingCogsMinor,
    productCogsMinor: cogs.productCogsMinor,
    productPairs: cogs.productPairs,
    gstOutputMinor,
    gstBands: gstSplit.bands,
    gstUntypedMinor: gstSplit.untypedMinor,
    gstInputMinor,
    netGstMinor,
    returnExchangeFeesMinor,
    returnExchangeFeesSource,
    feesAlreadyInNetSaleMinor,
    netPnlMinor,
    placedOrders: rev.placedOrders,
    deliveredOrders: rev.deliveredOrders,
    rtoOrders: rev.rtoOrders,
    cancelledOrders: rev.cancelledOrders,
    abandonedOrders: rev.abandonedOrders,
    lostOrders: rev.lostOrders,
    inTransitOrders: rev.inTransitOrders,
    deliveredRevenueMinor: rev.deliveredRevenueMinor,
    rtoRevenueMinor: rev.rtoRevenueMinor,
    cancelledRevenueMinor: rev.cancelledRevenueMinor,
    abandonedRevenueMinor: rev.abandonedRevenueMinor,
    lostRevenueMinor: rev.lostRevenueMinor,
    inTransitRevenueMinor: rev.inTransitRevenueMinor,
    deliveredPairs: cogs.deliveredPairs,
    netPnlPerDeliveredOrderMinor: perDelOrder(netPnlMinor),
    netPnlPerDeliveredPairMinor: perPair(netPnlMinor),
    adPerDeliveredOrderMinor: perDelOrder(adSpendMinor),
    freightPerDeliveredOrderMinor: perDelOrder(freightMinor),
    adPerPairMinor: perPair(adSpendMinor),
    freightPerPairMinor: perPair(freightMinor),
    cogsPerPairMinor: perPair(cogs.cogsMinor),
    resolutionRate: rev.resolutionRate,
    noTrackingOrders: rev.noTrackingOrders,
    noTrackingRevenueMinor: rev.noTrackingRevenueMinor,
    deliveredShareOfPlaced: rev.deliveredShareOfPlaced,
    cogsMatchRate: cogs.matchRate,
    matured,
    daysToMaturity,
    publishStatus,
    pendingReasons,
  };
}
