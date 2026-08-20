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
function monthWindowIst(month: string): { start: Date; end: Date } {
  const [y, m] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(y, m - 1, 1) - IST_OFFSET_MS),
    end: new Date(Date.UTC(m === 12 ? y + 1 : y, m === 12 ? 0 : m, 1) - IST_OFFSET_MS),
  };
}

export type ReturnHqMonth = {
  returns: number;
  exchanges: number;
  available: boolean; // false when RETURNHQ_DATABASE_URL isn't set / shop not found
};

/**
 * Count returns and exchanges CREATED in an IST calendar month for JM Looks.
 * `mixed`-type requests count as both a return and an exchange (they contain
 * both). Cancelled requests are excluded — they were requested then withdrawn,
 * so they aren't real returns/exchanges. Grouped by created_at (when the
 * customer raised the request), matching the delivery funnel's placed basis.
 */
export async function returnHqCountsForMonth(month: string): Promise<ReturnHqMonth> {
  const db = returnHqClient();
  if (!db) return { returns: 0, exchanges: 0, available: false };

  try {
    const shopId = await jmShopId(db);
    if (shopId == null) return { returns: 0, exchanges: 0, available: false };

    const { start, end } = monthWindowIst(month);
    const rows = await db.$queryRawUnsafe<Array<{ type: string; n: bigint }>>(
      `SELECT type::text AS type, count(*) AS n
         FROM return_requests
        WHERE shop_id = $1
          AND created_at >= $2 AND created_at < $3
          AND status::text <> 'cancelled'
        GROUP BY type`,
      shopId,
      start,
      end,
    );

    let returns = 0;
    let exchanges = 0;
    for (const r of rows) {
      const n = Number(r.n);
      if (r.type === "return") returns += n;
      else if (r.type === "exchange") exchanges += n;
      else if (r.type === "mixed") {
        returns += n;
        exchanges += n;
      }
    }
    return { returns, exchanges, available: true };
  } catch (e: any) {
    console.error("[returnhq]", String(e?.message || e).slice(0, 200));
    return { returns: 0, exchanges: 0, available: false };
  }
}
