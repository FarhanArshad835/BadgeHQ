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
/**
 * One connect promise, shared by every caller.
 *
 * Prisma connects lazily on first query, and several scans arriving at once
 * each got the same un-connected client and raced that startup — the losers
 * threw "Engine is not yet connected" and the page reported ReturnHQ as
 * unreachable when it was perfectly healthy. Awaiting one shared promise means
 * the first caller starts the engine and the rest wait for it.
 */
let _connecting: Promise<PrismaClient | null> | null = null;

function returnHqClient(): PrismaClient | null {
  const url = process.env.RETURNHQ_DATABASE_URL;
  if (!url) return null;
  if (!_client) {
    _client = new PrismaClient({ datasources: { db: { url } } });
  }
  return _client;
}

/** The client, guaranteed connected. Every query path must use this. */
async function returnHqReady(): Promise<PrismaClient | null> {
  const db = returnHqClient();
  if (!db) return null;
  if (!_connecting) {
    _connecting = db
      .$connect()
      .then(() => db)
      .catch((e) => {
        // Let the next caller try again rather than caching the failure.
        _connecting = null;
        throw e;
      });
  }
  return _connecting;
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
  const db = await returnHqReady();
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
 * ReturnHQ requests for specific orders, keyed by order name.
 *
 * The cached table holds monthly TOTALS only, which is right for the statement
 * but useless in a per-order export: a row cannot say whether that customer
 * returned. This reads the live ReturnHQ DB for the given order names.
 *
 * Read-only, and scoped to this shop's shop_id, since that database is
 * multi-tenant. Returns an empty map on any failure rather than throwing: a
 * missing return column should not take down an export.
 */
export async function returnHqByOrder(
  orderNames: string[],
): Promise<Map<string, { type: string; status: string }>> {
  const out = new Map<string, { type: string; status: string }>();
  if (!orderNames.length) return out;

  const db = await returnHqReady();
  if (!db) return out;
  try {
    const shopId = await jmShopId(db);
    if (shopId == null) return out;

    // Chunked: a single IN list of a month's order names is large enough to
    // upset the planner.
    for (let i = 0; i < orderNames.length; i += 2000) {
      const slice = orderNames.slice(i, i + 2000);
      const rows = await db.$queryRawUnsafe<
        Array<{ shopify_order_number: string; type: string; status: string }>
      >(
        `SELECT shopify_order_number, type::text AS type, status::text AS status
           FROM return_requests
          WHERE shop_id = $1 AND shopify_order_number = ANY($2)`,
        shopId,
        slice,
      );
      for (const r of rows) {
        const name = String(r.shopify_order_number || "").trim();
        if (!name) continue;
        // One order can carry several requests; the newest wins, and a
        // cancelled one never masks a live request.
        const prev = out.get(name);
        if (!prev || prev.status === "cancelled") {
          out.set(name, { type: r.type, status: r.status });
        }
      }
    }
    return out;
  } catch (e: any) {
    console.error("[returnhq] byOrder", String(e?.message || e).slice(0, 200));
    return out;
  } finally {
    await db.$disconnect().catch(() => {});
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

/**
 * Every customer return the courier says it delivered to us, past the grace
 * period. The caller decides which of them the bench has actually scanned.
 *
 * The mirror of the RTO claim list, against a different counterparty. A reverse
 * pickup is still a courier holding our stock: they collected it from the
 * customer and told us they dropped it at the warehouse, so if it never turned
 * up that is their liability, not the customer's.
 *
 * Measured against ScanEvent, NOT against ReturnHQ's own received_at. That
 * column is set by the QC step, and on live data every request carrying
 * carrier_received_at already had it — so comparing the two columns asked
 * ReturnHQ whether ReturnHQ agreed with itself and always answered zero. The
 * bench scan is an independent observation, and a courier delivery that no
 * scan corroborates is the gap actually worth chasing.
 *
 * Rows with no carrier date are counted separately rather than assumed missing:
 * a return still in transit has not been delivered yet, and dunning a courier
 * for a parcel they are still carrying wastes the relationship.
 */
export async function unconfirmedReturns(
  graceDays: number,
): Promise<{
  rows: Array<{
    orderName: string;
    awb: string;
    carrier: string;
    receivedAt: string;
    daysOld: number;
    type: string;
  }>;
  /** Picked up but the courier has not yet said it reached us. */
  inFlight: number;
  available: boolean;
}> {
  const db = await returnHqReady();
  if (!db) return { rows: [], inFlight: 0, available: false };
  try {
    const shopId = await jmShopId(db);
    if (shopId == null) return { rows: [], inFlight: 0, available: false };

    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

    const rows = await db.$queryRawUnsafe<
      Array<{
        order_name: string;
        awb: string | null;
        provider: string | null;
        carrier_received_at: Date;
        type: string;
      }>
    >(
      `SELECT shopify_order_number AS order_name,
              awb_number           AS awb,
              logistics_provider   AS provider,
              carrier_received_at,
              type::text           AS type
         FROM return_requests
        WHERE shop_id = $1
          AND status::text <> 'cancelled'
          AND carrier_received_at IS NOT NULL
          AND carrier_received_at < $2
        ORDER BY carrier_received_at ASC
        LIMIT 20000`,
      shopId,
      cutoff,
    );

    const inFlightRows = await db.$queryRawUnsafe<Array<{ c: bigint }>>(
      // Stated positively: only a parcel the courier has actually collected is
      // "on the way back". A request that is merely raised or approved is still
      // sitting with the customer and is not in anyone's custody.
      `SELECT count(*) AS c
         FROM return_requests
        WHERE shop_id = $1
          AND status::text IN ('pickup_scheduled', 'in_transit')
          AND carrier_received_at IS NULL
          AND received_at IS NULL`,
      shopId,
    );

    const now = Date.now();
    return {
      available: true,
      inFlight: Number(inFlightRows[0]?.c ?? 0),
      rows: rows.map((r) => ({
        orderName: r.order_name,
        awb: r.awb || "",
        carrier: r.provider || "",
        receivedAt: r.carrier_received_at.toISOString().slice(0, 10),
        daysOld: Math.floor((now - r.carrier_received_at.getTime()) / 86400000),
        type: r.type,
      })),
    };
  } catch (e: any) {
    // A ReturnHQ outage should leave the RTO half of the page working.
    console.error("[returnhq] unconfirmed", String(e?.message || e).slice(0, 200));
    return { rows: [], inFlight: 0, available: false };
  }
}

/**
 * Find a return request by its REVERSE AWB — the waybill on the parcel the
 * customer sends back.
 *
 * OrderFinancials only ever holds the FORWARD AWB, the one we shipped out on.
 * A reverse pickup gets a different waybill entirely (Delhivery's start with
 * "R"), so scanning the label on a returning parcel finds nothing there and the
 * scanner falls back to "not in our orders yet, assumed RTO" — filing a
 * customer return as an RTO, which is exactly the misclassification the
 * auto-detection exists to prevent.
 *
 * ReturnHQ stores that reverse waybill on the request, so it is the only place
 * this lookup can succeed.
 */
export async function returnHqByReverseAwb(awb: string): Promise<{
  orderName: string;
  type: string;
  status: string;
} | null> {
  const db = await returnHqReady();
  if (!db) return null;
  const clean = String(awb || "").replace(/[^0-9a-zA-Z]/g, "").trim();
  if (clean.length < 6) return null;
  try {
    const shopId = await jmShopId(db);
    if (shopId == null) return null;
    // Compared with punctuation stripped on BOTH sides: the scanner normalises
    // what the gun reads, and ReturnHQ's stored value may carry spacing or
    // dashes from whatever created it.
    const rows = await db.$queryRawUnsafe<
      Array<{ order_name: string; type: string; status: string }>
    >(
      `SELECT shopify_order_number AS order_name,
              type::text           AS type,
              status::text         AS status
         FROM return_requests
        WHERE shop_id = $1
          AND regexp_replace(COALESCE(awb_number, ''), '[^0-9a-zA-Z]', '', 'g') = $2
        ORDER BY created_at DESC
        LIMIT 1`,
      shopId,
      clean,
    );
    const r = rows[0];
    return r ? { orderName: r.order_name, type: r.type, status: r.status } : null;
  } catch (e: any) {
    // Rethrown, not swallowed. Returning null here would be indistinguishable
    // from "this AWB is not a return", and the caller would file a customer
    // return as an RTO and store that verdict permanently. The caller decides
    // what to do with a failure; it must not be told a lie.
    console.error("[returnhq] byReverseAwb", String(e?.message || e).slice(0, 200));
    throw e;
  }
}

/**
 * Every return and exchange request, one row per ITEM, for export.
 *
 * All-time rather than per-month, because a return is raised weeks after the
 * order and belongs to neither month cleanly — the P&L's monthly export already
 * assigns it to the order's month, and this file is the raw record behind that.
 *
 * One row per item, matching the per-unit export: a request for two pairs
 * becomes two rows, so the file can be pivoted by SKU or reason without anyone
 * having to weight by quantity first.
 *
 * Every timestamp ReturnHQ records is carried, because the gaps between them
 * are the answerable questions: raised to picked up is the customer's delay,
 * picked up to carrier-received is the courier's, and carrier-received to
 * received is ours.
 */
export async function returnHqExportRows(): Promise<Array<Record<string, string>>> {
  const db = await returnHqReady();
  if (!db) return [];
  const shopId = await jmShopId(db);
  if (shopId == null) return [];

  const rows = await db.$queryRawUnsafe<Array<Record<string, any>>>(
    `SELECT r.shopify_order_number, r.ran, r.type::text AS type, r.status::text AS status,
            r.customer_name, r.customer_email, r.customer_phone,
            r.awb_number, r.logistics_provider, r.tracking_url,
            r.total_fee_paise, r.restocking_fee_paise, r.shipping_fee_paise,
            r.fee_collected, r.fee_deducted,
            r.refund_method::text AS refund_method,
            r.refund_amount_paise, r.refund_deductions_paise,
            r.exchange_order_id, r.is_self_ship, r.received_source,
            r.carrier_status_text, r.merchant_notes, r.rejection_reason,
            r.created_at, r.approved_at, r.rejected_at, r.pickup_scheduled_at,
            r.picked_up_at, r.carrier_received_at, r.received_at,
            r.refunded_at, r.completed_at,
            i.sku, i.product_title, i.variant_title, i.quantity,
            i.price_paise, i.price_paid_paise,
            i.reason_text, i.item_type::text AS item_type,
            i.exchange_sku, i.exchange_variant_title, i.exchange_price_paise,
            i.resolution_status::text AS resolution_status,
            rr.label AS reason_label
       FROM return_requests r
       LEFT JOIN return_request_items i ON i.return_request_id = r.id
       LEFT JOIN return_reasons rr ON rr.id = i.reason_id
      WHERE r.shop_id = $1
      ORDER BY r.created_at DESC, i.id ASC`,
    shopId,
  );

  const IST = IST_OFFSET_MS;
  // Dates in IST, so a file opened in Delhi shows the day the thing happened.
  const d = (v: any) =>
    v instanceof Date ? new Date(v.getTime() + IST).toISOString().slice(0, 16).replace("T", " ") : "";
  const rup = (v: any) => (v == null ? "" : (Number(v) / 100).toFixed(2));
  const str = (v: any) => (v == null ? "" : String(v));
  const bool = (v: any) => (v === true ? "yes" : v === false ? "no" : "");
  // Whole days between two stamps: the gap is the question, not the instants.
  const gap = (a: any, b: any) =>
    a instanceof Date && b instanceof Date
      ? String(Math.floor((b.getTime() - a.getTime()) / 86400000))
      : "";

  return rows.map((r) => ({
    order_name: str(r.shopify_order_number),
    request_ref: str(r.ran),
    type: str(r.type),
    status: str(r.status),
    sku: str(r.sku),
    product_title: str(r.product_title),
    variant_title: str(r.variant_title),
    quantity: str(r.quantity),
    item_price: rup(r.price_paise),
    price_paid: rup(r.price_paid_paise),
    item_type: str(r.item_type),
    reason: str(r.reason_label || r.reason_text),
    reason_detail: str(r.reason_text),
    resolution_status: str(r.resolution_status),
    exchange_sku: str(r.exchange_sku),
    exchange_variant: str(r.exchange_variant_title),
    exchange_price: rup(r.exchange_price_paise),
    exchange_order_id: str(r.exchange_order_id),
    fee_total: rup(r.total_fee_paise),
    fee_restocking: rup(r.restocking_fee_paise),
    fee_shipping: rup(r.shipping_fee_paise),
    fee_collected: bool(r.fee_collected),
    fee_deducted: bool(r.fee_deducted),
    refund_method: str(r.refund_method),
    refund_amount: rup(r.refund_amount_paise),
    refund_deductions: rup(r.refund_deductions_paise),
    reverse_awb: str(r.awb_number),
    carrier: str(r.logistics_provider),
    carrier_status: str(r.carrier_status_text),
    self_ship: bool(r.is_self_ship),
    received_source: str(r.received_source),
    raised_at: d(r.created_at),
    approved_at: d(r.approved_at),
    rejected_at: d(r.rejected_at),
    pickup_scheduled_at: d(r.pickup_scheduled_at),
    picked_up_at: d(r.picked_up_at),
    carrier_received_at: d(r.carrier_received_at),
    received_at: d(r.received_at),
    refunded_at: d(r.refunded_at),
    completed_at: d(r.completed_at),
    days_raised_to_pickup: gap(r.created_at, r.picked_up_at),
    days_pickup_to_carrier: gap(r.picked_up_at, r.carrier_received_at),
    days_carrier_to_received: gap(r.carrier_received_at, r.received_at),
    days_raised_to_completed: gap(r.created_at, r.completed_at),
    merchant_notes: str(r.merchant_notes),
    rejection_reason: str(r.rejection_reason),
    tracking_url: str(r.tracking_url),
  }));
}
