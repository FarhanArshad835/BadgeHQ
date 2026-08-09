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
/**
 * Terminal delivery status an order gets at write time, BEFORE the courier
 * sheet weighs in — for orders that will never appear in the sheet (no AWB).
 *
 * These stores' cancel tooling (Codify, OMS Guru) VOIDS the payment instead of
 * calling Shopify's native cancel, so cancelledAt stays null; VOIDED is the real
 * cancel signal. PENDING + never-fulfilled is an abandoned COD (confirmation
 * never completed) — a distinct outcome, kept separate from a true cancel and
 * from a paid-but-stuck order.
 *
 * Only applied when the order has NO AWB: a shipped order's outcome must come
 * from the courier, never from its payment state.
 */
function initialDelivery(c: OrderFinancialsComputed): string {
  if (c.awb) return "unknown"; // shipped — let the sheet decide
  const fin = c.financialStatus.toUpperCase();
  const ful = c.fulfillmentStatus.toUpperCase();
  if (c.isCancelled || fin === "VOIDED") return "cancelled";
  if (fin === "PENDING" && ful !== "FULFILLED") return "abandoned";
  return "unknown";
}

async function writeOrderPage(shop: string, computed: OrderFinancialsComputed[]): Promise<void> {
  if (!computed.length) return;
  const now = new Date();

  // One statement: bulk upsert. On conflict we keep any shipping cost/status the
  // backfill already set (COALESCE on the existing row), and recompute
  // dataComplete from the merged shipping status in SQL.
  const rows = computed.map((c) => {
    const initialShippingStatus = c.awb ? "pending" : "no-awb";
    const initialDeliveryStatus = initialDelivery(c);
    return Prisma.sql`(
      ${randomUUID()}, ${shop}, ${c.orderId}, ${c.orderName}, ${c.orderCreatedAt}, ${c.currency},
      ${c.grossRevenueMinor}, ${c.refundsMinor}, ${c.discountsMinor},
      ${c.cogsMinor}, ${c.cogsComplete},
      ${initialShippingStatus}, ${c.awb}, ${c.carrier},
      ${c.financialStatus}, ${c.fulfillmentStatus},
      ${c.cogsComplete}, ${initialDeliveryStatus}, ${now}, ${now}, ${now}
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
      "dataComplete", "deliveryStatus", "revenueSyncedAt", "cogsSyncedAt", "updatedAt"
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
      -- A no-AWB order newly resolved as cancelled/abandoned takes that status;
      -- otherwise keep the outcome the sheet resolved (delivered/rto/…). Never
      -- downgrade a resolved order — and these only fire for orders with no AWB,
      -- so the sheet never set anything to lose.
      "deliveryStatus"    = CASE WHEN EXCLUDED."deliveryStatus" IN ('cancelled', 'abandoned')
                                 THEN EXCLUDED."deliveryStatus"
                                 ELSE "OrderFinancials"."deliveryStatus" END,
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

// Delivery outcome now comes ENTIRELY from the uploaded/published tracking sheet
// (delivery-import.server.ts → mapSheetStatus), keyed by AWB. The courier-status
// lookup was removed: it depended on a Delhivery/Shiprocket token that was
// unreliable (99% of sheet rows had logged "Lookup Failed: token missing"), and
// the sheet is the merchant's authority anyway. The freight-COST backfill
// (backfillShipping, above) still calls the courier — that's a separate concern.

/** Resolved = terminal outcome, safe to count in rate denominators. in_transit,
 *  rto_in_transit and unresolved are NOT resolved (not-yet-known, not failed). */
export function isResolvedOutcome(o: string): boolean {
  // abandoned = payment pending + never fulfilled: terminal (never shipping), so
  // it counts as resolved just like cancelled.
  return (
    o === "delivered" ||
    o === "rto" ||
    o === "lost" ||
    o === "cancelled" ||
    o === "abandoned"
  );
}

