import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import prisma from "../db.server";
import { formatMinor } from "../utils/money";
import { getPnlApp, isAuthed, runStandaloneSync } from "../utils/pnl-app.server";
import { computeMonth, monthWindowIst } from "../utils/monthly-pnl.server";
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

  const report = shop ? await computeMonth(shop, month) : null;

  // BigInt → string at the JSON boundary. `s` maps a bigint|null to string|null.
  const s = (v: bigint | null | undefined) => (v == null ? null : v.toString());
  const r = report;

  const lastSyncCount = Number((app.lastSyncStatus.match(/synced (\d+)/i) || [])[1] || 0);

  return json({
    configured,
    months,
    month,
    currency: "INR",
    lastSyncAt: app.lastSyncAt,
    lastSyncCount,
    metaConnected: Boolean(app.metaAccessToken && app.metaAdAccountId),
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
      gstOutput: s(r.gstOutputMinor),
      gstInput: s(r.gstInputMinor),
      netGst: s(r.netGstMinor),
      returnExchangeFees: s(r.returnExchangeFeesMinor),
      netPnl: s(r.netPnlMinor),
      // Counts + basis.
      placedOrders: r.placedOrders,
      deliveredOrders: r.deliveredOrders,
      rtoOrders: r.rtoOrders,
      inTransitOrders: r.inTransitOrders,
      deliveredPairs: r.deliveredPairs,
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
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  if (!app.shopDomain || !app.adminToken) {
    return json({ ok: false, message: "Add your Shopify store domain and token in Settings first." }, { status: 400 });
  }
  try {
    const result = await runStandaloneSync({
      maxPages: 6,
      timeBudgetMs: 7_000,
      deliveryLimit: 8,
      shippingLimit: 20,
    });
    if ("error" in result) {
      return json({ ok: false, message: "Add your Shopify store domain and token in Settings first." }, { status: 400 });
    }
    const tail = result.done
      ? " All caught up."
      : " More orders remain; press Sync again to continue, or let the nightly sync finish.";
    return json({
      ok: true,
      message: `Synced ${result.orders} more orders (${result.delivered} delivered, ${result.rto} RTO this pass).${tail}`,
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

export default function PnlDashboard() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const nav = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const syncing = nav.state === "submitting" && nav.formMethod === "POST";
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
  const monthLabel = (m: string) => {
    const { start } = monthWindowIst(m);
    return new Date(start.getTime() + IST_OFFSET_MS).toLocaleDateString("en-IN", {
      timeZone: "UTC",
      month: "long",
      year: "numeric",
    });
  };
  const r = d.report;
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

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
            onChange={(e) => { const p = new URLSearchParams(searchParams); p.set("month", e.target.value); setSearchParams(p); }}
          >
            {d.months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
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

            {/* The waterfall. */}
            <div className="pnl-panel" style={{ marginBottom: 20 }}>
              <div className="pnl-section-label">The waterfall</div>
              <table className="pnl-table pnl-waterfall">
                <tbody>
                  <Row label="Gross sale (pre-discount)" value={fmt(r.grossSale)} />
                  <Row label="less Discounts" value={fmt(r.discounts)} neg />
                  <Row label="Net placed revenue" value={fmt(r.netPlaced)} strong />
                  <Row label="less Cancelled + RTO" value={fmt(r.cancelledRto)} neg />
                  <Row label="less Refunds" value={fmt(r.refunds)} neg />
                  <Row label="Net sale (collected)" value={fmt(r.netSale)} strong hl />
                  <Row label="less COGS (delivered units)" value={fmt(r.cogs, "Pending")} neg pending={r.cogs == null} />
                  <Row label="less Freight (deduped)" value={fmt(r.freight, "Pending")} neg pending={r.freight == null} />
                  <Row label={`less Ad spend${r.adSpendSource === "meta" ? " (Meta)" : ""}`} value={fmt(r.adSpend, "Pending")} neg pending={r.adSpend == null} />
                  <Row label="less Operations (₹/pair)" value={fmt(r.ops)} neg />
                  <Row label={`less Overhead${r.overheadProvisional ? " (provisional)" : ""}`} value={fmt(r.overhead)} neg />
                  <Row label="plus Net GST (ITC − output)" value={fmt(r.netGst, "Pending")} pending={r.netGst == null} />
                  <Row label="plus Return/exchange fees" value={fmt(r.returnExchangeFees)} />
                  <Row label="NET P&L" value={fmt(r.netPnl, "Pending")} strong hl big />
                </tbody>
              </table>
            </div>

            {/* Delivery funnel + per-unit economics. */}
            <div className="pnl-grid2">
              <div className="pnl-panel">
                <div className="pnl-section-label">Delivery funnel</div>
                <table className="pnl-table">
                  <tbody>
                    <Row label="Placed orders" value={String(r.placedOrders)} />
                    <Row label="Delivered" value={String(r.deliveredOrders)} />
                    <Row label="RTO" value={String(r.rtoOrders)} />
                    <Row label="In transit / unknown" value={String(r.inTransitOrders)} />
                    <Row label="Delivered pairs" value={String(r.deliveredPairs)} />
                    <Row label="Resolution rate" value={pct(r.resolutionRate)} />
                    <Row label="Delivered share of placed" value={pct(r.deliveredShareOfPlaced)} />
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
          </>
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

function Kpi({ label, value, sub, accent, big }: { label: string; value: string; sub?: string; accent?: boolean; big?: boolean }) {
  return (
    <div className={`pnl-kpi${accent ? " accent" : ""}`}>
      <div className="pnl-kpi-label">{label}</div>
      <div className="pnl-kpi-value" style={big ? { fontSize: 26 } : undefined}>{value}</div>
      {sub && <div className="pnl-kpi-sub">{sub}</div>}
    </div>
  );
}

function Row({ label, value, neg, strong, hl, big, pending }: {
  label: string; value: string; neg?: boolean; strong?: boolean; hl?: boolean; big?: boolean; pending?: boolean;
}) {
  return (
    <tr className={hl ? "pnl-row-hl" : ""}>
      <td className={strong ? "pnl-strong" : ""}>{label}</td>
      <td className={`pnl-num ${strong ? "pnl-strong" : ""} ${neg ? "pnl-neg" : ""} ${pending ? "pnl-pending" : ""}`}
        style={big ? { fontSize: 18, fontWeight: 700 } : undefined}>
        {value}
      </td>
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
