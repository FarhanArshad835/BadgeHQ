/**
 * Daily P&L sync cron — keeps the OrderFinancials cache fresh.
 *
 * Two jobs per shop that has P&L enabled or existing financials:
 *   1. Re-sync the last ~3 days of orders — revenue and refunds can change
 *      after the fact (a refund posts days later).
 *   2. Backfill shipping for ALL pending rows — this is how a freight charge
 *      that bills days after dispatch gets picked up automatically. Never
 *      estimated: an un-billed shipment stays pending.
 *
 * Guarded by CRON_SECRET (a run reads the merchant's Shopify + carrier data).
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncRevenueAndCogs, backfillShipping } from "../utils/pnl-sync.server";
import { getPnlApp, runStandaloneSync } from "../utils/pnl-app.server";
import { fetchAndApplyDeliverySheet } from "../utils/delivery-import.server";
import { computeMonth } from "../utils/monthly-pnl.server";

export const config = { maxDuration: 300 };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// How long the standalone sync may run before it saves its cursor and stops,
// leaving headroom under maxDuration for backfill + response.
const STANDALONE_TIME_BUDGET_MS = 220_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("Authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  // Read-only reporting mode: ?stats=1 returns the COGS cost-match rate (and a
  // few funnel counts) for every month with orders. Runs NO sync — it only
  // reads the already-synced tables, so it's safe to call any time.
  if (new URL(request.url).searchParams.get("stats") === "1") {
    const app = await getPnlApp();
    const shop = app.shopDomain;
    if (!shop) return json({ error: "not-configured" }, { status: 400 });

    // Distinct order-months (IST), same derivation the dashboard dropdown uses.
    const rows = await prisma.orderFinancials.findMany({
      where: { shop },
      select: { orderCreatedAt: true },
    });
    const months = new Set<string>();
    for (const r of rows) {
      const ist = new Date(r.orderCreatedAt.getTime() + IST_OFFSET_MS);
      months.add(`${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`);
    }
    const sorted = Array.from(months).sort();

    const stats = [];
    for (const month of sorted) {
      const m = await computeMonth(shop, month);
      stats.push({
        month,
        cogsMatchRate: Number((m.cogsMatchRate * 100).toFixed(1)),
        placedOrders: m.placedOrders,
        deliveredOrders: m.deliveredOrders,
        deliveredPairs: m.deliveredPairs,
      });
    }
    return json({ ok: true, shop, months: stats });
  }

  // Read-only: ?missing=YYYY-MM lists the delivered lines that still have NO
  // cost-per-item — the exact rows dragging that month's match rate below 100%.
  // Grouped by variant so a fixable variant shows once with its total line count.
  const missingMonth = new URL(request.url).searchParams.get("missing");
  if (missingMonth) {
    const app = await getPnlApp();
    const shop = app.shopDomain;
    if (!shop) return json({ error: "not-configured" }, { status: 400 });

    // Same window + delivered-set as deliveredCogs(), so the counts reconcile.
    const [y, mo] = missingMonth.split("-").map(Number);
    const start = new Date(Date.UTC(y, mo - 1, 1) - IST_OFFSET_MS);
    const end = new Date(Date.UTC(y, mo, 1) - IST_OFFSET_MS);

    const delivered = await prisma.orderFinancials.findMany({
      where: { shop, orderCreatedAt: { gte: start, lt: end }, deliveryStatus: "delivered" },
      select: { orderId: true },
    });
    const ids = delivered.map((d) => d.orderId);

    const lines = await prisma.orderLineFinancials.findMany({
      where: { shop, orderId: { in: ids } },
      select: {
        variantId: true,
        productTitle: true,
        variantTitle: true,
        quantity: true,
        lineCogsComplete: true,
        lineCogsMinor: true,
      },
    });

    let deliveredLines = 0;
    let missingLines = 0;
    const byVariant = new Map<
      string,
      { productTitle: string; variantTitle: string; variantId: string; lines: number; pairs: number }
    >();
    for (const l of lines) {
      deliveredLines++;
      const hasCost = l.lineCogsComplete && l.lineCogsMinor != null;
      if (hasCost) continue;
      missingLines++;
      const key = l.variantId || `${l.productTitle}|${l.variantTitle}`;
      const g =
        byVariant.get(key) ??
        {
          productTitle: l.productTitle,
          variantTitle: l.variantTitle,
          variantId: l.variantId,
          lines: 0,
          pairs: 0,
        };
      g.lines += 1;
      g.pairs += l.quantity;
      byVariant.set(key, g);
    }

    const missing = Array.from(byVariant.values()).sort((a, b) => b.lines - a.lines);
    return json({
      ok: true,
      shop,
      month: missingMonth,
      deliveredLines,
      missingLines,
      matchRatePct: deliveredLines ? Number((((deliveredLines - missingLines) / deliveredLines) * 100).toFixed(2)) : 100,
      distinctVariantsMissing: missing.length,
      missing,
    });
  }

  // Read-only: ?transit=YYYY-MM breaks down the "in transit / unknown" orders
  // for a month — why each isn't delivered/RTO. Old months should be nearly
  // empty; a large bucket points at the cause (no AWB, AWB not in the sheet,
  // or an unreadable raw status).
  const transitMonth = new URL(request.url).searchParams.get("transit");
  if (transitMonth) {
    const app = await getPnlApp();
    const shop = app.shopDomain;
    if (!shop) return json({ error: "not-configured" }, { status: 400 });

    const [ty, tm] = transitMonth.split("-").map(Number);
    const tStart = new Date(Date.UTC(ty, tm - 1, 1) - IST_OFFSET_MS);
    const tEnd = new Date(Date.UTC(ty, tm, 1) - IST_OFFSET_MS);

    const orders = await prisma.orderFinancials.findMany({
      where: { shop, orderCreatedAt: { gte: tStart, lt: tEnd } },
      select: { deliveryStatus: true, awb: true, shippingStatus: true },
    });

    const byStatus: Record<string, number> = {};
    let total = 0;
    let notResolved = 0;
    let noAwb = 0;
    let hasAwbUnresolved = 0;
    for (const o of orders) {
      total++;
      byStatus[o.deliveryStatus] = (byStatus[o.deliveryStatus] || 0) + 1;
      const resolved = o.deliveryStatus === "delivered" || o.deliveryStatus === "rto";
      if (resolved) continue;
      notResolved++;
      if (!o.awb) noAwb++;
      else hasAwbUnresolved++;
    }
    return json({
      ok: true,
      shop,
      month: transitMonth,
      totalOrders: total,
      notResolved, // neither delivered nor rto
      breakdown: {
        noAwb, // nothing to match against the sheet
        hasAwbButUnresolved: hasAwbUnresolved, // AWB present, sheet didn't resolve it
      },
      byDeliveryStatus: byStatus,
    });
  }

  // Read-only: ?noawb=YYYY-MM lists every order in the month with no AWB and
  // no delivered/rto outcome — the orders stuck as "no-awb". Add &format=csv to
  // download. These are the ones that can never resolve without a tracking no.
  const noawbMonth = new URL(request.url).searchParams.get("noawb");
  if (noawbMonth) {
    const app = await getPnlApp();
    const shop = app.shopDomain;
    if (!shop) return json({ error: "not-configured" }, { status: 400 });

    const [ny, nm] = noawbMonth.split("-").map(Number);
    const nStart = new Date(Date.UTC(ny, nm - 1, 1) - IST_OFFSET_MS);
    const nEnd = new Date(Date.UTC(ny, nm, 1) - IST_OFFSET_MS);

    const rows = await prisma.orderFinancials.findMany({
      where: {
        shop,
        orderCreatedAt: { gte: nStart, lt: nEnd },
        awb: "",
        deliveryStatus: { notIn: ["delivered", "rto"] },
      },
      select: {
        orderName: true,
        orderId: true,
        orderCreatedAt: true,
        deliveryStatus: true,
        financialStatus: true,
        fulfillmentStatus: true,
      },
      orderBy: { orderCreatedAt: "asc" },
    });

    // Break the no-awb bucket down by Shopify's financial + fulfillment status.
    // A genuinely-cancelled order reads differently (VOIDED / REFUNDED) from an
    // unshipped-but-live one (PENDING / PAID + UNFULFILLED) — this tells us what
    // signal actually marks these, since cancelledAt evidently does not.
    if (new URL(request.url).searchParams.get("by") === "status") {
      const combo: Record<string, number> = {};
      for (const r of rows) {
        const k = `${r.financialStatus || "?"} / ${r.fulfillmentStatus || "?"}`;
        combo[k] = (combo[k] || 0) + 1;
      }
      return json({ ok: true, shop, month: noawbMonth, count: rows.length, byFinancialFulfillment: combo });
    }

    if (new URL(request.url).searchParams.get("format") === "csv") {
      const esc = (v: string) => `"${String(v).replace(/"/g, '""')}"`;
      const csv = [
        "order_name,order_id,created_at,delivery_status",
        ...rows.map((r) =>
          [
            esc(r.orderName),
            esc(r.orderId),
            esc(r.orderCreatedAt.toISOString()),
            esc(r.deliveryStatus),
          ].join(","),
        ),
      ].join("\n");
      return new Response(csv, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="no-awb-${noawbMonth}.csv"`,
        },
      });
    }

    return json({
      ok: true,
      shop,
      month: noawbMonth,
      count: rows.length,
      orders: rows.map((r) => ({
        name: r.orderName,
        createdAt: r.orderCreatedAt.toISOString().slice(0, 10),
        status: r.deliveryStatus,
      })),
    });
  }

  // One-time backfill: reclassify already-stored orders from their financial +
  // fulfillment status, WITHOUT a Shopify resync. VOIDED -> cancelled, PENDING &
  // never-fulfilled -> abandoned. Only touches stuck rows (no-awb/unknown), so a
  // delivered/rto outcome the sheet resolved is never disturbed.
  if (new URL(request.url).searchParams.get("reclassify") === "1") {
    const app = await getPnlApp();
    const shop = app.shopDomain;
    if (!shop) return json({ error: "not-configured" }, { status: 400 });

    const cancelled = await prisma.orderFinancials.updateMany({
      where: {
        shop,
        deliveryStatus: { in: ["no-awb", "unknown"] },
        financialStatus: { equals: "VOIDED", mode: "insensitive" },
      },
      data: { deliveryStatus: "cancelled" },
    });

    const abandoned = await prisma.orderFinancials.updateMany({
      where: {
        shop,
        deliveryStatus: { in: ["no-awb", "unknown"] },
        financialStatus: { equals: "PENDING", mode: "insensitive" },
        NOT: { fulfillmentStatus: { equals: "FULFILLED", mode: "insensitive" } },
      },
      data: { deliveryStatus: "abandoned" },
    });

    return json({
      ok: true,
      shop,
      reclassified: { cancelled: cancelled.count, abandoned: abandoned.count },
    });
  }

  // Read-only: ?order=170499,170505 shows exactly what the P&L stored for named
  // orders — the AWB it captured and the deliveryStatus — to diagnose orders
  // that look delivered in Shopify but read wrong here.
  const orderQ = new URL(request.url).searchParams.get("order");
  if (orderQ) {
    const app = await getPnlApp();
    const shop = app.shopDomain;
    if (!shop) return json({ error: "not-configured" }, { status: 400 });
    const names = orderQ.split(",").map((n) => n.trim()).filter(Boolean);
    const nameVariants = names.flatMap((n) => [n, `#${n}`, n.replace(/^#/, "")]);
    const rows = await prisma.orderFinancials.findMany({
      where: { shop, orderName: { in: Array.from(new Set(nameVariants)) } },
      select: {
        orderName: true,
        awb: true,
        carrier: true,
        deliveryStatus: true,
        shippingStatus: true,
        financialStatus: true,
        fulfillmentStatus: true,
      },
    });
    return json({ ok: true, shop, found: rows.length, orders: rows });
  }

  const results: Record<string, unknown> = {};

  // 1) Standalone P&L app (custom-app token) — this is the one that actually
  //    has order access here. Runs first, self-chunking within its time budget.
  const standaloneApp = await getPnlApp();
  try {
    results["standalone"] = await runStandaloneSync({
      maxPages: 400,
      timeBudgetMs: STANDALONE_TIME_BUDGET_MS,
      shippingLimit: 200,
    });
  } catch (e: any) {
    console.error("[pnl-cron] standalone", String(e?.message || e).slice(0, 200));
    results["standalone"] = { error: true };
  }

  // Delivery status from the published sheet (the authority). Fetch nightly so
  // delivered/RTO stays current without a manual refresh.
  if (standaloneApp.deliverySheetUrl) {
    try {
      const r = await fetchAndApplyDeliverySheet(standaloneApp.shopDomain, standaloneApp.deliverySheetUrl);
      results["deliverySheet"] = r.ok ? { matched: r.matched, delivered: r.delivered, rto: r.rto } : { error: r.reason };
      if (r.ok) {
        await prisma.pnlApp.update({
          where: { id: "default" },
          data: { deliverySheetSyncedAt: new Date(), deliverySheetStatus: `matched ${r.matched}` },
        });
      }
    } catch (e: any) {
      console.error("[pnl-cron] deliverySheet", String(e?.message || e).slice(0, 200));
      results["deliverySheet"] = { error: true };
    }
  }

  // 2) Embedded-app shops (OAuth session). Skip the standalone shop — it's
  //    synced above via its token and its embedded session is PCD-blocked.
  const [enabled, withData] = await Promise.all([
    prisma.pnlSettings.findMany({ where: { isEnabled: true }, select: { shop: true } }),
    prisma.orderFinancials.findMany({ distinct: ["shop"], select: { shop: true } }),
  ]);
  const shops = Array.from(new Set([...enabled, ...withData].map((s) => s.shop))).filter(
    (s) => s !== standaloneApp.shopDomain,
  );

  // Re-sync window: last 3 IST days.
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - 2);
  const since = new Date(ist.getTime() - IST_OFFSET_MS);
  const until = new Date();

  for (const shop of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const rc = await syncRevenueAndCogs(admin, shop, { since, until, maxPages: 20 });
      const bf = await backfillShipping(shop, { limit: 200 });
      await prisma.pnlSettings.upsert({
        where: { shop },
        create: { shop, lastSyncAt: new Date(), lastSyncStatus: "cron ok" },
        update: { lastSyncAt: new Date(), lastSyncStatus: "cron ok" },
      });
      results[shop] = { orders: rc.orders, billed: bf.billed, pending: bf.stillPending };
    } catch (e: any) {
      console.error("[pnl-cron]", shop, String(e?.message || e).slice(0, 200));
      results[shop] = { error: true };
    }
  }

  return json({ ok: true, shops: shops.length, results });
};
