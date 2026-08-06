/**
 * The P&L sync layer — the only place external APIs are touched. The dashboard
 * reads the Postgres cache; this fills it.
 *
 *   syncRevenueAndCogs — paginate Shopify orders in a date window, upsert
 *     OrderFinancials + OrderLineFinancials. Revenue/refunds/COGS come from
 *     Shopify; shipping is left "pending" for the backfill.
 *   backfillShipping — find pending rows that have an AWB and fill the ACTUAL
 *     billed freight from the carrier (or leave pending). This is how a cost
 *     that bills days after the order gets picked up automatically.
 *
 * No estimates: a cost that isn't known stays null. Money is bigint paise.
 */
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import {
  fetchOrdersPage,
  computeOrderFinancials,
  type AdminGraphql,
  type OrderFinancialsComputed,
} from "./pnl.server";
import { resolveBilling } from "./carrier-billing.server";
import { trackParcel, type TrackingResult } from "./tracking.server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** dataComplete = COGS fully known AND shipping resolved to a real billed cost. */
function isDataComplete(cogsComplete: boolean, shippingStatus: string): boolean {
  return cogsComplete && shippingStatus === "billed";
}

/**
 * Sync revenue + COGS for orders created in [since, until]. Upserts one
 * OrderFinancials row per order and replaces its OrderLineFinancials. Shipping
 * is initialised to "pending" (or "no-awb" when there's no tracking number yet)
 * and filled later by backfillShipping.
 *
 * CHUNKABLE + TIME-BUDGETED. A store doing ~2000 orders/week can't sync in one
 * serverless invocation, and hammering it also runs up Neon compute hours. So:
 *   - pass `startCursor` to resume where a previous run stopped (null = start),
 *   - the run stops early when it nears `timeBudgetMs` and returns `nextCursor`
 *     + `done:false` so the caller can persist the cursor and resume next time,
 *   - writes are BATCHED per page (a handful of round-trips per 50 orders,
 *     not ~4 per order), which is the main lever on Neon active time.
 *
 * Paces on Shopify's cost throttle so a big window never 429s.
 */
export async function syncRevenueAndCogs(
  admin: AdminGraphql,
  shop: string,
  opts: {
    since: Date;
    until: Date;
    maxPages?: number;
    startCursor?: string | null;
    timeBudgetMs?: number;
  },
): Promise<{ orders: number; pages: number; nextCursor: string | null; done: boolean }> {
  const createdAtMin = opts.since.toISOString();
  const createdAtMax = opts.until.toISOString();
  const maxPages = opts.maxPages ?? 40;
  const timeBudgetMs = opts.timeBudgetMs ?? Infinity;
  const startedAt = Date.now();

  let cursor: string | null = opts.startCursor ?? null;
  let pages = 0;
  let orders = 0;

  while (pages < maxPages) {
    const { nodes, nextCursor, throttle } = await fetchOrdersPage(admin, {
      createdAtMin,
      createdAtMax,
      cursor,
    });
    pages++;

    // Batch-write the whole page (see writeOrderPage) rather than per order.
    await writeOrderPage(shop, nodes.map(computeOrderFinancials));
    orders += nodes.length;

    if (!nextCursor) {
      return { orders, pages, nextCursor: null, done: true };
    }
    cursor = nextCursor;

    // Stop early if we're near the time budget — persist `cursor` and resume.
    if (Date.now() - startedAt >= timeBudgetMs) {
      return { orders, pages, nextCursor: cursor, done: false };
    }

    // Pace on the GraphQL cost budget: if we're low, wait for it to refill
    // (~50 points/sec on standard). Cheap insurance against 429s on big windows.
    if (throttle && throttle.currentlyAvailable < 200) {
      await sleep(2000);
    }
  }

  // Hit the page cap with more to go.
  return { orders, pages, nextCursor: cursor, done: false };
}

/**
 * Write a whole page of orders (~50) in a FEW round-trips, not ~4 per order.
 * This is the main lever on Neon compute hours and on the request staying under
 * the serverless timeout.
 *
 * The naive `prisma.$transaction([...upserts])` looks batched but is NOT: Prisma
 * runs each upsert as its own SELECT-then-write, serially, so 50 upserts = ~100
 * sequential round-trips to Neon (measured at ~13s from a warm connection). So
 * instead the whole page is written with:
 *   - ONE parameterised `INSERT ... ON CONFLICT DO UPDATE` for OrderFinancials
 *     (preserving an already-backfilled shipping cost/status via COALESCE),
 *   - ONE bulk `deleteMany` + ONE `createMany` for the line rows.
 * That's ~3 round-trips per page regardless of order count.
 */
async function writeOrderPage(shop: string, computed: OrderFinancialsComputed[]): Promise<void> {
  if (!computed.length) return;
  const now = new Date();

  // One statement: bulk upsert. On conflict we keep any shipping cost/status the
  // backfill already set (COALESCE on the existing row), and recompute
  // dataComplete from the merged shipping status in SQL.
  const rows = computed.map((c) => {
    const initialShippingStatus = c.awb ? "pending" : "no-awb";
    return Prisma.sql`(
      ${randomUUID()}, ${shop}, ${c.orderId}, ${c.orderName}, ${c.orderCreatedAt}, ${c.currency},
      ${c.grossRevenueMinor}, ${c.refundsMinor}, ${c.discountsMinor},
      ${c.cogsMinor}, ${c.cogsComplete},
      ${initialShippingStatus}, ${c.awb}, ${c.carrier},
      ${c.financialStatus}, ${c.fulfillmentStatus},
      ${c.cogsComplete}, ${now}, ${now}, ${now}
    )`;
  });

  // NOTE: column order below must match the VALUES tuples above.
  await prisma.$executeRaw`
    INSERT INTO "OrderFinancials" (
      "id", "shop", "orderId", "orderName", "orderCreatedAt", "currency",
      "grossRevenueMinor", "refundsMinor", "discountsMinor",
      "cogsMinor", "cogsComplete",
      "shippingStatus", "awb", "carrier",
      "financialStatus", "fulfillmentStatus",
      "dataComplete", "revenueSyncedAt", "cogsSyncedAt", "updatedAt"
    )
    VALUES ${Prisma.join(rows)}
    ON CONFLICT ("shop", "orderId") DO UPDATE SET
      "orderName"         = EXCLUDED."orderName",
      "orderCreatedAt"    = EXCLUDED."orderCreatedAt",
      "currency"          = EXCLUDED."currency",
      "grossRevenueMinor" = EXCLUDED."grossRevenueMinor",
      "refundsMinor"      = EXCLUDED."refundsMinor",
      "discountsMinor"    = EXCLUDED."discountsMinor",
      "cogsMinor"         = EXCLUDED."cogsMinor",
      "cogsComplete"      = EXCLUDED."cogsComplete",
      -- Preserve a shipping cost/status the backfill already resolved.
      "shippingStatus"    = CASE WHEN "OrderFinancials"."shippingCostMinor" IS NOT NULL
                                 THEN "OrderFinancials"."shippingStatus"
                                 ELSE EXCLUDED."shippingStatus" END,
      "awb"               = EXCLUDED."awb",
      "carrier"           = EXCLUDED."carrier",
      "financialStatus"   = EXCLUDED."financialStatus",
      "fulfillmentStatus" = EXCLUDED."fulfillmentStatus",
      "dataComplete"      = (EXCLUDED."cogsComplete" AND
                             CASE WHEN "OrderFinancials"."shippingCostMinor" IS NOT NULL
                                  THEN "OrderFinancials"."shippingStatus"
                                  ELSE EXCLUDED."shippingStatus" END = 'billed'),
      "revenueSyncedAt"   = EXCLUDED."revenueSyncedAt",
      "cogsSyncedAt"      = EXCLUDED."cogsSyncedAt",
      "updatedAt"         = EXCLUDED."updatedAt"
  `;

  // Replace line rows for the whole page in two bulk statements.
  const orderIds = computed.map((c) => c.orderId);
  await prisma.orderLineFinancials.deleteMany({ where: { shop, orderId: { in: orderIds } } });
  const lineData = computed.flatMap((c) =>
    c.lines.map((l) => ({
      shop,
      orderId: c.orderId,
      orderCreatedAt: c.orderCreatedAt,
      productId: l.productId,
      variantId: l.variantId,
      productTitle: l.productTitle,
      variantTitle: l.variantTitle,
      quantity: l.quantity,
      lineRevenueMinor: l.lineRevenueMinor,
      lineCogsMinor: l.lineCogsMinor,
      lineCogsComplete: l.lineCogsComplete,
    })),
  );
  if (lineData.length) {
    await prisma.orderLineFinancials.createMany({ data: lineData });
  }
}

/**
 * Fill actual billed shipping for pending orders that have an AWB. Bounded by
 * `limit` so a "Sync now" click stays under the function timeout; the cron runs
 * it unbounded across the backlog. Reuses carrier creds already stored for
 * tracking. Never writes an estimate — a not-yet-billed shipment stays pending.
 */
export async function backfillShipping(
  shop: string,
  opts: {
    limit?: number;
    // Standalone P&L app passes its own carrier creds (from PnlApp); the
    // embedded app leaves these undefined and we read the AiReplySettings /
    // DeliverySettings rows as before.
    carrier?: {
      shiprocketEmail?: string;
      shiprocketPassword?: string;
      delhiveryApiKey?: string;
    };
  } = {},
): Promise<{ checked: number; billed: number; stillPending: number }> {
  const limit = opts.limit ?? 40;

  let creds = opts.carrier;
  if (!creds) {
    const [ai, delivery] = await Promise.all([
      prisma.aiReplySettings.findUnique({
        where: { shop },
        select: { waShiprocketEmail: true, waShiprocketPassword: true },
      }),
      prisma.deliverySettings.findUnique({ where: { shop }, select: { apiToken: true } }),
    ]);
    creds = {
      shiprocketEmail: ai?.waShiprocketEmail,
      shiprocketPassword: ai?.waShiprocketPassword,
      delhiveryApiKey: delivery?.apiToken,
    };
  }

  const pending = await prisma.orderFinancials.findMany({
    where: { shop, shippingStatus: "pending", awb: { not: "" } },
    orderBy: { orderCreatedAt: "asc" },
    take: limit,
    select: { id: true, orderId: true, awb: true, carrier: true, cogsComplete: true },
  });

  let billed = 0;
  let stillPending = 0;
  for (const row of pending) {
    const r = await resolveBilling({
      awb: row.awb,
      carrierHint: row.carrier,
      shiprocketEmail: creds.shiprocketEmail || undefined,
      shiprocketPassword: creds.shiprocketPassword || undefined,
      delhiveryApiKey: creds.delhiveryApiKey || undefined,
    });

    if (r && r !== "pending") {
      await prisma.orderFinancials.update({
        where: { id: row.id },
        data: {
          shippingCostMinor: r.freightMinor,
          rtoCostMinor: r.rtoMinor,
          codChargeMinor: r.codMinor,
          shippingStatus: "billed",
          shippingSyncedAt: new Date(),
          dataComplete: isDataComplete(row.cogsComplete, "billed"),
        },
      });
      billed++;
    } else if (r === null) {
      // Neither carrier recognises this AWB — mark unmatched so we stop retrying.
      await prisma.orderFinancials.update({
        where: { id: row.id },
        data: { shippingStatus: "unmatched", shippingSyncedAt: new Date() },
      });
    } else {
      stillPending++;
    }
    await sleep(300); // gentle pacing across carrier calls
  }

  return { checked: pending.length, billed, stillPending };
}

// ── Delivery outcome (the DELIVERED BASIS) ──────────────────────────────────
//
// Per the build spec (courier-status table, §3.1) — we use COURIER status as the
// authority (no OMS). Richer than a bare delivered/rto flag so the monthly P&L
// can count each state correctly and, crucially, EXCLUDE not-yet-resolved orders
// from rate denominators instead of miscounting them as "not delivered".
//
// Outcome states:
//   delivered       — parcel delivered (counts toward revenue/COGS/metrics)
//   rto             — returned to origin, terminal (stock back; COGS = 0)
//   rto_in_transit  — returning to origin, not yet back (NOT resolved yet)
//   lost            — carrier lost it (resolved, but not delivered)
//   cancelled       — cancelled/canceled scan
//   in_transit      — shipped/out-for-delivery/attempting (NOT resolved)
//   unresolved      — carrier gave a status we can't map (excluded from rates)
export type DeliveryOutcome =
  | "delivered"
  | "rto"
  | "rto_in_transit"
  | "lost"
  | "cancelled"
  | "in_transit"
  | "unresolved";

// Carriers write statuses with underscores, hyphens or spaces interchangeably
// ("RETURNED_TO_ORIGIN", "RTO IN TRANSIT", "rto-delivered"), so we normalise all
// separators to a single space before matching. Order matters below: terminal
// RTO must be tested before generic "returning to origin".
const RTO_TERMINAL_RE = /\brto (delivered|received|complete)|returned? to origin\b|\brts\b|return (received|accepted|to (seller|warehouse|origin))/;
const RTO_TRANSIT_RE = /returning to origin|rto (in transit|initiat)|\brto\b/;
const LOST_RE = /\blost\b|shipment lost|untraceable/;
const CANCELLED_RE = /\bcancel(l?ed|ed)?\b/;

/** Lower-case and collapse _/-/whitespace to single spaces for status matching. */
function normStatus(s: string): string {
  return String(s || "").toLowerCase().replace(/[_\-\s]+/g, " ").trim();
}

/**
 * Classify a courier TrackingResult into a delivery outcome.
 *
 * CRITICAL ORDERING: RTO is tested BEFORE the carrier's `delivered` flag. The
 * carriers report "RTO Delivered" (the RETURN reached origin) with their
 * delivered flag set — but that is an RTO, not a customer sale. Counting it as
 * delivered would inflate delivered revenue + COGS. So terminal-RTO wins first,
 * then the genuine delivered flag / "delivered" text, then in-flight RTO, lost,
 * cancelled, and finally in_transit. Unreadable status → "unresolved" (never
 * silently treated as not-delivered — the spec's key rule).
 */
export function classifyDelivery(r: TrackingResult): DeliveryOutcome {
  const text = normStatus(`${r.status} ${r.lastActivity}`);
  // RTO FIRST — "rto delivered" must not be read as a customer delivery.
  if (RTO_TERMINAL_RE.test(text)) return "rto";
  if (RTO_TRANSIT_RE.test(text)) return "rto_in_transit";
  // Genuine customer delivery (carrier flag, or a "delivered" not preceded by RTO).
  if (r.delivered) return "delivered";
  if (LOST_RE.test(text)) return "lost";
  if (CANCELLED_RE.test(text)) return "cancelled";
  if (text) return "in_transit";
  return "unresolved";
}

/** Resolved = terminal outcome, safe to count in rate denominators. in_transit,
 *  rto_in_transit and unresolved are NOT resolved (not-yet-known, not failed). */
export function isResolvedOutcome(o: string): boolean {
  return o === "delivered" || o === "rto" || o === "lost" || o === "cancelled";
}

/**
 * Fill delivery outcome for orders whose status isn't final yet. This is the
 * backbone of the monthly P&L: revenue, COGS and per-order metrics all count
 * DELIVERED orders only. Only re-checks orders that aren't already terminal
 * (delivered/rto), so a settled order is never re-fetched — keeps carrier calls
 * and Neon writes bounded. Never guesses: an order with no AWB is "no-awb", an
 * unreadable AWB stays "unknown", and both are simply excluded from delivered.
 */
export async function backfillDelivery(
  shop: string,
  opts: {
    limit?: number;
    carrier?: { shiprocketEmail?: string; shiprocketPassword?: string; delhiveryApiKey?: string };
  } = {},
): Promise<{ checked: number; delivered: number; rto: number; inTransit: number; noAwb: number }> {
  const limit = opts.limit ?? 60;

  let creds = opts.carrier;
  if (!creds) {
    const [ai, delivery] = await Promise.all([
      prisma.aiReplySettings.findUnique({
        where: { shop },
        select: { waShiprocketEmail: true, waShiprocketPassword: true },
      }),
      prisma.deliverySettings.findUnique({ where: { shop }, select: { apiToken: true } }),
    ]);
    creds = {
      shiprocketEmail: ai?.waShiprocketEmail,
      shiprocketPassword: ai?.waShiprocketPassword,
      delhiveryApiKey: delivery?.apiToken,
    };
  }

  // Orders not yet in a terminal delivery state. Those with no AWB get marked
  // "no-awb" in one cheap statement (no carrier call needed).
  const noAwbRes = await prisma.orderFinancials.updateMany({
    where: { shop, awb: "", deliveryStatus: { in: ["unknown"] } },
    data: { deliveryStatus: "no-awb", deliverySyncedAt: new Date() },
  });

  // Re-check only NON-terminal states — a delivered/rto/lost/cancelled order is
  // settled and never re-fetched (keeps carrier calls + Neon writes bounded).
  const toCheck = await prisma.orderFinancials.findMany({
    where: {
      shop,
      awb: { not: "" },
      deliveryStatus: { in: ["unknown", "in_transit", "rto_in_transit", "unresolved"] },
    },
    orderBy: { orderCreatedAt: "asc" },
    take: limit,
    select: { id: true, awb: true },
  });

  let delivered = 0;
  let rto = 0;
  let inTransit = 0;
  const noAwb = noAwbRes.count;
  for (const row of toCheck) {
    const r = await trackParcel({
      awb: row.awb,
      shiprocketEmail: creds.shiprocketEmail || undefined,
      shiprocketPassword: creds.shiprocketPassword || undefined,
      delhiveryApiKey: creds.delhiveryApiKey || undefined,
    });
    if (!r) {
      // Carrier didn't recognise/return the AWB this pass — leave as-is to retry.
      await sleep(300);
      continue;
    }
    const status = classifyDelivery(r);
    await prisma.orderFinancials.update({
      where: { id: row.id },
      data: {
        deliveryStatus: status,
        deliveredAt: status === "delivered" ? new Date() : null,
        deliverySyncedAt: new Date(),
      },
    });
    if (status === "delivered") delivered++;
    else if (status === "rto") rto++;
    else inTransit++;
    await sleep(300); // gentle pacing across carrier calls
  }

  return { checked: toCheck.length, delivered, rto, inTransit, noAwb };
}
