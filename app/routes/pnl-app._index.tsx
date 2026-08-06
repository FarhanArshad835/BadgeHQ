import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import prisma from "../db.server";
import { rollup, completeness, type OrderRow } from "../utils/pnl.server";
import { syncRevenueAndCogs, backfillShipping } from "../utils/pnl-sync.server";
import { formatMinor } from "../utils/money";
import { getPnlApp, isAuthed, tokenAdmin } from "../utils/pnl-app.server";

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

  return json({
    configured,
    windowKey,
    currency,
    lastSyncAt: app.lastSyncAt,
    lastSyncStatus: app.lastSyncStatus,
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
    const rc = await syncRevenueAndCogs(admin, app.shopDomain, { since, until, maxPages: 20 });
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
    return json({ ok: true, message: `Synced ${rc.orders} orders. Shipping billed for ${bf.billed}, ${bf.stillPending} pending.` });
  } catch (e: any) {
    const raw = String(e?.message || e);
    const isPcd = /not approved to access the Order|protected-customer-data/i.test(raw);
    return json(
      {
        ok: false,
        message: isPcd
          ? "The token can't read orders — enable read_orders on the custom app, reinstall, and paste the new token in Settings."
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
  const fmt = (m: string | null, p = "—") => (m == null ? p : formatMinor(BigInt(m), d.currency));
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });
  const k = d.kpis;
  const c = d.completeness;

  return (
    <div style={st.page}>
      <div style={st.wrap}>
        <div style={st.topbar}>
          <h1 style={st.h1}>Profit &amp; Loss</h1>
          <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
            <Link to="/pnl-app/settings" style={st.link}>Settings</Link>
            <Link to="/pnl-app/logout" style={st.link}>Log out</Link>
          </div>
        </div>

        {!d.configured && (
          <div style={st.warn}>
            Connect your store first — go to <Link to="/pnl-app/settings" style={st.linkB}>Settings</Link> and paste
            your Shopify custom-app token. No Shopify approval needed.
          </div>
        )}

        <div style={st.controls}>
          <select
            value={d.windowKey}
            onChange={(e) => { const p = new URLSearchParams(searchParams); p.set("window", e.target.value); setSearchParams(p); }}
            style={st.select}
          >
            {Object.entries(WINDOWS).map(([v, w]) => <option key={v} value={v}>{w.label}</option>)}
          </select>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            {d.lastSyncAt && <span style={st.subtle}>Last synced {new Date(d.lastSyncAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}</span>}
            <Form method="post">
              <input type="hidden" name="window" value={d.windowKey} />
              <button type="submit" style={st.primary} disabled={busy}>{busy ? "Syncing…" : "Sync now"}</button>
            </Form>
          </div>
        </div>

        {actionData?.message && (
          <div style={{ ...st.banner, background: actionData.ok ? "#e3f1df" : "#fbeae5" }}>{actionData.message}</div>
        )}

        <div style={{ ...st.banner, background: c.pct >= 90 ? "#e3f1df" : c.pct >= 60 ? "#f1f8ff" : "#fff5ea" }}>
          Cost data complete for <strong>{c.pct}%</strong> of orders ({c.fullyComplete}/{c.total}).
          {c.total - c.shippingBilled > 0 && ` Shipping pending on ${c.total - c.shippingBilled}.`}
          {c.total - c.cogsComplete > 0 && ` Cost-per-item missing on ${c.total - c.cogsComplete}.`}
          {" "}Costs are never estimated — pending shows as “—”.
        </div>

        <div style={st.tabs}>
          {(["glance", "orders", "products"] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} style={{ ...st.tab, ...(tab === t ? st.tabActive : {}) }}>
              {t === "glance" ? "At a glance" : t === "orders" ? "Per order" : "Per product"}
            </button>
          ))}
        </div>

        {tab === "glance" && (
          <div>
            <div style={st.kpiGrid}>
              <Kpi label="Revenue" value={fmt(k.revenue)} />
              <Kpi label="Refunds" value={"-" + fmt(k.refunds)} />
              <Kpi label="COGS" value={"-" + fmt(k.cogs)} />
              <Kpi label="Shipping (actual)" value={"-" + fmt(k.shipping)} />
              <Kpi label="Confirmed margin" value={fmt(k.confirmed)} strong />
              <Kpi label="Provisional margin" value={fmt(k.provisional)} />
            </div>
            <p style={st.note}>
              <strong>Confirmed margin</strong> counts only orders whose COGS and shipping are both known.
              <strong> Provisional</strong> uses all orders with known costs so far (pending costs are absent, never
              estimated), so it reads high until shipping bills. Ad spend excluded in Phase 1.
            </p>
          </div>
        )}

        {tab === "orders" && (
          <Table headers={["Order", "Date", "Revenue", "COGS", "Shipping", "Margin"]}
            rows={d.perOrder.map((o) => [
              o.name || "—",
              fmtDate(o.at as unknown as string),
              fmt(o.revenue),
              o.cogs == null ? "Set cost" : fmt(o.cogs),
              o.shipping != null ? fmt(o.shipping) : o.shippingStatus === "no-awb" ? "No AWB" : o.shippingStatus === "unmatched" ? "Unmatched" : "Pending",
              o.margin == null ? "—" : fmt(o.margin),
            ])}
          />
        )}

        {tab === "products" && (
          <div>
            <p style={st.note}>Margin per product, <strong>before shipping and ad spend</strong> (shipping is per-order, not per-item). Sorted by total margin.</p>
            <Table headers={["Product", "Units", "Revenue", "COGS", "Margin (ex-shipping)"]}
              rows={d.perProduct.map((p) => [p.title, String(p.units), fmt(p.revenue), p.cogs == null ? "Set cost" : fmt(p.cogs), p.margin == null ? "—" : fmt(p.margin)])}
            />
          </div>
        )}

        {c.total === 0 && d.configured && (
          <div style={st.empty}>No orders synced for this period yet. Press <strong>Sync now</strong>.</div>
        )}
      </div>
    </div>
  );
}

function Kpi({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div style={st.kpi}>
      <div style={st.kpiLabel}>{label}</div>
      <div style={{ ...st.kpiValue, ...(strong ? { fontSize: 24, fontWeight: 700 } : {}) }}>{value}</div>
    </div>
  );
}

function Table({ headers, rows }: { headers: string[]; rows: string[][] }) {
  return (
    <div style={st.tableWrap}>
      <table style={st.table}>
        <thead>
          <tr>{headers.map((h) => <th key={h} style={st.th}>{h}</th>)}</tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={headers.length} style={{ ...st.td, color: "#8c9196" }}>Nothing yet.</td></tr>
          ) : rows.map((r, i) => (
            <tr key={i}>{r.map((cell, j) => <td key={j} style={st.td}>{cell}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const st: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f6f6f7", padding: "24px 16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif", color: "#202223" },
  wrap: { maxWidth: 900, margin: "0 auto" },
  topbar: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  h1: { margin: 0, fontSize: 24, fontWeight: 700 },
  link: { color: "#2c6ecb", textDecoration: "none", fontSize: 14 },
  linkB: { color: "#2c6ecb", fontWeight: 600 },
  warn: { background: "#fff5ea", border: "1px solid #ffd79d", borderRadius: 8, padding: 12, fontSize: 14, marginBottom: 16 },
  controls: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 },
  select: { padding: "8px 10px", border: "1px solid #c9cccf", borderRadius: 8, fontSize: 14 },
  subtle: { color: "#6d7175", fontSize: 13 },
  primary: { padding: "9px 16px", background: "#111", color: "#fff", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer" },
  banner: { padding: "10px 12px", borderRadius: 8, fontSize: 14, marginBottom: 14 },
  tabs: { display: "flex", gap: 4, marginBottom: 16, borderBottom: "1px solid #e1e3e5" },
  tab: { padding: "8px 14px", background: "none", border: "none", borderBottom: "2px solid transparent", fontSize: 14, cursor: "pointer", color: "#6d7175" },
  tabActive: { color: "#111", fontWeight: 600, borderBottom: "2px solid #111" },
  kpiGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12, marginBottom: 12 },
  kpi: { background: "#fff", borderRadius: 10, padding: 16, boxShadow: "0 1px 2px rgba(0,0,0,0.06)" },
  kpiLabel: { fontSize: 13, color: "#6d7175", marginBottom: 4 },
  kpiValue: { fontSize: 18, fontWeight: 600 },
  note: { fontSize: 13, color: "#6d7175", lineHeight: 1.5 },
  tableWrap: { background: "#fff", borderRadius: 10, overflow: "auto", boxShadow: "0 1px 2px rgba(0,0,0,0.06)" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 14 },
  th: { textAlign: "left", padding: "10px 14px", borderBottom: "1px solid #e1e3e5", color: "#6d7175", fontWeight: 600, fontSize: 12, textTransform: "uppercase" },
  td: { padding: "10px 14px", borderBottom: "1px solid #f1f1f1" },
  empty: { background: "#fff", borderRadius: 10, padding: 24, textAlign: "center", color: "#6d7175", marginTop: 12 },
};
