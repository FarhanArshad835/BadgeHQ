import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData, useNavigation, useSearchParams, useRouteError, isRouteErrorResponse } from "@remix-run/react";
import { useEffect, useRef, useState } from "react";
import prisma from "../db.server";
import { rollup, completeness, type OrderRow } from "../utils/pnl.server";
import { syncRevenueAndCogs, backfillShipping } from "../utils/pnl-sync.server";
import { formatMinor } from "../utils/money";
import { getPnlApp, isAuthed, tokenAdmin } from "../utils/pnl-app.server";
import { PnlStyles } from "../utils/pnl-styles";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function istDayStart(daysAgo: number): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - daysAgo);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}
const WINDOWS: Record<string, { label: string; since: () => Date }> = {
  today: { label: "Today", since: () => istDayStart(0) },
  "7d": { label: "Last 7 days", since: () => istDayStart(6) },
  "30d": { label: "Last 30 days", since: () => istDayStart(29) },
  "90d": { label: "Last 90 days", since: () => istDayStart(89) },
};

// Headroom for the bounded on-click sync (a ~7s sync budget + backfill pacing).
// It only bills for time actually used; the budget keeps that to ~10s.
export const config = { maxDuration: 60 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  const configured = Boolean(app.shopDomain && app.adminToken);

  const url = new URL(request.url);
  const requested = url.searchParams.get("window") || "";
  const windowKey = WINDOWS[requested] ? requested : "7d";
  const since = WINDOWS[windowKey].since();

  const orders = shop
    ? await prisma.orderFinancials.findMany({
        where: { shop, orderCreatedAt: { gte: since } },
        orderBy: { orderCreatedAt: "desc" },
      })
    : [];

  const rows: OrderRow[] = orders.map((o) => ({
    orderCreatedAt: o.orderCreatedAt,
    grossRevenueMinor: o.grossRevenueMinor,
    refundsMinor: o.refundsMinor,
    cogsMinor: o.cogsMinor,
    cogsComplete: o.cogsComplete,
    shippingCostMinor: o.shippingCostMinor,
    shippingStatus: o.shippingStatus,
    dataComplete: o.dataComplete,
  }));
  const agg = rollup(rows);
  const comp = completeness(rows);
  const currency = orders[0]?.currency || "INR";

  const lines = shop
    ? await prisma.orderLineFinancials.findMany({ where: { shop, orderCreatedAt: { gte: since } } })
    : [];
  const productMap = new Map<string, { title: string; units: number; revenue: bigint; cogs: bigint; cogsComplete: boolean }>();
  for (const l of lines) {
    const key = l.productId || l.productTitle || "unknown";
    const p = productMap.get(key) || { title: l.productTitle || "(untitled)", units: 0, revenue: 0n, cogs: 0n, cogsComplete: true };
    p.units += l.quantity;
    p.revenue += l.lineRevenueMinor;
    if (l.lineCogsMinor != null) p.cogs += l.lineCogsMinor;
    if (!l.lineCogsComplete) p.cogsComplete = false;
    productMap.set(key, p);
  }
  const products = Array.from(productMap.values())
    .map((p) => ({
      title: p.title,
      units: p.units,
      revenue: p.revenue.toString(),
      cogs: p.cogsComplete ? p.cogs.toString() : null,
      margin: p.cogsComplete ? (p.revenue - p.cogs).toString() : null,
    }))
    .sort((a, b) => Number(BigInt(b.margin ?? "0") - BigInt(a.margin ?? "0")));

  // Anchor for the live progress counter: how many orders the last sync touched.
  // Parsed from the "synced N orders" status string; 0 on a first-ever run.
  const lastSyncCount = Number((app.lastSyncStatus.match(/synced (\d+)/i) || [])[1] || 0);

  return json({
    configured,
    windowKey,
    currency,
    lastSyncAt: app.lastSyncAt,
    lastSyncCount,
    kpis: {
      orders: agg.orders,
      revenue: agg.revenueMinor.toString(),
      refunds: agg.refundsMinor.toString(),
      cogs: agg.cogsMinor.toString(),
      shipping: agg.shippingMinor.toString(),
      confirmed: agg.confirmedMarginMinor.toString(),
      provisional: agg.provisionalMarginMinor.toString(),
    },
    completeness: comp,
    perOrder: orders.slice(0, 200).map((o) => ({
      name: o.orderName,
      at: o.orderCreatedAt,
      revenue: o.grossRevenueMinor.toString(),
      cogs: o.cogsMinor != null ? o.cogsMinor.toString() : null,
      shipping: o.shippingCostMinor != null ? o.shippingCostMinor.toString() : null,
      shippingStatus: o.shippingStatus,
      margin:
        o.dataComplete && o.cogsMinor != null && o.shippingCostMinor != null
          ? (o.grossRevenueMinor - o.refundsMinor - o.cogsMinor - o.shippingCostMinor).toString()
          : null,
    })),
    perProduct: products.slice(0, 200),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  if (!app.shopDomain || !app.adminToken) {
    return json({ ok: false, message: "Add your Shopify store domain and token in Settings first." }, { status: 400 });
  }
  const form = await request.formData();
  const windowKey = String(form.get("window") || "7d");
  const since = (WINDOWS[windowKey] || WINDOWS["7d"]).since();
  const until = new Date();

  try {
    const admin = tokenAdmin(app.shopDomain, app.adminToken);
    // Bounded on-click sync: a store can do thousands of orders in a window, which
    // can't finish in one serverless request and would run up Neon compute. So we
    // sync at most a few pages within a short time budget (always returns in
    // time, touches Neon only briefly). If there's more, the nightly cron — which
    // chunks and resumes across runs — finishes the rest. Writes are batched.
    const rc = await syncRevenueAndCogs(admin, app.shopDomain, {
      since,
      until,
      maxPages: 6,
      timeBudgetMs: 7_000,
    });
    const bf = await backfillShipping(app.shopDomain, {
      limit: 40,
      carrier: {
        shiprocketEmail: app.shiprocketEmail,
        shiprocketPassword: app.shiprocketPassword,
        delhiveryApiKey: app.delhiveryApiKey,
      },
    });
    await prisma.pnlApp.update({
      where: { id: "default" },
      data: { lastSyncAt: new Date(), lastSyncStatus: `synced ${rc.orders} orders` },
    });
    const tail = rc.done
      ? ` Shipping billed for ${bf.billed}, ${bf.stillPending} pending.`
      : " More orders remain; the nightly sync will finish the rest (or press Sync again).";
    return json({ ok: true, message: `Synced ${rc.orders} orders this pass.${tail}` });
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
  const [tab, setTab] = useState<"glance" | "orders" | "products">("glance");
  const busy = nav.state !== "idle";
  // A sync is the only POST on this page; a window switch is a GET navigation.
  const syncing = nav.state === "submitting" && nav.formMethod === "POST";

  // Live progress while a sync runs. There's no server round-trip to poll (that
  // would bill an invocation per tick), so we count up smoothly toward last
  // run's order count as a target, then snap to the true figure when the action
  // returns. The number is labelled "about" so it never reads as exact mid-run.
  const [progress, setProgress] = useState(0);
  const targetRef = useRef(0);
  useEffect(() => {
    if (!syncing) return;
    setProgress(0);
    // Aim at last run's count; if unknown, a gentle default so the bar still moves.
    targetRef.current = Math.max(d?.lastSyncCount ?? 0, 25);
    const id = setInterval(() => {
      setProgress((p) => {
        const target = targetRef.current;
        // Ease toward the target and hold just short of it until the real result
        // lands, so we never claim "done" before the server actually is.
        const next = p + Math.max(1, Math.round((target - p) * 0.18));
        return Math.min(next, Math.max(target - 1, p));
      });
    }, 220);
    return () => clearInterval(id);
  }, [syncing, d?.lastSyncCount]);

  // Loader data can momentarily be null (e.g. the loader redirected to /login
  // after the session expired, while this component is mid-transition). Every
  // line below dereferences `d`, so bail out rather than crash — the redirect
  // navigation is already in flight.
  if (!d) return null;

  // Null-value marker for empty cells. A plain hyphen, not an em dash.
  const NIL = "-";
  const fmt = (m: string | null, p = NIL) => (m == null ? p : formatMinor(BigInt(m), d.currency));
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
  const k = d.kpis;
  const c = d.completeness;
  const bannerTone = c.pct >= 90 ? "ok" : c.pct >= 60 ? "info" : "warn";

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
            value={d.windowKey}
            onChange={(e) => { const p = new URLSearchParams(searchParams); p.set("window", e.target.value); setSearchParams(p); }}
          >
            {Object.entries(WINDOWS).map(([v, w]) => <option key={v} value={v}>{w.label}</option>)}
          </select>
          <div className="pnl-controls-right">
            {d.lastSyncAt && (
              <span className="pnl-sub" style={{ fontSize: 13 }}>
                Synced {new Date(d.lastSyncAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            <Form method="post">
              <input type="hidden" name="window" value={d.windowKey} />
              <button type="submit" className="pnl-btn pnl-btn-primary" disabled={busy}>
                {syncing ? (
                  <span className="pnl-btn-busy">
                    <span className="pnl-spinner" aria-hidden="true" />
                    Syncing {progress} orders
                  </span>
                ) : (
                  "Sync now"
                )}
              </button>
            </Form>
          </div>
        </div>

        {actionData?.message && (
          <div className={`pnl-banner ${actionData.ok ? "ok" : "bad"}`} style={{ marginBottom: 14 }}>{actionData.message}</div>
        )}

        <div className={`pnl-banner ${bannerTone}`} style={{ marginBottom: 22 }}>
          Cost data complete for <strong>{c.pct}%</strong> of orders ({c.fullyComplete}/{c.total}).
          {c.total - c.shippingBilled > 0 && ` Shipping pending on ${c.total - c.shippingBilled}.`}
          {c.total - c.cogsComplete > 0 && ` Cost per item missing on ${c.total - c.cogsComplete}.`}
          {" "}Costs are never estimated; anything not yet known is left blank.
        </div>

        <div className="pnl-tabs">
          {(["glance", "orders", "products"] as const).map((t) => (
            <button key={t} className="pnl-tab" data-active={tab === t} onClick={() => setTab(t)}>
              {t === "glance" ? "At a glance" : t === "orders" ? "Per order" : "Per product"}
            </button>
          ))}
        </div>

        {tab === "glance" && (
          <div>
            <div className="pnl-kpis">
              <Kpi label="Revenue" value={fmt(k.revenue)} />
              <Kpi label="Refunds" value={"-" + fmt(k.refunds)} neg />
              <Kpi label="COGS" value={"-" + fmt(k.cogs)} neg />
              <Kpi label="Shipping (actual)" value={"-" + fmt(k.shipping)} neg />
              <Kpi label="Confirmed margin" value={fmt(k.confirmed)} headline />
              <Kpi label="Provisional margin" value={fmt(k.provisional)} />
            </div>
            <p className="pnl-note">
              <strong>Confirmed margin</strong> counts only orders whose COGS and shipping are both known.
              {" "}<strong>Provisional</strong> uses all orders with the costs known so far (pending costs are absent, never
              estimated), so it reads high until shipping bills. Ad spend is excluded in Phase&nbsp;1.
            </p>
          </div>
        )}

        {tab === "orders" && (
          <Table
            headers={["Order", "Date", "Revenue", "COGS", "Shipping", "Margin"]}
            numeric={[false, false, true, true, true, true]}
            rows={d.perOrder.map((o) => [
              o.name || NIL,
              fmtDate(o.at as unknown as string),
              fmt(o.revenue),
              o.cogs == null ? pill("attn", "Set cost") : fmt(o.cogs),
              o.shipping != null
                ? fmt(o.shipping)
                : o.shippingStatus === "no-awb"
                ? pill("none", "No AWB")
                : o.shippingStatus === "unmatched"
                ? pill("attn", "Unmatched")
                : pill("pending", "Pending"),
              o.margin == null ? <span className="pnl-muted">{NIL}</span> : marginCell(o.margin, fmt),
            ])}
          />
        )}

        {tab === "products" && (
          <div>
            <p className="pnl-note" style={{ marginBottom: 12 }}>
              Margin per product, <strong>before shipping and ad spend</strong> (shipping is charged per order, not per
              item). Sorted by total margin.
            </p>
            <Table
              headers={["Product", "Units", "Revenue", "COGS", "Margin (ex-shipping)"]}
              numeric={[false, true, true, true, true]}
              rows={d.perProduct.map((p) => [
                p.title,
                String(p.units),
                fmt(p.revenue),
                p.cogs == null ? pill("attn", "Set cost") : fmt(p.cogs),
                p.margin == null ? <span className="pnl-muted">{NIL}</span> : marginCell(p.margin, fmt),
              ])}
            />
          </div>
        )}

        {c.total === 0 && d.configured && (
          <div className="pnl-empty">No orders synced for this period yet. Press <strong>Sync now</strong>.</div>
        )}
      </div>
    </div>
  );
}

function pill(kind: "pending" | "none" | "attn", text: string) {
  return <span className={`pnl-pill ${kind}`}>{text}</span>;
}
function marginCell(minor: string, fmt: (m: string | null) => string) {
  const positive = BigInt(minor) >= 0n;
  return <span className={positive ? "pnl-pos" : "pnl-negv"}>{fmt(minor)}</span>;
}

function Kpi({ label, value, neg, headline }: { label: string; value: string; neg?: boolean; headline?: boolean }) {
  return (
    <div className={`pnl-kpi${headline ? " headline" : ""}`}>
      <div className="pnl-kpi-label">{label}</div>
      <div className={`pnl-kpi-value${neg ? " neg" : ""}`}>{value}</div>
    </div>
  );
}

function Table({ headers, rows, numeric }: { headers: string[]; rows: React.ReactNode[][]; numeric: boolean[] }) {
  return (
    <div className="pnl-table-wrap">
      <table className="pnl-table">
        <thead>
          <tr>{headers.map((h, i) => <th key={h} className={numeric[i] ? "pnl-num" : ""}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} className="pnl-muted">Nothing yet.</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j} className={numeric[j] ? "pnl-num" : ""}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Show a readable message (and the real error) instead of the bare root error
// page if the loader/action ever throws, so a hiccup doesn't look like a 404.
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
            <a className="pnl-btn pnl-btn-primary" href="/pnl-app">Reload</a>
            <a className="pnl-link" href="/pnl-app/login">Log in again</a>
          </div>
        </div>
      </div>
    </div>
  );
}
