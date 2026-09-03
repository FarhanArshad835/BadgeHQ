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

/**
 * Plain-language definitions shown on hover. Kept in one place so a metric is
 * explained identically wherever it appears, and so the wording can be fixed
 * without hunting through the markup.
 */
const EXPLAIN = {
  grossSale: "Everything ordered this month before any discount, including orders that were later cancelled, returned or never delivered.",
  netSale: "What you actually collected: the value of DELIVERED orders, minus refunds. This is the figure profit is calculated from.",
  refunds: "Money returned to customers this month.",
  cogs: "What the delivered goods cost you, from the cost-per-item set on each Shopify product. Counts delivered orders only — stock from an RTO comes back to you.",
  stocking: "The free item added to orders. It earns no revenue but still costs you, so it is counted here: units on delivered orders × the unit cost set in Settings.",
  shipping: "What the carrier actually billed you for freight. Shows Pending until the carrier bills — never an estimate.",
  advertising: "Ad spend for the month, pulled live from Meta.",
  shopify: "Your Shopify subscription and billing for the month, as invoiced.",
  gstOut: "GST you collected on sales and owe to the government.",
  gstIn: "GST you paid on expenses (freight, ads, overheads) and can claim back.",
  fees: "The flat fee charged on every return and exchange request. Return-fee orders are pure fee; for exchanges only the fee is counted here, because the replacement product is already in Net Sale.",
  delivered: "Orders that reached the customer. Every per-unit figure is divided by this.",
  profit: "Net sale, minus every known cost, plus GST reclaimed and request fees. Shows Pending if any cost is still unknown — a total with a missing cost would be misleading.",
  profitPerPair: "Profit divided by the number of items delivered.",
  placed: "Every order placed this month, whatever happened to it afterwards.",
  rto: "Returned To Origin: shipped but refused or undeliverable, so it came back. You pay freight both ways and earn nothing.",
  cancelled: "Cancelled before dispatch.",
  abandoned: "Never paid for.",
  inTransit: "Still on its way, or the carrier has not reported an outcome yet.",
  deliveredPairs: "Total items (not orders) delivered — an order can contain several.",
  returns: "Return requests raised against this month's orders.",
  exchanges: "Exchange requests raised against this month's orders.",
  resolutionRate: "How much of the month has reached a final outcome (delivered, RTO, or cancelled). Low means the month is still settling and the numbers will move.",
  deliveredShare: "Of everything ordered, the share that actually reached customers, by value. The rest was cancelled, returned or is still in transit.",
  adPerOrder: "Ad spend divided by delivered orders — what it cost in advertising to land one delivered order.",
  freightPerOrder: "Average freight billed per delivered order.",
  cogsPerPair: "Average cost of one delivered item.",
  cogsMatchRate: "How many delivered items had a cost-per-item set in Shopify. Below 97% the COGS figure is withheld rather than guessed.",
} as const;


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

  // The month before the selected one, so every figure can carry its change.
  // Comparison shouldn't be a separate mode you have to know to switch on.
  const prevMonth = months[months.indexOf(month) + 1] ?? null;

  // Month-by-month comparison: compute up to the 6 most recent months in PARALLEL
  // (ad spend is a live Meta call per month, so parallel keeps this ~1 call's time).
  // Opt-in via ?compare=1 so a normal single-month load stays light.
  const compareOn = url.searchParams.get("compare") === "1";
  const compareMonths = compareOn ? months.slice(0, 6) : [];

  const [report, prevReport, compareReports] = await Promise.all([
    shop ? computeMonth(shop, month) : null,
    shop && prevMonth ? computeMonth(shop, prevMonth) : null,
    shop && compareMonths.length ? Promise.all(compareMonths.map((m) => computeMonth(shop, m))) : [],
  ]);
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
  // The comparison columns are editable too, so they need each month's stored
  // inputs to prefill — otherwise filling six months means switching month six
  // times, which is exactly what the comparison view exists to avoid.
  const compareInputs = shop && compareMonths.length
    ? await prisma.pnlMonthlyInput.findMany({ where: { shop, month: { in: compareMonths } } })
    : [];
  const compareInputByMonth = new Map(compareInputs.map((i) => [i.month, i]));

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
  // Zero renders as EMPTY, not "0": these columns default to 0 in the database,
  // and a literal 0 in the field hid the computed figure behind it (the fees row
  // showed 0 instead of its auto value) and read as "already filled in".
  const rupees = (v: bigint | null | undefined) =>
    v == null || v === 0n ? "" : (Number(v) / 100).toString();
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
      overhead: s(r.overheadMinor),
      overheadProvisional: r.overheadProvisional,
      shopifyBilling: s(r.shopifyBillingMinor),
      doubleclickFee: s(r.doubleclickFeeMinor),
      doubleclickSub: s(r.doubleclickSubMinor),
      stocking: s(r.stockingMinor),
      stockingUnits: r.stockingUnits,
      stockingSource: r.stockingSource,
      gstOutput: s(r.gstOutputMinor),
      gstInput: s(r.gstInputMinor),
      netGst: s(r.netGstMinor),
      returnExchangeFees: s(r.returnExchangeFeesMinor),
      returnExchangeFeesSource: r.returnExchangeFeesSource,
      feesAlreadyInNetSale: s(r.feesAlreadyInNetSaleMinor),
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
    // Previous month, for the change shown against each figure.
    prevMonth,
    prevLabel: prevMonth ? (monthLabels[prevMonth] ?? prevMonth) : null,
    prev: prevReport && {
      grossSale: s(prevReport.grossSaleMinor),
      netSale: s(prevReport.netSaleMinor),
      refunds: s(prevReport.refundsMinor),
      cogs: s(prevReport.cogsMinor),
      freight: s(prevReport.freightMinor),
      adSpend: s(prevReport.adSpendMinor),
      netPnl: s(prevReport.netPnlMinor),
      netPnlPerDeliveredPair: s(prevReport.netPnlPerDeliveredPairMinor),
      netPnlPerDeliveredOrder: s(prevReport.netPnlPerDeliveredOrderMinor),
      placedOrders: prevReport.placedOrders,
      deliveredOrders: prevReport.deliveredOrders,
      rtoOrders: prevReport.rtoOrders,
      cancelledOrders: prevReport.cancelledOrders,
      deliveredPairs: prevReport.deliveredPairs,
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
      shopifyBilling: s(c.shopifyBillingMinor),
      // stored inputs, for the editable cells
      inShopifyBilling: rupees(compareInputByMonth.get(c.month)?.shopifyBillingMinor),
      inDoubleclickFee: rupees(compareInputByMonth.get(c.month)?.doubleclickFeeMinor),
      inDoubleclickSub: rupees(compareInputByMonth.get(c.month)?.doubleclickSubMinor),
      inStocking: rupees(compareInputByMonth.get(c.month)?.stockingMinor),
      inFreightOverride: rupees(compareInputByMonth.get(c.month)?.freightOverrideMinor),
      inAdSpendOverride: rupees(compareInputByMonth.get(c.month)?.adSpendOverrideMinor),
      inReturnExchangeFees: rupees(compareInputByMonth.get(c.month)?.returnExchangeFeesMinor),
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
    // Only fields PRESENT in this submission are updated. The comparison view
    // posts a single cell at a time, and treating an absent field as 0 would
    // wipe every other figure for that month.
    const money = (name: string): bigint | null | undefined => {
      if (!form.has(name)) return undefined; // not submitted → leave as-is
      const v = String(form.get(name) || "").trim();
      return v === "" ? null : toMinor(v);
    };
    const data: Record<string, bigint | null> = {};
    // Blank clears back to auto: null for the overrides, 0 for the plain figures.
    const put = (field: string, v: bigint | null | undefined, blankIsNull = false) => {
      if (v === undefined) return;
      data[field] = v === null ? (blankIsNull ? null : 0n) : v;
    };
    put("overheadMinor", money("overhead"));
    put("returnExchangeFeesMinor", money("returnExchangeFees"));
    put("adSpendOverrideMinor", money("adSpendOverride"), true);
    put("freightOverrideMinor", money("freightOverride"), true);
    put("shopifyBillingMinor", money("shopifyBilling"));
    put("doubleclickFeeMinor", money("doubleclickFee"));
    put("doubleclickSubMinor", money("doubleclickSub"));
    put("stockingMinor", money("stocking"));

    await prisma.pnlMonthlyInput.upsert({
      where: { shop_month: { shop: app.shopDomain, month } },
      create: { shop: app.shopDomain, month, ...(data as any) },
      update: data as any,
    });
    return json({ ok: true, message: `Saved inputs for ${month}.` });
  }

  try {
    // A press is worth something on a real backlog: 4 pages/5s was tuned for
    // topping up a synced store and made clicking feel futile against thousands
    // of orders. NOT raised past Vercel's default 10s function timeout: a
    // route-level `export const config` would lift that, but doing so previously
    // broke this kind of route's single-fetch .data endpoint (404 on POST), and
    // the Sync button posts that way. The cron does the heavy lifting anyway.
    const result = await runStandaloneSync({
      maxPages: 12,
      timeBudgetMs: 7_500,
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
  const savingInputs = nav.state === "submitting" && submittingIntent === "save-inputs";
  const syncing =
    nav.state === "submitting" &&
    nav.formMethod === "POST" &&
    submittingIntent !== "save-inputs" &&
    submittingIntent !== "upload-delivery" &&
    submittingIntent !== "fetch-delivery";
  const fetchingDelivery = nav.state === "submitting" && submittingIntent === "fetch-delivery";
  const busy = nav.state !== "idle";
  // A GET navigation (drill-in / month change / compare toggle), as opposed to a
  // form POST which has its own in-button spinner.
  const navigating = nav.state === "loading" && Boolean(nav.location);

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
      {/* Navigation in flight (drill-in, month change, compare): show it. */}
      {navigating && <div className="pnl-progress" key={nav.location?.key} />}
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
            <div className="pnl-section-label">
              Month comparison <span className="pnl-save-note">— highlighted rows are editable; press Enter to save</span>
            </div>
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
                <CmpEditRow label="Shipping Fees" cols={d.compare} name="freightOverride" pick={(c) => c.inFreightOverride} explain={EXPLAIN.shipping} />
                <CmpEditRow label="Advertisement" cols={d.compare} name="adSpendOverride" pick={(c) => c.inAdSpendOverride} explain={EXPLAIN.advertising} />
                <CmpEditRow label="Shopify" cols={d.compare} name="shopifyBilling" pick={(c) => c.inShopifyBilling} explain={EXPLAIN.shopify} />
                <CmpEditRow label="Doubleclick Fee" cols={d.compare} name="doubleclickFee" pick={(c) => c.inDoubleclickFee} />
                <CmpEditRow label="Doubleclick Subscription" cols={d.compare} name="doubleclickSub" pick={(c) => c.inDoubleclickSub} />
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
            {/* One number leads; the rest are explicitly subordinate and each
                carries its change against the previous month. */}
            <div className="pnl-headline">
              <div className="pnl-headline-figure">
                <span className="pnl-headline-label">Net P&amp;L · {monthLabel(d.month)}</span>
                <span className={`pnl-headline-value ${r.netPnl == null ? "pending" : ""}`}>
                  {fmt(r.netPnl, "Pending")}
                </span>
                <span className="pnl-headline-note">
                  {r.netPnl == null
                    ? "Suppressed until every cost is known"
                    : <>{pct(contributionPct(r))} margin{d.prev?.netPnl != null && <> · <Delta now={r.netPnl} was={d.prev.netPnl} fmt={fmt} label={d.prevLabel} /></>}</>}
                </span>
              </div>
              <div className="pnl-supports">
                <Support label="Net sale" value={fmt(r.netSale)} now={r.netSale} was={d.prev?.netSale} fmt={fmt} label2={d.prevLabel} />
                <Support label="Delivered" value={String(r.deliveredOrders)} now={String(r.deliveredOrders)} was={d.prev ? String(d.prev.deliveredOrders) : null} fmt={(v: any) => String(v)} label2={d.prevLabel} plain />
                <Support label="Profit / order" value={fmt(r.netPnlPerDeliveredOrder, "Pending")} now={r.netPnlPerDeliveredOrder} was={d.prev?.netPnlPerDeliveredOrder} fmt={fmt} label2={d.prevLabel} />
                <Support label="Profit / pair" value={fmt(r.netPnlPerDeliveredPair, "Pending")} now={r.netPnlPerDeliveredPair} was={d.prev?.netPnlPerDeliveredPair} fmt={fmt} label2={d.prevLabel} />
              </div>
            </div>

            {/* Wide layout: statement beside the funnel / per-unit panels. */}
            <div className="pnl-main" style={{ marginBottom: 20 }}>
            {/* P&L statement — matches the monthly statement layout: income
                positive, costs negative, P&L and Per Pair at the foot. */}
            <div className="pnl-panel">
              <Form method="post" id="statement-inputs">
              <input type="hidden" name="intent" value="save-inputs" />
              <input type="hidden" name="month" value={d.month} />
              <div className="pnl-section-label">
                {monthLabel(d.month)}{d.prevLabel ? ` · change vs ${d.prevLabel}` : ""}
              </div>
              <table className="pnl-table pnl-waterfall">
                <tbody>
                  <Row label="Gross Sale" explain={EXPLAIN.grossSale} value={fmt(r.grossSale)} strong
                    delta={<Delta now={r.grossSale} was={d.prev?.grossSale} fmt={fmt} label={d.prevLabel} />} />
                  <Row label="Net Sale" explain={EXPLAIN.netSale} value={fmt(r.netSale)} strong hl
                    delta={<Delta now={r.netSale} was={d.prev?.netSale} fmt={fmt} label={d.prevLabel} />} />
                  <Row label="Refund Amount" explain={EXPLAIN.refunds} value={sfmt(r.refunds)} neg
                    delta={<Delta now={r.refunds} was={d.prev?.refunds} fmt={fmt} label={d.prevLabel} goodWhenUp={false} />} />
                  <Row label="Cost of goods (delivered)" explain={EXPLAIN.cogs} value={sfmt(r.cogs)} neg pending={r.cogs == null}
                    delta={<Delta now={r.cogs} was={d.prev?.cogs} fmt={fmt} label={d.prevLabel} goodWhenUp={false} />} />
                  {/* Counted from the delivered lines × the unit cost in Settings.
                      Still typeable, to correct a month by hand. */}
                  <EditRow
                    label={`Stocking${r.stockingUnits > 0 ? ` (${r.stockingUnits.toLocaleString("en-IN")} units)` : ""}`}
                    name="stocking" explain={EXPLAIN.stocking}
                    value={d.monthInput.stocking}
                    auto={r.stockingSource === "auto" ? fmt(r.stocking) : undefined}
                    hint={r.stockingSource === "manual" ? "entered" : undefined}
                  />
                  <EditRow
                    label="Shipping"
                    name="freightOverride"
                    explain={EXPLAIN.shipping}
                    value={d.monthInput.freightOverride}
                    auto={r.freight != null ? fmt(r.freight) : undefined}
                    hint={r.freight == null ? "carriers unresolved" : undefined}
                  />
                  {/* Always editable, resolved or not: a wrong Meta figure was
                      previously uncorrectable because the row went read-only. */}
                  <EditRow
                    label="Advertising"
                    name="adSpendOverride"
                    explain={EXPLAIN.advertising}
                    value={d.monthInput.adSpendOverride}
                    auto={r.adSpend != null ? fmt(r.adSpend) : undefined}
                    hint={r.adSpend == null ? "Meta not connected" : r.adSpendSource === "meta" ? "from Meta" : undefined}
                  />
                  <EditRow label="Shopify (subscription + billing)" name="shopifyBilling" explain={EXPLAIN.shopify} value={d.monthInput.shopifyBilling} />
                  <EditRow label="Doubleclick fee" name="doubleclickFee" value={d.monthInput.doubleclickFee} />
                  <EditRow label="Doubleclick subscription" name="doubleclickSub" value={d.monthInput.doubleclickSub} />
                  <Row label="Shipping per pair" explain={EXPLAIN.freightPerOrder} value={sfmt(r.freightPerDeliveredOrder)} neg pending={r.freightPerDeliveredOrder == null} />
                  <Row label="GST charged (12%)" explain={EXPLAIN.gstOut} value={sfmt(r.gstOutput)} neg pending={r.gstOutput == null} />
                  <Row label="GST reclaimed (18%)" explain={EXPLAIN.gstIn} value={fmt(r.gstInput, "Pending")} pending={r.gstInput == null} />
                  {/* Auto-summed from the fee orders; editable in place only if
                      that figure is disputed, rather than as its own junk row. */}
                  <EditRow
                    label="Return and exchange fees"
                    name="returnExchangeFees"
                    explain={
                      r.feesAlreadyInNetSale && BigInt(r.feesAlreadyInNetSale) > 0n
                        ? `${EXPLAIN.fees} Of this, ${fmt(r.feesAlreadyInNetSale)} sits on exchange orders and is already counted in Net Sale, so profit adds only ${fmt(String(BigInt(r.returnExchangeFees ?? "0") - BigInt(r.feesAlreadyInNetSale)))}.`
                        : EXPLAIN.fees
                    }
                    value={d.monthInput.returnExchangeFees}
                    auto={r.returnExchangeFeesSource !== "manual" ? fmt(r.returnExchangeFees) : undefined}
                    hint={
                      r.feesAlreadyInNetSale && BigInt(r.feesAlreadyInNetSale) > 0n
                        ? `${fmt(r.feesAlreadyInNetSale)} already in Net Sale`
                        : undefined
                    }
                  />
                  <Row label="Orders delivered" explain={EXPLAIN.delivered} value={String(r.deliveredOrders)}
                    delta={<Delta now={String(r.deliveredOrders)} was={d.prev ? String(d.prev.deliveredOrders) : null} fmt={(v: any) => String(v)} label={d.prevLabel} />} />
                  <Row label="Profit" explain={EXPLAIN.profit} value={fmt(r.netPnl, "Pending")} strong hl big
                    delta={<Delta now={r.netPnl} was={d.prev?.netPnl} fmt={fmt} label={d.prevLabel} />} />
                  <Row label="Profit per pair" explain={EXPLAIN.profitPerPair} value={fmt(r.netPnlPerDeliveredPair, "Pending")} pending={r.netPnlPerDeliveredPair == null}
                    delta={<Delta now={r.netPnlPerDeliveredPair} was={d.prev?.netPnlPerDeliveredPair} fmt={fmt} label={d.prevLabel} />} />
                </tbody>
              </table>
              <div className="pnl-save-row">
                <span className="pnl-save-note">Highlighted rows are yours to fill.</span>
                <button type="submit" className="pnl-btn pnl-btn-primary" disabled={busy}>
                  {savingInputs ? "Saving…" : "Save"}
                </button>
              </div>
              </Form>
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
                    <Row label="Placed orders" explain={EXPLAIN.placed} value={String(r.placedOrders)} value2={fmt(r.netPlaced)} />
                    {/* No em-dash prefix: the caret is the indent marker AND shows
                        open/closed. Two markers in one gutter collided. */}
                    <Row label="Delivered" explain={EXPLAIN.delivered} value={String(r.deliveredOrders)} value2={fmt(r.deliveredRevenue)} to={drill("delivered")} active={d.drillStatus === "delivered"} />
                    <Row label="RTO" explain={EXPLAIN.rto} value={String(r.rtoOrders)} value2={fmt(r.rtoRevenue)} to={drill("rto")} active={d.drillStatus === "rto"} />
                    <Row label="Cancelled" explain={EXPLAIN.cancelled} value={String(r.cancelledOrders)} value2={fmt(r.cancelledRevenue)} to={drill("cancelled")} active={d.drillStatus === "cancelled"} />
                    <Row label="Abandoned" explain={EXPLAIN.abandoned} value={String(r.abandonedOrders)} value2={fmt(r.abandonedRevenue)} to={drill("abandoned")} active={d.drillStatus === "abandoned"} />
                    <Row label="In transit / unknown" explain={EXPLAIN.inTransit} value={String(r.inTransitOrders)} value2={fmt(r.inTransitRevenue)} to={drill("intransit")} active={d.drillStatus === "intransit"} />
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
                        <Row label="Returns requested" explain={EXPLAIN.returns} value={String(d.returnhq.returns)} value2={fmt(d.returnhq.returnsValue)} />
                        <Row label="Exchanges requested" explain={EXPLAIN.exchanges} value={String(d.returnhq.exchanges)} value2={fmt(d.returnhq.exchangesValue)} />
                      </>
                    )}
                    <Row label="Resolution rate" explain={EXPLAIN.resolutionRate} value={pct(r.resolutionRate)} value2="" />
                    <Row label="Delivered share of placed" explain={EXPLAIN.deliveredShare} value={pct(r.deliveredShareOfPlaced)} value2="" />
                  </tbody>
                </table>
              </div>
              <div className="pnl-panel">
                <div className="pnl-section-label">Per delivered order / pair</div>
                <table className="pnl-table">
                  <tbody>
                    <Row label="Ad / delivered order" explain={EXPLAIN.adPerOrder} value={fmt(r.adPerDeliveredOrder, "Pending")} />
                    <Row label="Freight / delivered order" explain={EXPLAIN.freightPerOrder} value={fmt(r.freightPerDeliveredOrder, "Pending")} />
                    <Row label="COGS / pair" explain={EXPLAIN.cogsPerPair} value={fmt(r.cogsPerPair, "Pending")} />
                    <Row label="COGS cost-match rate" explain={EXPLAIN.cogsMatchRate} value={pct(r.cogsMatchRate)} />
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



/**
 * A statement line the merchant fills in, edited in place rather than in a
 * separate form: the figure sits where you read it, so there's no hunting for
 * which row was blank. Posts with the enclosing save form.
 */
function EditRow({ label, name, value, hint, auto, explain }: {
  label: string; name: string; value: string; hint?: string; explain?: string;
  /** Computed figure shown as the placeholder: leaving the field blank keeps it. */
  auto?: string;
}) {
  return (
    <tr className="pnl-row-edit">
      <td>
        {explain ? <span className="pnl-explain" title={explain}>{label}</span> : <span>{label}</span>}
        {hint && <span className="pnl-edit-hint"> {hint}</span>}
      </td>
      {/* Same three columns as a static row, so the figures line up down the
          statement instead of the inputs sitting in their own column. */}
      <td className="pnl-num">
        <span className="pnl-edit-wrap">
          <span className="pnl-edit-cur">₹</span>
          {/* Keyed on the saved value: defaultValue is only read when the input
              first mounts, so after a save React kept the old DOM node and the
              field appeared stuck. Changing the key remounts it with the new
              value while still leaving the field uncontrolled to type in. */}
          <input
            key={`${name}:${value}`}
            className="pnl-edit-input"
            type="text"
            inputMode="decimal"
            name={name}
            defaultValue={value}
            placeholder={auto ? auto.replace(/^₹/, "") : "0.00"}
            autoComplete="off"
            aria-label={label}
            title={auto ? `Computed: ${auto}. Type only to override.` : undefined}
          />
        </span>
      </td>
      <td className="pnl-num pnl-delta-cell" />
    </tr>
  );
}

/**
 * Change against the previous month. `goodWhenUp` decides the colour: a rising
 * profit is good, a rising cost is not, so the sign alone can't drive it.
 * Percentages, because the absolute swing means little without the base.
 */
function Delta({ now, was, fmt, label, goodWhenUp = true }: {
  now: string | null | undefined;
  was: string | null | undefined;
  fmt: (v: any, p?: string) => string;
  label?: string | null;
  goodWhenUp?: boolean;
}) {
  if (now == null || was == null) return null;
  const a = Number(BigInt(now));
  const b = Number(BigInt(was));
  if (!isFinite(a) || !isFinite(b) || b === 0) return null;
  const diff = a - b;
  const pctChange = (diff / Math.abs(b)) * 100;
  if (Math.abs(pctChange) < 0.05) {
    return <span className="pnl-delta flat" title={label ? `vs ${label}` : undefined}>no change</span>;
  }
  const rose = diff > 0;
  const good = rose === goodWhenUp;
  return (
    <span
      className={`pnl-delta ${good ? "up" : "down"}`}
      title={label ? `${fmt(was)} in ${label}` : undefined}
    >
      {rose ? "▲" : "▼"} {Math.abs(pctChange).toFixed(pctChange >= 100 ? 0 : 1)}%
    </span>
  );
}

/** A supporting figure beside the headline: quieter, with its own change. */
function Support({ label, value, now, was, fmt, label2, plain, goodWhenUp = true }: {
  label: string; value: string;
  now: string | null | undefined; was: string | null | undefined;
  fmt: (v: any, p?: string) => string;
  label2?: string | null; plain?: boolean; goodWhenUp?: boolean;
}) {
  return (
    <div>
      <div className="pnl-support-label">{label}</div>
      <div className="pnl-support-value">{value}</div>
      <Delta now={now} was={was} fmt={plain ? ((v: any) => String(v)) : fmt} label={label2} goodWhenUp={goodWhenUp} />
    </div>
  );
}

/**
 * A comparison row whose cells are editable, one month per column. Each cell is
 * its own form posting that column's month: a table row can't be wrapped in a
 * single form, and each column saves a different month anyway. Enter submits.
 */
function CmpEditRow({ label, cols, name, pick, explain }: {
  label: string;
  cols: any[];
  name: string;
  pick: (c: any) => string; // the stored input value for this column
  explain?: string;
}) {
  return (
    <tr className="pnl-row-edit">
      <td style={{ whiteSpace: "nowrap" }}>
        {explain ? <span className="pnl-explain" title={explain}>{label}</span> : label}
      </td>
      {cols.map((c) => (
        <td key={c.month} className="pnl-num">
          <Form method="post" replace>
            <input type="hidden" name="intent" value="save-inputs" />
            <input type="hidden" name="month" value={c.month} />
            <span className="pnl-edit-wrap">
              <span className="pnl-edit-cur">₹</span>
              <input
                key={`${name}:${c.month}:${pick(c)}`}
                className="pnl-edit-input"
                type="text"
                inputMode="decimal"
                name={name}
                defaultValue={pick(c)}
                placeholder="0.00"
                autoComplete="off"
                aria-label={`${label}, ${c.label}`}
              />
            </span>
          </Form>
        </td>
      ))}
    </tr>
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

function Row({ label, value, value2, delta, explain, neg, strong, hl, big, pending, to, active }: {
  label: string; value: string; value2?: string;
  delta?: React.ReactNode; // change vs the previous month
  explain?: string; // plain-language definition, shown on hover
  neg?: boolean; strong?: boolean; hl?: boolean; big?: boolean; pending?: boolean;
  to?: string; active?: boolean;
}) {
  return (
    <tr className={`${hl ? "pnl-row-hl" : ""} ${active ? "pnl-row-active" : ""} ${to ? "pnl-row-click" : ""}`}>
      <td className={strong ? "pnl-strong" : ""}>
        {to ? (
          <Link to={to} prefetch="intent" style={{ color: "inherit", textDecoration: "none" }}>
            {explain ? <span className="pnl-explain" title={explain}>{label}</span> : label}
          </Link>
        ) : explain ? (
          <span className="pnl-explain" title={explain}>{label}</span>
        ) : (
          <span>{label}</span>
        )}
      </td>
      <td className={`pnl-num ${strong ? "pnl-strong" : ""} ${neg ? "pnl-neg" : ""} ${pending ? "pnl-pending" : ""}`}
        style={big ? { fontSize: 18, fontWeight: 700 } : undefined}>
        {value}
      </td>
      {/* Always rendered, even when empty: a row with fewer cells than its
          neighbours breaks the column alignment down the whole table. */}
      {value2 !== undefined ? (
        <td className={`pnl-num pnl-muted ${strong ? "pnl-strong" : ""}`}>{value2}</td>
      ) : (
        <td className="pnl-num pnl-delta-cell">{delta ?? null}</td>
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
