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
