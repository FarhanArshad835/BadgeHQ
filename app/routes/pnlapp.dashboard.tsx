import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import prisma from "../db.server";
import { formatMinor } from "../utils/money";
import { getPnlApp, isAuthed, runStandaloneSync } from "../utils/pnl-app.server";
import { computeMonth, unmatchedCostItems } from "../utils/monthly-pnl.server";
import { returnHqCountsForMonth } from "../utils/returnhq.server";
import { toMinor } from "../utils/pnl.server";
import { parseDeliveryCsv, applyDeliveryStatuses, fetchAndApplyDeliverySheet } from "../utils/delivery-import.server";
import { PnlStyles } from "../utils/pnl-styles";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Current IST month as "YYYY-MM". */
function currentIstMonth(): string {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  return `${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Months (newest first) that actually have order data, plus the current month. */
async function availableMonths(shop: string): Promise<string[]> {
  const rows = await prisma.orderFinancials.findMany({
    where: { shop },
    select: { orderCreatedAt: true },
    orderBy: { orderCreatedAt: "desc" },
  });
  const set = new Set<string>([currentIstMonth()]);
  for (const r of rows) {
    const ist = new Date(r.orderCreatedAt.getTime() + IST_OFFSET_MS);
    set.add(`${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, "0")}`);
  }
  return Array.from(set).sort().reverse();
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  const configured = Boolean(app.shopDomain && app.adminToken);

  const months = shop ? await availableMonths(shop) : [currentIstMonth()];
  const url = new URL(request.url);
  const requested = url.searchParams.get("month") || "";
  const month = months.includes(requested) ? requested : months[0];

  // Human labels computed server-side so the client never imports a .server
  // module (importing monthWindowIst into the component breaks the Remix build).
  const labelFor = (m: string) => {
    const [y, mm] = m.split("-").map(Number);
    return new Date(Date.UTC(y, mm - 1, 1)).toLocaleDateString("en-IN", { timeZone: "UTC", month: "long", year: "numeric" });
  };
  const monthLabels: Record<string, string> = {};
  for (const m of months) monthLabels[m] = labelFor(m);

  const report = shop ? await computeMonth(shop, month) : null;

  // Month-by-month comparison: compute up to the 6 most recent months in PARALLEL
  // (ad spend is a live Meta call per month, so parallel keeps this ~1 call's time).
  // Opt-in via ?compare=1 so a normal single-month load stays light.
  const compareOn = url.searchParams.get("compare") === "1";
  const compareMonths = compareOn ? months.slice(0, 6) : [];
  const compareReports = shop && compareMonths.length
    ? await Promise.all(compareMonths.map((m) => computeMonth(shop, m)))
    : [];
  // Delivered items missing cost-per-item (what keeps COGS incomplete). Cap the
  // list so the loader stays light; show a total count alongside.
  const unmatchedAll = shop ? await unmatchedCostItems(shop, month) : [];
  const unmatched = unmatchedAll.slice(0, 100);
  const unmatchedTotal = unmatchedAll.length;
  const unmatchedUnits = unmatchedAll.reduce((s, u) => s + u.units, 0);

  // Returns & exchanges, read live from ReturnHQ's own DB (not Shopify tags, so
  // late-created returns are never missed).
  const returnhqRaw = shop
    ? await returnHqCountsForMonth(month)
    : { returns: 0, exchanges: 0, returnsValueMinor: 0n, exchangesValueMinor: 0n, available: false };
  const monthInput = shop
    ? await prisma.pnlMonthlyInput.findUnique({ where: { shop_month: { shop, month } } })
    : null;

  // Funnel drill-in: ?status=<funnel bucket> lists that month's orders. Each
  // funnel line maps to the underlying deliveryStatus values (some are groups).
  const DRILL: Record<string, string[]> = {
    delivered: ["delivered"],
    rto: ["rto", "rto_in_transit"],
    cancelled: ["cancelled"],
    abandoned: ["abandoned"],
    intransit: ["in_transit", "no-awb", "unknown", "lost"], // the catch-all bucket
  };
  const drillStatus = url.searchParams.get("status") || "";
  let drillOrders: Array<{ name: string; id: string; status: string; created: string }> | null = null;
  if (shop && drillStatus && DRILL[drillStatus]) {
    const [dy, dm] = month.split("-").map(Number);
    const IST = 5.5 * 60 * 60 * 1000;
    const dStart = new Date(Date.UTC(dy, dm - 1, 1) - IST);
    const dEnd = new Date(Date.UTC(dy, dm, 1) - IST);
    const rows = await prisma.orderFinancials.findMany({
      where: { shop, orderCreatedAt: { gte: dStart, lt: dEnd }, deliveryStatus: { in: DRILL[drillStatus] } },
      select: { orderName: true, orderId: true, deliveryStatus: true, orderCreatedAt: true },
      orderBy: { orderCreatedAt: "asc" },
      take: 5000,
    });
    drillOrders = rows.map((o) => ({
      name: o.orderName,
      // Numeric id for the Shopify admin order URL.
      id: o.orderId.replace(/^.*\//, ""),
      status: o.deliveryStatus,
      created: o.orderCreatedAt.toISOString().slice(0, 10),
    }));
  }

  // BigInt → string at the JSON boundary. `s` maps a bigint|null to string|null.
  const s = (v: bigint | null | undefined) => (v == null ? null : v.toString());
  // Rupee string for prefilling inputs (paise → "1234.56").
  const rupees = (v: bigint | null | undefined) => (v == null ? "" : (Number(v) / 100).toString());
  const r = report;

  const lastSyncCount = Number((app.lastSyncStatus.match(/synced (\d+)/i) || [])[1] || 0);

  return json({
    configured,
    months,
    monthLabels,
    month,
    shopDomain: shop || "",
    drillStatus: drillOrders ? drillStatus : "",
    drillOrders,
    currency: "INR",
    lastSyncAt: app.lastSyncAt,
    lastSyncCount,
    metaConnected: Boolean(app.metaAccessToken && app.metaAdAccountId),
    hasDeliverySheet: Boolean(app.deliverySheetUrl),
    monthInput: {
      overhead: rupees(monthInput?.overheadMinor),
      returnExchangeFees: rupees(monthInput?.returnExchangeFeesMinor),
      adSpendOverride: rupees(monthInput?.adSpendOverrideMinor),
      freightOverride: rupees(monthInput?.freightOverrideMinor),
      shopifySubscription: rupees(monthInput?.shopifySubscriptionMinor),
      shopifyBilling: rupees(monthInput?.shopifyBillingMinor),
      doubleclickFee: rupees(monthInput?.doubleclickFeeMinor),
      doubleclickSub: rupees(monthInput?.doubleclickSubMinor),
      stocking: rupees(monthInput?.stockingMinor),
    },
    report: r && {
      publishStatus: r.publishStatus,
      pendingReasons: r.pendingReasons,
      matured: r.matured,
      daysToMaturity: r.daysToMaturity,
      // Revenue block.
      grossSale: s(r.grossSaleMinor),
      discounts: s(r.discountsMinor),
      netPlaced: s(r.netPlacedRevenueMinor),
      cancelledRto: s(r.cancelledRtoRevenueMinor),
      refunds: s(r.refundsMinor),
      netSale: s(r.netSaleMinor),
      // Costs.
      cogs: s(r.cogsMinor),
      freight: s(r.freightMinor),
      adSpend: s(r.adSpendMinor),
      adSpendSource: r.adSpendSource,
      ops: s(r.opsMinor),
      overhead: s(r.overheadMinor),
      overheadProvisional: r.overheadProvisional,
      shopifySubscription: s(r.shopifySubscriptionMinor),
      shopifyBilling: s(r.shopifyBillingMinor),
      doubleclickFee: s(r.doubleclickFeeMinor),
      doubleclickSub: s(r.doubleclickSubMinor),
      stocking: s(r.stockingMinor),
      gstOutput: s(r.gstOutputMinor),
      gstInput: s(r.gstInputMinor),
      netGst: s(r.netGstMinor),
      returnExchangeFees: s(r.returnExchangeFeesMinor),
      returnExchangeFeesSource: r.returnExchangeFeesSource,
      netPnl: s(r.netPnlMinor),
      // Counts + basis.
      placedOrders: r.placedOrders,
      deliveredOrders: r.deliveredOrders,
      rtoOrders: r.rtoOrders,
      cancelledOrders: r.cancelledOrders,
      abandonedOrders: r.abandonedOrders,
      inTransitOrders: r.inTransitOrders,
      deliveredPairs: r.deliveredPairs,
      // Per-bucket order value (for the funnel value column).
      deliveredRevenue: s(r.deliveredRevenueMinor),
      rtoRevenue: s(r.rtoRevenueMinor),
      cancelledRevenue: s(r.cancelledRevenueMinor),
      abandonedRevenue: s(r.abandonedRevenueMinor),
      inTransitRevenue: s(r.inTransitRevenueMinor),
      // Placed value = net placed revenue (already computed above as netPlaced).
      // Per-delivered metrics.
      netPnlPerDeliveredOrder: s(r.netPnlPerDeliveredOrderMinor),
      netPnlPerDeliveredPair: s(r.netPnlPerDeliveredPairMinor),
      adPerDeliveredOrder: s(r.adPerDeliveredOrderMinor),
      freightPerDeliveredOrder: s(r.freightPerDeliveredOrderMinor),
      cogsPerPair: s(r.cogsPerPairMinor),
      // Health.
      resolutionRate: r.resolutionRate,
      deliveredShareOfPlaced: r.deliveredShareOfPlaced,
      cogsMatchRate: r.cogsMatchRate,
    },
    unmatched,
    unmatchedTotal,
    unmatchedUnits,
    returnhq: {
      returns: returnhqRaw.returns,
      exchanges: returnhqRaw.exchanges,
      returnsValue: s(returnhqRaw.returnsValueMinor),
      exchangesValue: s(returnhqRaw.exchangesValueMinor),
      available: returnhqRaw.available,
    },
    // Month-by-month comparison columns (compact: statement + funnel lines only).
    compareOn,
    compare: compareReports.map((c) => ({
      month: c.month,
      label: monthLabels[c.month] ?? c.month,
      // statement
      grossSale: s(c.grossSaleMinor),
      netSale: s(c.netSaleMinor),
      refunds: s(c.refundsMinor),
      cogs: s(c.cogsMinor),
      stocking: s(c.stockingMinor),
      freight: s(c.freightMinor),
      adSpend: s(c.adSpendMinor),
      shopifySubscription: s(c.shopifySubscriptionMinor),
      shopifyBilling: s(c.shopifyBillingMinor),
      doubleclickFee: s(c.doubleclickFeeMinor),
      doubleclickSub: s(c.doubleclickSubMinor),
      gstOutput: s(c.gstOutputMinor),
      gstInput: s(c.gstInputMinor),
      returnExchangeFees: s(c.returnExchangeFeesMinor),
      netPnl: s(c.netPnlMinor),
      netPnlPerDeliveredPair: s(c.netPnlPerDeliveredPairMinor),
      // funnel
      placedOrders: c.placedOrders,
      deliveredOrders: c.deliveredOrders,
      rtoOrders: c.rtoOrders,
      cancelledOrders: c.cancelledOrders,
      abandonedOrders: c.abandonedOrders,
      inTransitOrders: c.inTransitOrders,
      deliveredPairs: c.deliveredPairs,
      netPlaced: s(c.netPlacedRevenueMinor),
      deliveredRevenue: s(c.deliveredRevenueMinor),
      rtoRevenue: s(c.rtoRevenueMinor),
      cancelledRevenue: s(c.cancelledRevenueMinor),
      abandonedRevenue: s(c.abandonedRevenueMinor),
      inTransitRevenue: s(c.inTransitRevenueMinor),
      resolutionRate: c.resolutionRate,
      deliveredShareOfPlaced: c.deliveredShareOfPlaced,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  if (!app.shopDomain || !app.adminToken) {
    return json({ ok: false, message: "Add your Shopify store domain and token in Settings first." }, { status: 400 });
  }

  const form = await request.formData();
  const intent = String(form.get("intent") || "sync");

  // Fetch delivery status directly from the published Google-Sheet CSV URL.
  if (intent === "fetch-delivery") {
    if (!app.deliverySheetUrl) {
      return json({ ok: false, message: "Add the published delivery-sheet CSV URL in Settings first." }, { status: 400 });
    }
    const r = await fetchAndApplyDeliverySheet(app.shopDomain, app.deliverySheetUrl);
    if (!r.ok) return json({ ok: false, message: r.reason }, { status: 400 });
    await prisma.pnlApp.update({
      where: { id: "default" },
      data: { deliverySheetSyncedAt: new Date(), deliverySheetStatus: `matched ${r.matched}` },
    });
    return json({
      ok: true,
      message:
        `Fetched delivery sheet: ${r.parsed} rows (${r.delivered} delivered, ${r.rto} RTO). ` +
        `Updated ${r.matched} orders that changed since last time.`,
    });
  }

  // Import delivery status from the uploaded sheet (the AUTHORITY for delivery
  // outcome). Bulk-set OrderFinancials.deliveryStatus by AWB.
  if (intent === "upload-delivery") {
    const file = form.get("deliveryCsv");
    if (!(file instanceof File) || file.size === 0) {
      return json({ ok: false, message: "Choose a CSV file to upload." }, { status: 400 });
    }
    const text = await file.text();
    const { pairs, totalRows, skipped } = parseDeliveryCsv(text);
    if (!pairs.length) {
      return json({ ok: false, message: `No usable rows found (parsed ${totalRows}, skipped ${skipped}). Expect columns AWB and Delivery Status.` }, { status: 400 });
    }
    const res = await applyDeliveryStatuses(app.shopDomain, pairs);
    return json({
      ok: true,
      message:
        `Imported ${pairs.length} statuses; matched and updated ${res.updated} orders ` +
        `(${res.delivered} delivered, ${res.rto} RTO in the file). Skipped ${skipped} unrecognised rows.`,
    });
  }

  // Save the per-month manual inputs (overhead, fees, optional overrides).
  if (intent === "save-inputs") {
    const month = String(form.get("month") || "");
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return json({ ok: false, message: "Bad month." }, { status: 400 });
    }
    // Parse rupee inputs → paise; blank overrides become null (use the auto value).
    const money = (name: string) => {
      const v = String(form.get(name) || "").trim();
      return v === "" ? null : toMinor(v);
    };
    const overheadMinor = money("overhead") ?? 0n;
    const returnExchangeFeesMinor = money("returnExchangeFees") ?? 0n;
    const adSpendOverrideMinor = money("adSpendOverride");
    const freightOverrideMinor = money("freightOverride");
    const shopifySubscriptionMinor = money("shopifySubscription") ?? 0n;
    const shopifyBillingMinor = money("shopifyBilling") ?? 0n;
    const doubleclickFeeMinor = money("doubleclickFee") ?? 0n;
    const doubleclickSubMinor = money("doubleclickSub") ?? 0n;
    const stockingMinor = money("stocking") ?? 0n;
    const fixed = {
      shopifySubscriptionMinor,
      shopifyBillingMinor,
      doubleclickFeeMinor,
      doubleclickSubMinor,
      stockingMinor,
    };
    await prisma.pnlMonthlyInput.upsert({
      where: { shop_month: { shop: app.shopDomain, month } },
      create: { shop: app.shopDomain, month, overheadMinor, returnExchangeFeesMinor, adSpendOverrideMinor, freightOverrideMinor, ...fixed },
      update: { overheadMinor, returnExchangeFeesMinor, adSpendOverrideMinor, freightOverrideMinor, ...fixed },
    });
    return json({ ok: true, message: `Saved inputs for ${month}.` });
  }

  try {
    const result = await runStandaloneSync({
      maxPages: 4,
      timeBudgetMs: 5_000,
      deliveryLimit: 60, // bulk path (one Shiprocket auth) resolves ~60 AWBs/click
      shippingLimit: 20,
    });
    if ("error" in result) {
      return json({ ok: false, message: "Add your Shopify store domain and token in Settings first." }, { status: 400 });
    }
    const tail = result.done
      ? " Order pull is caught up."
      : " More orders remain; press Sync again, or let the nightly sync finish.";
    return json({
      ok: true,
      message:
        `Pulled ${result.orders} orders; resolved delivery status for this pass ` +
        `(${result.delivered} delivered, ${result.rto} RTO).${tail}`,
    });
  } catch (e: any) {
    const raw = String(e?.message || e);
    const isPcd = /not approved to access the Order|protected-customer-data/i.test(raw);
    return json(
      {
        ok: false,
        message: isPcd
          ? "The token can't read orders. Enable read_orders on the custom app, reinstall, and paste the new token in Settings."
          : "Sync failed: " + raw.slice(0, 200),
      },
      { status: 500 },
    );
  }
};

const DRILL_LABELS: Record<string, string> = {
  delivered: "Delivered",
  rto: "RTO",
  cancelled: "Cancelled",
  abandoned: "Abandoned",
  intransit: "In transit / unknown",
};

export default function PnlDashboard() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  // Distinguish the Sync POST from the save-inputs POST so the progress spinner
  // only shows for an actual sync.
  const submittingIntent = nav.formData?.get("intent");
  const syncing =
    nav.state === "submitting" &&
    nav.formMethod === "POST" &&
    submittingIntent !== "save-inputs" &&
    submittingIntent !== "upload-delivery" &&
    submittingIntent !== "fetch-delivery";
  const fetchingDelivery = nav.state === "submitting" && submittingIntent === "fetch-delivery";
  const busy = nav.state !== "idle";

  // Live progress while a sync runs (client-side, no polling). Eases toward last
  // run's order count, snaps to the real figure when the action returns.
  const [progress, setProgress] = useState(0);
  const targetRef = useRef(0);
  useEffect(() => {
    if (!syncing) return;
    setProgress(0);
    targetRef.current = Math.max(d?.lastSyncCount ?? 0, 25);
    const id = setInterval(() => {
      setProgress((p) => {
        const target = targetRef.current;
        const next = p + Math.max(1, Math.round((target - p) * 0.18));
        return Math.min(next, Math.max(target - 1, p));
      });
    }, 220);
    return () => clearInterval(id);
  }, [syncing, d?.lastSyncCount]);

  if (!d) return null;

  const NIL = "-";
  const fmt = (m: string | null | undefined, p = NIL) => (m == null ? p : formatMinor(BigInt(m), d.currency));
  // Signed money for the statement: renders a cost as a negative figure. Optional
  // `add` sums a second amount into the same line (e.g. Cost Price + stocking).
  const sfmt = (m: string | null | undefined, add?: string | null, p = "Pending") => {
    if (m == null) return p;
    const total = BigInt(m) + (add ? BigInt(add) : 0n);
    if (total === 0n) return formatMinor(0n, d.currency);
    return "-" + formatMinor(total, d.currency);
  };
  const monthLabel = (m: string) => d.monthLabels[m] ?? m;
  const r = d.report;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
  // Funnel drill-in link: same month, toggles the status list open/closed.
  // ABSOLUTE path — this route is explicitly mapped, and a bare "?query" Link
  // resolves its .data fetch wrong here (see the prefix-route note in routes.ts),
  // so clicks silently do nothing.
  const drill = (status: string) =>
    d.drillStatus === status
      ? `/pnl-app/home?month=${d.month}`
      : `/pnl-app/home?month=${d.month}&status=${status}`;

  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <div className="pnl-head">
          <h1 className="pnl-h1">Profit &amp; Loss</h1>
          <div className="pnl-headlinks">
            <a className="pnl-link" href="/pnl-app/settings">Settings</a>
            <a className="pnl-link" href="/pnl-app/logout">Log out</a>
          </div>
        </div>

        {!d.configured && (
          <div className="pnl-banner warn" style={{ marginBottom: 14 }}>
            Connect your store first. Open <a className="pnl-link" href="/pnl-app/settings">Settings</a> and paste your
            Shopify custom-app token. No Shopify approval needed.
          </div>
        )}

        <div className="pnl-controls">
          <select
            className="pnl-select"
            value={d.month}
            onChange={(e) => { const p = new URLSearchParams(searchParams); p.set("month", e.target.value); p.delete("status"); setSearchParams(p); }}
          >
            {d.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
          <button
            type="button"
            className={`pnl-btn ${d.compareOn ? "pnl-btn-primary" : ""}`}
            onClick={() => { const p = new URLSearchParams(searchParams); if (d.compareOn) p.delete("compare"); else p.set("compare", "1"); p.delete("status"); setSearchParams(p); }}
          >
            {d.compareOn ? "Hide comparison" : "Compare months"}
          </button>
          <div className="pnl-controls-right">
            {d.lastSyncAt && (
              <span className="pnl-sub" style={{ fontSize: 13 }}>
                Synced {new Date(d.lastSyncAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            <Form method="post">
              <button type="submit" className="pnl-btn pnl-btn-primary" disabled={busy}>
                {syncing ? (
                  <span className="pnl-btn-busy"><span className="pnl-spinner" aria-hidden="true" />Syncing {progress} orders</span>
                ) : "Sync now"}
              </button>
            </Form>
          </div>
        </div>

        {actionData?.message && (
          <div className={`pnl-banner ${actionData.ok ? "ok" : "bad"}`} style={{ marginBottom: 14 }}>{actionData.message}</div>
        )}

        {r && <StatusBanner report={r} monthLabel={monthLabel(d.month)} />}

        {/* Month-by-month comparison (opt-in). Statement + funnel as columns. */}
        {d.compareOn && d.compare.length > 0 && (
          <div className="pnl-panel" style={{ marginBottom: 20, overflowX: "auto" }}>
            <div className="pnl-section-label">Month comparison</div>
            <table className="pnl-table pnl-compare">
              <thead>
                <tr>
                  <th></th>
                  {d.compare.map((c) => (
                    <th key={c.month} className="pnl-num pnl-strong" style={{ whiteSpace: "nowrap" }}>{c.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <CmpRow label="Gross Sale" cols={d.compare} pick={(c) => fmt(c.grossSale)} strong />
                <CmpRow label="Net Sale" cols={d.compare} pick={(c) => fmt(c.netSale)} strong />
                <CmpRow label="Refund Amount" cols={d.compare} pick={(c) => sfmt(c.refunds)} />
                <CmpRow label="Cost Price + (stocking)" cols={d.compare} pick={(c) => sfmt(c.cogs, c.stocking)} />
                <CmpRow label="Shipping Fees" cols={d.compare} pick={(c) => sfmt(c.freight)} />
                <CmpRow label="Advertisement" cols={d.compare} pick={(c) => sfmt(c.adSpend)} />
                <CmpRow label="Shopify Subscription" cols={d.compare} pick={(c) => sfmt(c.shopifySubscription)} />
                <CmpRow label="Shopify Billing" cols={d.compare} pick={(c) => sfmt(c.shopifyBilling)} />
                <CmpRow label="Doubleclick Fee" cols={d.compare} pick={(c) => sfmt(c.doubleclickFee)} />
                <CmpRow label="Doubleclick Subscription" cols={d.compare} pick={(c) => sfmt(c.doubleclickSub)} />
                <CmpRow label="Gst 12%" cols={d.compare} pick={(c) => sfmt(c.gstOutput)} />
                <CmpRow label="Gst 18% Claim" cols={d.compare} pick={(c) => fmt(c.gstInput, "Pending")} />
                <CmpRow label="Return/Exchange Fees" cols={d.compare} pick={(c) => fmt(c.returnExchangeFees)} />
                <CmpRow label="P&L" cols={d.compare} pick={(c) => fmt(c.netPnl, "Pending")} strong hl />
                <CmpRow label="Per Pair" cols={d.compare} pick={(c) => fmt(c.netPnlPerDeliveredPair, "Pending")} />
                <CmpRow label="—" cols={d.compare} pick={() => ""} />
                <CmpRow label="Placed orders" cols={d.compare} pick={(c) => String(c.placedOrders)} />
                <CmpRow label="Delivered" cols={d.compare} pick={(c) => String(c.deliveredOrders)} />
                <CmpRow label="RTO" cols={d.compare} pick={(c) => `${c.rtoOrders} (${(c.placedOrders ? (c.rtoOrders / c.placedOrders) * 100 : 0).toFixed(1)}%)`} />
                <CmpRow label="Cancelled" cols={d.compare} pick={(c) => String(c.cancelledOrders)} />
                <CmpRow label="Delivered items (pairs)" cols={d.compare} pick={(c) => String(c.deliveredPairs)} />
                <CmpRow label="Resolution rate" cols={d.compare} pick={(c) => pct(c.resolutionRate)} />
              </tbody>
            </table>
          </div>
        )}

        {r && (
          <>
            {/* Headline: net P&L (suppressed if any cost is pending) + per-delivered. */}
            <div className="pnl-kpis" style={{ marginBottom: 20 }}>
              <Kpi label="Net P&L" value={fmt(r.netPnl, "Pending")} accent big
                sub={r.netPnl == null ? "Suppressed until all costs are known" : `${pct(contributionPct(r))} contribution margin`} />
              <Kpi label="Net sale (collected)" value={fmt(r.netSale)} sub={`${r.deliveredOrders} delivered orders`} />
              <Kpi label="Profit / delivered order" value={fmt(r.netPnlPerDeliveredOrder, "Pending")} />
              <Kpi label="Profit / delivered pair" value={fmt(r.netPnlPerDeliveredPair, "Pending")} />
            </div>

            {/* Wide layout: statement beside the funnel / per-unit panels. */}
            <div className="pnl-main" style={{ marginBottom: 20 }}>
            {/* P&L statement — matches the monthly statement layout: income
                positive, costs negative, P&L and Per Pair at the foot. */}
            <div className="pnl-panel">
              <div className="pnl-section-label">P&amp;L statement — {monthLabel(d.month)}</div>
              <table className="pnl-table pnl-waterfall">
                <tbody>
                  <Row label="Gross Sale" value={fmt(r.grossSale)} strong />
                  <Row label="Net Sale" value={fmt(r.netSale)} strong hl />
                  <Row label="Refund Amount" value={sfmt(r.refunds)} neg />
                  <Row label="Cost Price + (stocking)" value={sfmt(r.cogs, r.stocking)} neg pending={r.cogs == null} />
                  <Row label="Shipping Fees" value={sfmt(r.freight)} neg pending={r.freight == null} />
                  <Row label={`Advertisement${r.adSpendSource === "meta" ? " (Meta)" : ""}`} value={sfmt(r.adSpend)} neg pending={r.adSpend == null} />
                  <Row label="Shopify Subscription" value={sfmt(r.shopifySubscription)} neg />
                  <Row label="Shopify Billing" value={sfmt(r.shopifyBilling)} neg />
                  <Row label="Doubleclick Fee" value={sfmt(r.doubleclickFee)} neg />
                  <Row label="Doubleclick Subscription" value={sfmt(r.doubleclickSub)} neg />
                  <Row label="Per Pair Shipping" value={sfmt(r.freightPerDeliveredOrder)} neg pending={r.freightPerDeliveredOrder == null} />
                  <Row label="Gst 12%" value={sfmt(r.gstOutput)} neg pending={r.gstOutput == null} />
                  <Row label="Gst 18% Claim" value={fmt(r.gstInput, "Pending")} pending={r.gstInput == null} />
                  <Row label={`Return/Exchange Fees${r.returnExchangeFeesSource === "manual" ? " (manual)" : ""}`} value={fmt(r.returnExchangeFees)} />
                  <Row label="Delivered" value={String(r.deliveredOrders)} />
                  <Row label="P&L" value={fmt(r.netPnl, "Pending")} strong hl big />
                  <Row label="Per Pair" value={fmt(r.netPnlPerDeliveredPair, "Pending")} pending={r.netPnlPerDeliveredPair == null} />
                </tbody>
              </table>
            </div>

            {/* Delivery funnel + per-unit economics. */}
            <div className="pnl-grid2">
              <div className="pnl-panel">
                <div className="pnl-section-label">Delivery funnel</div>
                <table className="pnl-table">
                  <thead>
                    <tr>
                      <th></th>
                      <th className="pnl-num pnl-muted">Count</th>
                      <th className="pnl-num pnl-muted">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    <Row label="Placed orders" value={String(r.placedOrders)} value2={fmt(r.netPlaced)} />
                    <Row label="— Delivered" value={String(r.deliveredOrders)} value2={fmt(r.deliveredRevenue)} to={drill("delivered")} active={d.drillStatus === "delivered"} />
                    <Row label="— RTO" value={String(r.rtoOrders)} value2={fmt(r.rtoRevenue)} to={drill("rto")} active={d.drillStatus === "rto"} />
                    <Row label="— Cancelled" value={String(r.cancelledOrders)} value2={fmt(r.cancelledRevenue)} to={drill("cancelled")} active={d.drillStatus === "cancelled"} />
                    <Row label="— Abandoned" value={String(r.abandonedOrders)} value2={fmt(r.abandonedRevenue)} to={drill("abandoned")} active={d.drillStatus === "abandoned"} />
                    <Row label="— In transit / unknown" value={String(r.inTransitOrders)} value2={fmt(r.inTransitRevenue)} to={drill("intransit")} active={d.drillStatus === "intransit"} />
                    {/* The five outcome lines sum to Placed by construction. */}
                    <Row
                      label="Delivered items (pairs)"
                      value={String(r.deliveredPairs)}
                      value2=""
                    />
                    {/* Post-delivery: returns/exchanges from ReturnHQ (live). Not
                        part of the placed->outcome sum — a delivered order can be
                        returned later. */}
                    {d.returnhq.available && (
                      <>
                        <Row label="Returns requested" value={String(d.returnhq.returns)} value2={fmt(d.returnhq.returnsValue)} />
                        <Row label="Exchanges requested" value={String(d.returnhq.exchanges)} value2={fmt(d.returnhq.exchangesValue)} />
                      </>
                    )}
                    <Row label="Resolution rate" value={pct(r.resolutionRate)} value2="" />
                    <Row label="Delivered share of placed" value={pct(r.deliveredShareOfPlaced)} value2="" />
                  </tbody>
                </table>
              </div>
              <div className="pnl-panel">
                <div className="pnl-section-label">Per delivered order / pair</div>
                <table className="pnl-table">
                  <tbody>
                    <Row label="Ad / delivered order" value={fmt(r.adPerDeliveredOrder, "Pending")} />
                    <Row label="Freight / delivered order" value={fmt(r.freightPerDeliveredOrder, "Pending")} />
                    <Row label="COGS / pair" value={fmt(r.cogsPerPair, "Pending")} />
                    <Row label="COGS cost-match rate" value={pct(r.cogsMatchRate)} />
                  </tbody>
                </table>
              </div>
            </div>
            </div>

            {/* Delivered items missing cost-per-item — the fixable COGS gap. */}
            {d.unmatchedTotal > 0 && (
              <div className="pnl-panel" style={{ marginTop: 20 }}>
                <div className="pnl-section-label">
                  Delivered items missing cost-per-item — {d.unmatchedTotal} product{d.unmatchedTotal === 1 ? "" : "s"},{" "}
                  {d.unmatchedUnits} unit{d.unmatchedUnits === 1 ? "" : "s"}
                </div>
                <p className="pnl-sub" style={{ marginTop: 0, marginBottom: 12, fontSize: 13 }}>
                  These delivered items have no <strong>Cost per item</strong> set in Shopify, so their COGS is unknown.
                  Set the cost on each variant in Shopify (Products, the variant, Cost per item) and it fills in on the next sync.
                </p>
                <div className="pnl-table-wrap">
                  <table className="pnl-table">
                    <thead>
                      <tr>
                        <th>Product</th>
                        <th>Variant</th>
                        <th className="pnl-num">Units</th>
                        <th className="pnl-num">Lines</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.unmatched.map((u) => (
                        <tr key={u.productId + "|" + u.variantId}>
                          <td>{u.productTitle || <span className="pnl-muted">(no product / deleted)</span>}</td>
                          <td>{u.variantTitle || NIL}</td>
                          <td className="pnl-num">{u.units}</td>
                          <td className="pnl-num">{u.lines}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {d.unmatchedTotal > d.unmatched.length && (
                  <p className="pnl-sub" style={{ marginTop: 10, fontSize: 12 }}>
                    Showing the top {d.unmatched.length} of {d.unmatchedTotal} by units.
                  </p>
                )}
              </div>
            )}

            {/* Funnel drill-in: the orders behind the clicked status line. */}
            {d.drillOrders && (
              <div className="pnl-panel" style={{ marginTop: 20 }}>
                <div className="pnl-section-label">
                  {DRILL_LABELS[d.drillStatus] || d.drillStatus} — {d.drillOrders.length} order
                  {d.drillOrders.length === 1 ? "" : "s"} ({d.monthLabels[d.month] || d.month})
                </div>
                {d.drillOrders.length === 0 ? (
                  <p className="pnl-sub" style={{ marginTop: 0 }}>No orders in this status for the month.</p>
                ) : (
                  <div style={{ maxHeight: 420, overflowY: "auto" }}>
                    <table className="pnl-table">
                      <tbody>
                        {d.drillOrders.map((o) => (
                          <tr key={o.id}>
                            <td>
                              {d.shopDomain ? (
                                <a
                                  href={`https://admin.shopify.com/store/${d.shopDomain.replace(".myshopify.com", "")}/orders/${o.id}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ color: "inherit" }}
                                >
                                  {o.name || o.id}
                                </a>
                              ) : (
                                o.name || o.id
                              )}
                            </td>
                            <td className="pnl-num" style={{ fontSize: 12, opacity: 0.7 }}>{o.status}</td>
                            <td className="pnl-num" style={{ fontSize: 12, opacity: 0.7 }}>{o.created}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Delivery-status — fetched from the published sheet (authority). */}
        {r && (
          <div className="pnl-panel" style={{ marginTop: 20 }}>
            <div className="pnl-section-label">Delivery status (from your tracking sheet)</div>
            <p className="pnl-sub" style={{ marginTop: 0, marginBottom: 12, fontSize: 13 }}>
              Delivered / RTO matched to orders by AWB, across all months. This is the source of truth for delivery outcome.
            </p>
            {d.hasDeliverySheet ? (
              <Form method="post" className="pnl-form">
                <input type="hidden" name="intent" value="fetch-delivery" />
                <button type="submit" className="pnl-btn pnl-btn-primary" style={{ alignSelf: "flex-start" }} disabled={busy}>
                  {fetchingDelivery ? (
                    <span className="pnl-btn-busy"><span className="pnl-spinner" aria-hidden="true" />Fetching sheet… (up to a minute)</span>
                  ) : "Refresh delivery from sheet"}
                </button>
              </Form>
            ) : (
              <p className="pnl-sub" style={{ fontSize: 13 }}>
                Add the published-sheet CSV URL in <a className="pnl-link" href="/pnl-app/settings">Settings</a> to fetch automatically.
                Or upload a CSV below.
              </p>
            )}
            <details style={{ marginTop: 12 }}>
              <summary className="pnl-sub" style={{ fontSize: 13, cursor: "pointer" }}>Upload a CSV instead</summary>
              <Form method="post" encType="multipart/form-data" className="pnl-form" style={{ marginTop: 10 }}>
                <input type="hidden" name="intent" value="upload-delivery" />
                <input className="pnl-input" type="file" name="deliveryCsv" accept=".csv,text/csv" />
                <button type="submit" className="pnl-btn" style={{ marginTop: 12, alignSelf: "flex-start" }} disabled={busy}>
                  Upload &amp; apply
                </button>
              </Form>
            </details>
          </div>
        )}

        {/* Per-month manual inputs (the few numbers no API provides). */}
        {r && (
          <div className="pnl-panel" style={{ marginTop: 20 }}>
            <div className="pnl-section-label">Inputs for {monthLabel(d.month)} (₹)</div>
            <Form method="post" className="pnl-form">
              <input type="hidden" name="intent" value="save-inputs" />
              <input type="hidden" name="month" value={d.month} />
              <div className="pnl-grid2">
                <MoneyField label="Shopify Subscription" name="shopifySubscription" defaultValue={d.monthInput.shopifySubscription} />
                <MoneyField label="Shopify Billing" name="shopifyBilling" defaultValue={d.monthInput.shopifyBilling} />
                <MoneyField label="Doubleclick Fee" name="doubleclickFee" defaultValue={d.monthInput.doubleclickFee} />
                <MoneyField label="Doubleclick Subscription" name="doubleclickSub" defaultValue={d.monthInput.doubleclickSub} />
                <MoneyField label="Stocking (extra inventory bought)" name="stocking" defaultValue={d.monthInput.stocking} />
                <MoneyField label="Return / exchange fees override (blank = auto)" name="returnExchangeFees" defaultValue={d.monthInput.returnExchangeFees} />
                <MoneyField label="Ad spend override (blank = use Meta)" name="adSpendOverride" defaultValue={d.monthInput.adSpendOverride} />
                <MoneyField label="Freight override (blank = use carriers)" name="freightOverride" defaultValue={d.monthInput.freightOverride} />
              </div>
              <div className="pnl-help" style={{ marginTop: 8 }}>
                The four fixed costs sum into the P&amp;L's fixed-cost total and each shows as its own statement row.
              </div>
              <button type="submit" className="pnl-btn" style={{ marginTop: 12, alignSelf: "flex-start" }} disabled={busy}>
                Save month inputs
              </button>
            </Form>
          </div>
        )}

        {r && r.placedOrders === 0 && (
          <div className="pnl-empty">No orders synced for {monthLabel(d.month)} yet. Press <strong>Sync now</strong>.</div>
        )}
      </div>
    </div>
  );
}

function contributionPct(r: any): number {
  if (r.netPnl == null || !r.netSale || BigInt(r.netSale) === 0n) return 0;
  return Number(BigInt(r.netPnl)) / Number(BigInt(r.netSale));
}

function StatusBanner({ report, monthLabel }: { report: any; monthLabel: string }) {
  const tone = report.publishStatus === "final" ? "ok" : report.publishStatus === "provisional" ? "info" : "warn";
  const label = report.publishStatus.toUpperCase();
  return (
    <div className={`pnl-banner ${tone}`} style={{ marginBottom: 18 }}>
      <strong>{monthLabel}: {label}.</strong>{" "}
      {report.publishStatus === "final" && "All costs resolved and the month is matured."}
      {report.publishStatus === "provisional" && (
        report.daysToMaturity > 0
          ? `Not yet matured (${report.daysToMaturity} days to go); numbers may still move as late orders resolve.`
          : "Costs resolved but some inputs are provisional (e.g. overhead not entered)."
      )}
      {report.publishStatus === "pending" && report.pendingReasons.length > 0 && (
        <> Net P&L is suppressed until these are known: {report.pendingReasons.join("; ")}.</>
      )}
    </div>
  );
}

function MoneyField({ label, name, defaultValue }: { label: string; name: string; defaultValue: string }) {
  return (
    <label className="pnl-field">
      <span className="pnl-field-label">{label}</span>
      <input className="pnl-input" type="text" inputMode="decimal" name={name} defaultValue={defaultValue} placeholder="0.00" autoComplete="off" />
    </label>
  );
}

function Kpi({ label, value, sub, accent, big }: { label: string; value: string; sub?: string; accent?: boolean; big?: boolean }) {
  return (
    <div className={`pnl-kpi${accent ? " accent" : ""}`}>
      <div className="pnl-kpi-label">{label}</div>
      <div className="pnl-kpi-value" style={big ? { fontSize: 26 } : undefined}>{value}</div>
      {sub && <div className="pnl-kpi-sub">{sub}</div>}
    </div>
  );
}

// One comparison row: a label plus one cell per month column.
function CmpRow({ label, cols, pick, strong, hl }: {
  label: string;
  cols: any[];
  pick: (c: any) => string;
  strong?: boolean;
  hl?: boolean;
}) {
  return (
    <tr className={hl ? "pnl-row-hl" : ""}>
      <td className={strong ? "pnl-strong" : ""} style={{ whiteSpace: "nowrap" }}>{label === "—" ? " " : label}</td>
      {cols.map((c, i) => (
        <td key={i} className={`pnl-num ${strong ? "pnl-strong" : ""}`}>{pick(c)}</td>
      ))}
    </tr>
  );
}

function Row({ label, value, value2, neg, strong, hl, big, pending, to, active }: {
  label: string; value: string; value2?: string; neg?: boolean; strong?: boolean; hl?: boolean; big?: boolean; pending?: boolean;
  to?: string; active?: boolean;
}) {
  return (
    <tr className={`${hl ? "pnl-row-hl" : ""} ${active ? "pnl-row-active" : ""}`}>
      <td className={strong ? "pnl-strong" : ""}>
        {to ? (
          <Link to={to} prefetch="intent" style={{ color: "inherit", textDecoration: active ? "underline" : "none" }}>
            {label}
          </Link>
        ) : (
          label
        )}
      </td>
      <td className={`pnl-num ${strong ? "pnl-strong" : ""} ${neg ? "pnl-neg" : ""} ${pending ? "pnl-pending" : ""}`}
        style={big ? { fontSize: 18, fontWeight: 700 } : undefined}>
        {value}
      </td>
      {value2 !== undefined && (
        <td className={`pnl-num pnl-muted ${strong ? "pnl-strong" : ""}`}>
          {value2}
        </td>
      )}
    </tr>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
    ? error.message
    : "Unknown error";
  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <div className="pnl-panel" style={{ marginTop: 40 }}>
          <h1 className="pnl-h1" style={{ fontSize: 20 }}>Something went wrong</h1>
          <p className="pnl-sub" style={{ marginTop: 8 }}>{detail}</p>
          <div style={{ marginTop: 16, display: "flex", gap: 10 }}>
            <a className="pnl-btn pnl-btn-primary" href="/pnl-app/home">Reload</a>
            <a className="pnl-link" href="/pnl-app/login">Log in again</a>
          </div>
        </div>
      </div>
    </div>
  );
}
