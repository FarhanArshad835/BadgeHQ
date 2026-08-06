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
 * Sync revenue + COGS for all orders created in [since, until]. Upserts one
 * OrderFinancials row per order and replaces its OrderLineFinancials. Shipping
 * is initialised to "pending" (or "no-awb" when there's no tracking number yet)
 * and filled later by backfillShipping.
 *
 * Paces on Shopify's cost-based throttle: when the available budget runs low it
 * sleeps until it refills, so a big window never 429s.
 */
export async function syncRevenueAndCogs(
  admin: AdminGraphql,
  shop: string,
  opts: { since: Date; until: Date; maxPages?: number },
): Promise<{ orders: number; pages: number }> {
  const createdAtMin = opts.since.toISOString();
  const createdAtMax = opts.until.toISOString();
  const maxPages = opts.maxPages ?? 40;

  let cursor: string | null = null;
  let pages = 0;
  let orders = 0;

  while (pages < maxPages) {
    const { nodes, nextCursor, throttle } = await fetchOrdersPage(admin, {
      createdAtMin,
      createdAtMax,
      cursor,
    });
    pages++;

    for (const node of nodes) {
      const c = computeOrderFinancials(node);
      await upsertOrderFinancials(shop, c);
      orders++;
    }

    if (!nextCursor) break;
    cursor = nextCursor;

    // Pace on the GraphQL cost budget: if we're low, wait for it to refill
    // (~50 points/sec on standard). Cheap insurance against 429s on big windows.
    if (throttle && throttle.currentlyAvailable < 200) {
      await sleep(2000);
    }
  }

  return { orders, pages };
}

/** Upsert one order's financials + replace its line rows. */
async function upsertOrderFinancials(shop: string, c: OrderFinancialsComputed): Promise<void> {
  const now = new Date();
  const existing = await prisma.orderFinancials.findUnique({
    where: { shop_orderId: { shop, orderId: c.orderId } },
    select: { shippingStatus: true, shippingCostMinor: true },
  });

  // Preserve any shipping cost already backfilled; only (re)derive the initial
  // shipping STATUS from whether we now have an AWB.
  const shippingStatus =
    existing?.shippingCostMinor != null
      ? existing.shippingStatus
      : c.awb
      ? "pending"
      : "no-awb";
  const shippingCostMinor = existing?.shippingCostMinor ?? null;
  const dataComplete = isDataComplete(c.cogsComplete, shippingStatus);

  const base = {
    orderName: c.orderName,
    orderCreatedAt: c.orderCreatedAt,
    currency: c.currency,
    grossRevenueMinor: c.grossRevenueMinor,
    refundsMinor: c.refundsMinor,
    discountsMinor: c.discountsMinor,
    cogsMinor: c.cogsMinor,
    cogsComplete: c.cogsComplete,
    shippingStatus,
    awb: c.awb,
    carrier: c.carrier,
    financialStatus: c.financialStatus,
    fulfillmentStatus: c.fulfillmentStatus,
    dataComplete,
    revenueSyncedAt: now,
    cogsSyncedAt: now,
  };

  await prisma.orderFinancials.upsert({
    where: { shop_orderId: { shop, orderId: c.orderId } },
    create: { shop, orderId: c.orderId, shippingCostMinor, ...base },
    update: base,
  });

  // Replace line rows (cheap; keeps per-product view correct after edits).
  await prisma.orderLineFinancials.deleteMany({ where: { shop, orderId: c.orderId } });
  if (c.lines.length) {
    await prisma.orderLineFinancials.createMany({
      data: c.lines.map((l) => ({
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
    });
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
  opts: { limit?: number } = {},
): Promise<{ checked: number; billed: number; stillPending: number }> {
  const limit = opts.limit ?? 40;

  const [ai, delivery] = await Promise.all([
    prisma.aiReplySettings.findUnique({
      where: { shop },
      select: { waShiprocketEmail: true, waShiprocketPassword: true },
    }),
    prisma.deliverySettings.findUnique({ where: { shop }, select: { apiToken: true } }),
  ]);

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
      shiprocketEmail: ai?.waShiprocketEmail || undefined,
      shiprocketPassword: ai?.waShiprocketPassword || undefined,
      delhiveryApiKey: delivery?.apiToken || undefined,
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
