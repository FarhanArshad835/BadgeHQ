/**
 * Everything scanned, filterable, with a CSV download.
 *
 * The scanners deliberately do not change order status, so this page is where
 * the value currently sits: a warehouse-confirmed record that can be compared
 * against what the courier sheet claims.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useState } from "react";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import prisma from "../db.server";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import {
  recentScans,
  scanCountsToday,
  scanSearchWhere,
  scanDateWhere,
  allSessions,
  courierDates,
  type ScanKind,
  type ScanResult,
} from "../utils/scan.server";
import { ClaimsStyles } from "../components/ClaimsStyles";
import { ColumnFilter } from "../components/ColumnFilter";
import { BusyBar, useBusy } from "../components/BusyBar";
import { ScanNav } from "../components/ScanNav";

/** The courier's date, in the format Claims uses for the same field. */
const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

const KINDS: Record<string, string> = {
  dispatch: "Dispatch",
  rto: "RTO received",
  "customer-return": "Customer return",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop)
    return json({ rows: [], counts: {}, total: 0, kind: "", result: "", search: "", from: "", to: "", session: "", sessions: [] });

  const url = new URL(request.url);
  const raw = url.searchParams.get("kind") || "";
  const kind = (["dispatch", "rto", "customer-return"].includes(raw) ? raw : null) as ScanKind | null;
  const rawResult = url.searchParams.get("result") || "";
  const result = (["ok", "not-found", "duplicate", "blocked"].includes(rawResult)
    ? rawResult
    : null) as ScanResult | null;

  const search = (url.searchParams.get("q") || "").trim();
  const from = (url.searchParams.get("from") || "").trim();
  const to = (url.searchParams.get("to") || "").trim();
  const session = (url.searchParams.get("session") || "").trim();

  const rows = await recentScans(shop, kind, 500, result, search, from, to, session);
  // One lookup for the page, not one per row.
  const courier = await courierDates(shop, rows.map((r) => r.orderName));
  const sessions = await allSessions(shop);
  // Counted separately: the list is capped at 500, so rows.length would
  // silently understate a filter that matches more than that.
  const total = await prisma.scanEvent.count({
    where: {
      shop,
      ...(kind ? { kind } : {}),
      ...(result ? { result } : {}),
      ...scanSearchWhere(search),
      ...scanDateWhere(from, to),
      ...(session ? { session } : {}),
    },
  });

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const IST = 5.5 * 60 * 60 * 1000;
    const csv = [
      "scanned_ist,kind,awb,order_name,courier_date,session,result,note",
      ...rows.map((r) =>
        [
          esc(new Date(r.scannedAt.getTime() + IST).toISOString().slice(0, 19).replace("T", " ")),
          esc(r.kind),
          esc(r.awb),
          esc(r.orderName),
          esc(courier.get(r.orderName) || ""),
          esc(r.session),
          esc(r.result),
          esc(r.note),
        ].join(","),
      ),
    ].join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="scans${kind ? "-" + kind : ""}${result ? "-" + result : ""}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const counts = await scanCountsToday(shop);
  return json({
    counts,
    total,
    search,
    from,
    to,
    session,
    sessions,
    kind: kind || "",
    result: result || "",
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      awb: r.awb,
      orderName: r.orderName,
      courierAt: courier.get(r.orderName) || "",
      result: r.result,
      note: r.note,
      session: r.session,
      at: new Date(r.scannedAt.getTime() + 5.5 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 16)
        .replace("T", " "),
    })),
  });
};

type Row = {
  id: string;
  kind: string;
  awb: string;
  orderName: string;
  courierAt: string;
  result: string;
  note: string;
  session: string;
  at: string;
};

export default function ScanHistory() {
  // Filters stand down while the page reloads: a second change races the
  // first and the earlier answer wins at random.
  const busy = useBusy();
  const d = useLoaderData<typeof loader>() as {
    rows: Row[];
    counts: Record<string, number>;
    total: number;
    kind: string;
    result: string;
    search: string;
    from: string;
    to: string;
    session: string;
    sessions: Array<{ name: string; count: number }>;
  };
  // Only the setter: every filter's current value comes from the loader, so
  // the page and the URL cannot disagree about what is being shown.
  const [, setParams] = useSearchParams();
  const [exporting, setExporting] = useState(false);

  /**
   * The IST day, as YYYY-MM-DD.
   *
   * Computed in IST, not the browser's zone: a phone set to another timezone
   * would otherwise ask for a different day than the one the operator means.
   */
  const istDay = (daysAgo = 0) => {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - daysAgo * 86400000);
    return ist.toISOString().slice(0, 10);
  };

  const RANGES: Array<{ label: string; from: string; to: string }> = [
    { label: "All dates", from: "", to: "" },
    { label: "Today", from: istDay(0), to: istDay(0) },
    { label: "Yesterday", from: istDay(1), to: istDay(1) },
    { label: "Last 7 days", from: istDay(6), to: istDay(0) },
    { label: "Last 30 days", from: istDay(29), to: istDay(0) },
  ];
  const activeRange =
    RANGES.find((r) => r.from === d.from && r.to === d.to)?.label ?? "Custom";

  /** Change one filter, keep the rest. Blank values drop out of the URL. */
  const setFilters = (next: Record<string, string>) => {
    const merged: Record<string, string> = {
      ...(d.kind ? { kind: d.kind } : {}),
      ...(d.result ? { result: d.result } : {}),
      ...(d.search ? { q: d.search } : {}),
      ...(d.from ? { from: d.from } : {}),
      ...(d.to ? { to: d.to } : {}),
      ...(d.session ? { session: d.session } : {}),
      ...next,
    };
    for (const k of Object.keys(merged)) if (!merged[k].trim()) delete merged[k];
    setParams(merged);
  };

  /**
   * A header that filters its own column.
   *
   * History filters on the server through the URL, so picking an option
   * reloads rather than filtering in place — but the control belongs on the
   * column either way.
   */
  const FilterTh = ({
    label,
    value,
    onPick,
    any,
    options,
  }: {
    label: string;
    value: string;
    onPick: (v: string) => void;
    any: string;
    options: Array<{ value: string; label: string }>;
  }) => (
    <th className={"has-filter" + (value ? " filtered" : "")}>
      <span className="th-in">
        {/* A filtered column says what it is filtered to, so a narrowed list
            never reads as a short one. */}
        <span className="th-label">
          {value ? options.find((o) => o.value === value)?.label || label : label}
        </span>
        <ColumnFilter label={label} value={value} onPick={onPick} any={any} options={options} />
      </span>
    </th>
  );

  return (
    <div className="claims-app">
      <ClaimsStyles />
      <BusyBar />
      <div className="wrap">
        <ScanNav active="history" counts={d.counts} />

        <div className="controls">
          {/* The count sits with the filters that produced it, so the number
              and the question that asked it are read together. */}
          <div className="chips">
            <span className="hist-count">
              <b>{d.total.toLocaleString("en-IN")}</b> {d.total === 1 ? "scan" : "scans"}
              {d.total > d.rows.length && (
                <span className="sub"> · showing the latest {d.rows.length}</span>
              )}
            </span>
          </div>
          <div className="filters">
            {/* Submitted on Enter or blur rather than per keystroke: each
                search is a database query over every scan, and firing one per
                letter would hammer it for results nobody reads. */}
            <input
              type="search"
              placeholder="Search AWB or order"
              aria-label="Search AWB or order"
              defaultValue={d.search}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                setFilters({ q: (e.target as HTMLInputElement).value });
              }}
              onBlur={(e) => {
                if (e.target.value.trim() !== d.search) setFilters({ q: e.target.value });
              }}
            />
            <select
              aria-label="Date range"
              disabled={busy}
              value={activeRange}
              onChange={(e) => {
                const r = RANGES.find((x) => x.label === e.target.value);
                // "Custom" is not selectable: it only appears when the date
                // inputs hold a range none of the presets covers.
                if (r) setFilters({ from: r.from, to: r.to });
              }}
            >
              {RANGES.map((r) => (
                <option key={r.label} value={r.label}>
                  {r.label}
                </option>
              ))}
              {activeRange === "Custom" && <option value="Custom">Custom</option>}
            </select>
            <input
              type="date"
              aria-label="From date"
              disabled={busy}
              value={d.from}
              max={d.to || istDay(0)}
              onChange={(e) => setFilters({ from: e.target.value })}
            />
            <input
              type="date"
              aria-label="To date"
              disabled={busy}
              value={d.to}
              min={d.from}
              max={istDay(0)}
              onChange={(e) => setFilters({ to: e.target.value })}
            />
            {/* The browser shows nothing at all between the click and the
                file arriving, and this one is a real server round trip over
                every scan, not just the 500 on screen. The spinner is cleared
                on a timer rather than on completion: a download never fires a
                load event on the page that started it, so there is no signal
                to wait for — and leaving it spinning for ever would be worse
                than clearing it a moment early. */}
            <a
              className={"btn-primary" + (exporting ? " working" : "")}
              href={`/pnl-app/scan/history?format=csv${d.kind ? `&kind=${d.kind}` : ""}${d.result ? `&result=${d.result}` : ""}${d.search ? `&q=${encodeURIComponent(d.search)}` : ""}${d.from ? `&from=${d.from}` : ""}${d.to ? `&to=${d.to}` : ""}${d.session ? `&session=${encodeURIComponent(d.session)}` : ""}`}
              onClick={() => {
                setExporting(true);
                window.setTimeout(() => setExporting(false), 2500);
              }}
            >
              {exporting ? "Exporting" : "Export CSV"}
            </a>
          </div>
        </div>

        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>When (IST)</th>
                {/* The filters used to sit in a row above the table, naming
                    these same columns a second time. */}
                <FilterTh
                  label="Type"
                  value={d.kind}
                  onPick={(v) => setFilters({ kind: v })}
                  any="All scans"
                  options={[
                    { value: "dispatch", label: "Dispatch" },
                    { value: "rto", label: "RTO received" },
                    { value: "customer-return", label: "Customer return" },
                  ]}
                />
                <th>AWB</th>
                <th>Order</th>
                {/* What the courier claimed, beside when the bench actually
                    saw it. The gap between the two columns is the claim. */}
                <th>Marked delivered</th>
                {d.sessions.length > 0 ? (
                  <FilterTh
                    label="Session"
                    value={d.session}
                    onPick={(v) => setFilters({ session: v })}
                    any="All sessions"
                    options={d.sessions.map((x) => ({
                      value: x.name,
                      label: `${x.name} · ${x.count.toLocaleString("en-IN")}`,
                    }))}
                  />
                ) : (
                  <th>Session</th>
                )}
                {/* Result is its own axis: "which RTOs did not match an order"
                    is a question the type list alone cannot ask. */}
                <FilterTh
                  label="Result"
                  value={d.result}
                  onPick={(v) => setFilters({ result: v })}
                  any="Any result"
                  options={[
                    { value: "ok", label: "Matched an order" },
                    { value: "not-found", label: "Not found" },
                    { value: "duplicate", label: "Duplicate" },
                    { value: "blocked", label: "Blocked" },
                  ]}
                />
              </tr>
            </thead>
            <tbody>
              {!d.rows.length ? (
                <tr>
                  <td colSpan={7} className="empty">
                    {d.search
                      ? `No scan matches "${d.search}". Check the AWB, or clear the type and result filters.`
                      : "Nothing matches these filters. Pick another type or result."}
                  </td>
                </tr>
              ) : (
                d.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="c-when">{r.at}</td>
                    <td className="c-kind">{KINDS[r.kind] || r.kind}</td>
                    <td className="c-awb">{r.awb}</td>
                    <td className="c-order">
                      {r.orderName || <span className="unknown">not in orders</span>}
                    </td>
                    <td className="c-delivered">
                      {r.courierAt ? (
                        fmtDay(r.courierAt)
                      ) : (
                        <span className="unknown">—</span>
                      )}
                    </td>
                    <td className="c-session">
                      {r.session ? (
                        // Opens the batch in the scanner it belongs to, ready
                        // to carry on. Dispatch and inbound are separate
                        // scanners, so the kind decides where it goes.
                        <a
                          href={`/pnl-app/scan/${r.kind === "dispatch" ? "dispatch" : "returns"}?session=${encodeURIComponent(r.session)}`}
                          title={`Open ${r.session} and carry on scanning`}
                        >
                          {r.session}
                        </a>
                      ) : (
                        <span className="unknown">—</span>
                      )}
                    </td>
                    <td className="c-res">
                      <span className={"res " + RES_CLASS[r.result]}>
                        <span className="dot" />
                        {RES_LABEL[r.result] || r.result}
                      </span>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

/** Reuses the scanner's result vocabulary, so one outcome reads the same
 *  colour and wording wherever it appears. */
const RES_CLASS: Record<string, string> = {
  ok: "ok",
  "not-found": "notfound",
  duplicate: "duplicate",
  blocked: "blocked",
  error: "error",
};

const RES_LABEL: Record<string, string> = {
  ok: "Matched",
  "not-found": "No order",
  duplicate: "Duplicate",
  blocked: "Blocked",
  error: "Not saved",
};
