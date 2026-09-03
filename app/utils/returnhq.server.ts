/**
 * ReturnHQ integration — reads returns & exchanges DIRECTLY from ReturnHQ's own
 * Neon database, not from Shopify tags.
 *
 * Why direct: a return/exchange is created in ReturnHQ days or weeks after the
 * order ships. Inferring it from Shopify order tags misses any return tagged
 * after the order left the P&L sync window. ReturnHQ's DB always has the
 * current, complete list, so we read it live and group by month.
 *
 * Read-only. A dedicated PrismaClient on RETURNHQ_DATABASE_URL runs raw SQL
 * (no ReturnHQ models in our schema needed). Scoped to JM Looks' shop_id only.
 */
import { PrismaClient } from "@prisma/client";
import bhq from "../db.server";

// ReturnHQ is multi-tenant; we only ever read JM Looks' rows. Resolved by
// domain the first time, then cached, so a shop-id change can't silently break.
const JM_DOMAIN = "b03304.myshopify.com";

let _client: PrismaClient | null = null;
function returnHqClient(): PrismaClient | null {
  const url = process.env.RETURNHQ_DATABASE_URL;
  if (!url) return null;
  if (!_client) {
    _client = new PrismaClient({ datasources: { db: { url } } });
  }
  return _client;
}

let _shopIdCache: number | null | undefined;
async function jmShopId(db: PrismaClient): Promise<number | null> {
  if (_shopIdCache !== undefined) return _shopIdCache;
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(
    `SELECT id FROM shops WHERE shopify_domain = $1 LIMIT 1`,
    JM_DOMAIN,
  );
  _shopIdCache = rows[0]?.id ?? null;
  return _shopIdCache;
}

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const SHOP = "b03304.myshopify.com";
const IST = IST_OFFSET_MS;
function orderMonthIst(orderCreatedAt: Date): string {
  const d = new Date(orderCreatedAt.getTime() + IST);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export type ReturnHqMonth = {
  returns: number;
  exchanges: number;
  returnsValueMinor: bigint;
  exchangesValueMinor: bigint;
  available: boolean; // false when RETURNHQ_DATABASE_URL isn't set / shop not found
};

/**
 * Refresh the ReturnHQ cache for ALL months, mapping every return/exchange to
 * the month of the ORDER it belongs to (so it lines up with the delivery
 * funnel's placed basis, not the request date). Called by the P&L cron twice a
 * day; the dashboard reads the cached rows, never ReturnHQ live.
 *
 * Mapping: each return_requests row carries shopify_order_number; we join it to
 * OrderFinancials.orderName and bucket by that order's IST month. A request
 * whose order isn't synced yet is skipped (it'll count once the order syncs).
 * `mixed` counts as both; cancelled excluded.
 */
export async function refreshReturnHqCache(): Promise<{
  ok: boolean;
  months: number;
  skipped?: number; // requests whose order isn't synced, so they count nowhere
  total?: number;
}> {
  const db = returnHqClient();
  if (!db) return { ok: false, months: 0 };
  try {
    const shopId = await jmShopId(db);
    if (shopId == null) return { ok: false, months: 0 };

    // All non-cancelled requests: order number + type.
    const reqs = await db.$queryRawUnsafe<Array<{ shopify_order_number: string; type: string }>>(
      `SELECT shopify_order_number, type::text AS type
         FROM return_requests
        WHERE shop_id = $1 AND status::text <> 'cancelled'`,
      shopId,
    );

    // Resolve each order number -> the order's IST month (from our synced data).
    const orderNames = Array.from(new Set(reqs.map((r) => String(r.shopify_order_number || "").trim()).filter(Boolean)));
    const orders = await bhq.orderFinancials.findMany({
      where: { shop: SHOP, orderName: { in: orderNames } },
      select: { orderName: true, orderCreatedAt: true, grossRevenueMinor: true },
    });
    const monthByOrder = new Map(orders.map((o) => [o.orderName, orderMonthIst(o.orderCreatedAt)]));
    const revByOrder = new Map(orders.map((o) => [o.orderName, o.grossRevenueMinor]));

    // Bucket returns/exchanges by the order's month, and sum the order's revenue.
    const counts = new Map<string, { returns: number; exchanges: number; returnsValueMinor: bigint; exchangesValueMinor: bigint }>();
    let skipped = 0;
    for (const r of reqs) {
      const orderName = String(r.shopify_order_number || "").trim();
      const month = monthByOrder.get(orderName);
      // Order not synced yet, so we can't tell which month this request belongs
      // to. Counted so the caller can report it: silently dropping requests makes
      // a stale cache look identical to a genuinely quiet month.
      if (!month) { skipped++; continue; }
      const rev = revByOrder.get(orderName) ?? 0n;
      const e = counts.get(month) || { returns: 0, exchanges: 0, returnsValueMinor: 0n, exchangesValueMinor: 0n };
      if (r.type === "return") { e.returns += 1; e.returnsValueMinor += rev; }
      else if (r.type === "exchange") { e.exchanges += 1; e.exchangesValueMinor += rev; }
      else if (r.type === "mixed") { e.returns += 1; e.exchanges += 1; e.returnsValueMinor += rev; e.exchangesValueMinor += rev; }
      counts.set(month, e);
    }

    // Upsert each month's cache row.
    const now = new Date();
    for (const [month, c] of counts) {
      const row = {
        returns: c.returns,
        exchanges: c.exchanges,
        returnsValueMinor: c.returnsValueMinor,
        exchangesValueMinor: c.exchangesValueMinor,
        syncedAt: now,
      };
      await bhq.returnHqCache.upsert({
        where: { shop_month: { shop: SHOP, month } },
        create: { shop: SHOP, month, ...row },
        update: row,
      });
    }
    return { ok: true, months: counts.size, skipped, total: reqs.length };
  } catch (e: any) {
    console.error("[returnhq] refresh", String(e?.message || e).slice(0, 200));
    return { ok: false, months: 0 };
  }
}

/**
 * Read the cached ReturnHQ counts for a month (populated by the cron). No live
 * ReturnHQ query — fast, and doesn't hit ReturnHQ on every page load.
 */
export async function returnHqCountsForMonth(month: string): Promise<ReturnHqMonth> {
  const row = await bhq.returnHqCache.findUnique({
    where: { shop_month: { shop: SHOP, month } },
    select: { returns: true, exchanges: true, returnsValueMinor: true, exchangesValueMinor: true },
  });
  if (!row) return { returns: 0, exchanges: 0, returnsValueMinor: 0n, exchangesValueMinor: 0n, available: false };
  return {
    returns: row.returns,
    exchanges: row.exchanges,
    returnsValueMinor: row.returnsValueMinor,
    exchangesValueMinor: row.exchangesValueMinor,
    available: true,
  };
}
