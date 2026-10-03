/**
 * Claims, built to the approved prototype.
 *
 * The prototype is the specification: same grid, same elements, same padding
 * and type scale, same visual flow. Its stylesheet is carried over verbatim in
 * ClaimsStyles rather than translated into the pnl-* tokens, because
 * translating a layout is how "the same" quietly becomes "nearly the same".
 *
 * Filtering, sorting, paging and search all run in the BROWSER, exactly as the
 * prototype does. The server sends the whole claimable set once — a few
 * thousand rows, and it already has them in memory to compute the totals — so
 * every chip, search keystroke and page turn is instant and needs no round
 * trip. The two actions that change data (Received, Claim raised) do post.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import {
  claimCandidates,
  claimStatuses,
  returnClaimCandidates,
  scanCountsToday,
  setParcelClaim,
  type ClaimStatus,
} from "../utils/scan.server";
import { ClaimsStyles } from "../components/ClaimsStyles";
import { ScanNav } from "../components/ScanNav";
import { BusyBar } from "../components/BusyBar";

const TABS = ["rto", "returns"] as const;
type Tab = (typeof TABS)[number];

/** Rows the client filters over. Money is in rupees: the client only displays it. */
type ClaimRow = {
  order: string;
  awb: string;
  carrier: string;
  delivered: string;
  days: number;
  cost: number | null;
  orderValue: number;
  status: string;
  /** Physically scanned at the bench. Hidden by default: the list is about
   *  what is MISSING, and a found parcel is not a claim. */
  scanned: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;

  const url = new URL(request.url);
  const t = url.searchParams.get("tab");
  const tab: Tab = TABS.includes(t as Tab) ? (t as Tab) : "rto";

  if (!shop) {
    return json({ tab, rows: [] as ClaimRow[], counts: {}, undated: 0, inFlight: 0, available: true });
  }

  const counts = await scanCountsToday(shop);
  const rupees = (minor: string | null) => (minor == null ? null : Math.round(Number(minor) / 100));

  if (tab === "returns") {
    // Grace of 0: the browser does the ageing, so the server must not pre-filter
    // by a window the user can still change.
    const res = await returnClaimCandidates(shop, 0);
    const statuses = await claimStatuses(shop, res.rows.map((r) => r.awb).filter(Boolean));
    return json({
      tab,
      counts,
      undated: 0,
      inFlight: res.inFlight,
      available: res.available,
      rows: res.rows.map((r) => ({
        order: r.orderName,
        awb: r.awb,
        carrier: r.carrier || "Unknown",
        delivered: r.receivedAt,
        days: r.daysOld,
        cost: null,
        orderValue: 0,
        status: statuses.get(r.awb) || "",
        scanned: r.scanned,
      })),
    });
  }

  const res = await claimCandidates(shop, 0, "days", "desc");
  const statuses = await claimStatuses(shop, res.rows.map((r) => r.awb));
  return json({
    tab,
    counts,
    undated: res.undatedCount,
    inFlight: 0,
    available: true,
    rows: res.rows.map((r) => ({
      order: r.orderName,
      awb: r.awb,
      carrier: r.carrier || "Unknown",
      delivered: r.receivedAt,
      days: r.daysOld,
      cost: rupees(r.cogsMinor),
      orderValue: rupees(r.revenueMinor) ?? 0,
      status: statuses.get(r.awb) || "",
      scanned: r.scanned,
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request, "scan")) return json({ error: "unauthorized" }, { status: 401 });
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ error: "not-configured" }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (!body?.awb) return json({ error: "bad-request" }, { status: 400 });
  const kind = body.tab === "returns" ? "customer-return" : "rto";
  await setParcelClaim(shop, String(body.awb), kind, (body.status || "") as ClaimStatus | "");
  return json({ ok: true });
};

const AGES = [0, 7, 14, 30, 45];
const PAGE_SIZE = 50;
const inr = (n: number) => "\u20B9" + n.toLocaleString("en-IN");
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

export default function Claims() {
  const d = useLoaderData<typeof loader>() as {
    tab: Tab;
    rows: ClaimRow[];
    counts: Record<string, number>;
    undated: number;
    inFlight: number;
    available: boolean;
  };
  const [, setParams] = useSearchParams();

  // Local copy so a status click repaints immediately; the POST follows.
  const [rows, setRows] = useState<ClaimRow[]>(d.rows);
  useEffect(() => setRows(d.rows), [d.rows]);

  const [age, setAge] = useState(0);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [search, setSearch] = useState("");
  const [carrier, setCarrier] = useState("");
  const [step, setStep] = useState("");
  const [claimWindow, setClaimWindow] = useState(60);
  // The sort dropdown and the column headers set the same state, so they can
  // never disagree about what the table is showing.
  const [sortCol, setSortCol] = useState<"days" | "cost" | "order" | "carrier" | "delivered">("days");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  // Found parcels are hidden by default: this is a list of what is missing.
  const [showScanned, setShowScanned] = useState(false);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [popOpen, setPopOpen] = useState(false);
  const [popPos, setPopPos] = useState({ left: 0, top: 0 });
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [customErr, setCustomErr] = useState("");
  const popRef = useRef<HTMLDivElement>(null);
  const customChipRef = useRef<HTMLButtonElement>(null);

  const isReturns = d.tab === "returns";

  const nextStep = (r: ClaimRow) => {
    // The bench found it, so there is nothing to claim regardless of age.
    if (r.scanned) return "Found";
    if (r.status === "received") return "Received";
    if (r.status === "raised") return "Claim raised";
    if (r.carrier === "Unknown") return "Fix carrier";
    if (r.days > claimWindow) return "Past window";
    if (claimWindow - r.days <= 7) return "Closing soon";
    return "File claim";
  };

  const inRange = (r: ClaimRow) => {
    if (custom) {
      return (!custom.from || r.delivered >= custom.from) && (!custom.to || r.delivered <= custom.to);
    }
    return r.days >= age;
  };

  const carriers = useMemo(() => {
    const set = new Set(rows.map((r) => r.carrier).filter(Boolean));
    return Array.from(set).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const sign = sortDir === "asc" ? 1 : -1;
    const cmp = (a: ClaimRow, b: ClaimRow) => {
      switch (sortCol) {
        case "cost":
          // Unknown cost sorts last in BOTH directions: it is absent data, not
          // a low number, and letting it lead would misrepresent it.
          if (a.cost == null || b.cost == null) {
            return (a.cost == null ? 1 : 0) - (b.cost == null ? 1 : 0);
          }
          return sign * (a.cost - b.cost);
        case "order":
          return sign * a.order.localeCompare(b.order, undefined, { numeric: true });
        case "carrier":
          return sign * a.carrier.localeCompare(b.carrier);
        case "delivered":
          return sign * a.delivered.localeCompare(b.delivered);
        default:
          return sign * (a.days - b.days);
      }
    };
    return rows
      .filter(
        (r) =>
          (showScanned || !r.scanned) &&
          inRange(r) &&
          (!carrier || r.carrier === carrier) &&
          (!step || nextStep(r) === step) &&
          (!q || r.order.toLowerCase().includes(q) || r.awb.toLowerCase().includes(q)),
      )
      .sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, carrier, step, sortCol, sortDir, age, custom, claimWindow, showScanned]);

  /**
   * A sortable header.
   *
   * Clicking the active column flips direction; clicking another starts it
   * descending — "most days waiting" and "highest cost" are what someone
   * chasing claims wants on the first click.
   */
  const SortTh = ({
    col,
    label,
    num,
  }: {
    col: typeof sortCol;
    label: string;
    num?: boolean;
  }) => {
    const active = sortCol === col;
    return (
      <th className={num ? "num" : undefined}>
        <button
          type="button"
          className="sort"
          aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
          onClick={() => {
            if (active) setSortDir(sortDir === "desc" ? "asc" : "desc");
            else {
              setSortCol(col);
              setSortDir("desc");
            }
            setPage(0);
          }}
        >
          {label}
          <span className="arrow" aria-hidden>
            {active && sortDir === "asc" ? "▲" : "▼"}
          </span>
        </button>
      </th>
    );
  };

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageIdx = Math.min(page, pages - 1);
  const slice = filtered.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);

  const claimableTotal = useMemo(
    () =>
      rows
        .filter((r) => ["File claim", "Closing soon"].includes(nextStep(r)))
        .reduce((s, r) => s + (r.cost ?? 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, claimWindow],
  );
  // A parcel the bench has scanned is not at risk — it is on the shelf.
  const atRisk = useMemo(
    () =>
      rows
        .filter((r) => !r.scanned && r.status !== "received")
        .reduce((s, r) => s + (r.cost ?? 0), 0),
    [rows],
  );
  const missing = rows.filter((r) => !r.scanned);
  const scannedCount = rows.filter((r) => r.scanned).length;
  const pctOfReturns =
    rows.length + d.undated > 0
      ? ((missing.length / (rows.length + d.undated)) * 100).toFixed(1)
      : "0.0";

  async function setStatus(awb: string, next: "received" | "raised") {
    const current = rows.find((r) => r.awb === awb)?.status || "";
    const value = current === next ? "" : next;
    setRows((rs) => rs.map((r) => (r.awb === awb ? { ...r, status: value } : r)));
    try {
      await fetch(window.location.pathname + ".data" + window.location.search, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ awb, status: value, tab: d.tab }),
        credentials: "same-origin",
      });
    } catch {
      // Put it back rather than showing a change that did not save.
      setRows((rs) => rs.map((r) => (r.awb === awb ? { ...r, status: current } : r)));
    }
  }

  function openCustom() {
    const el = customChipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPopPos({ left: Math.max(10, Math.min(r.left, window.innerWidth - 310)), top: r.bottom + 6 });
    setFromDate(custom?.from || "");
    setToDate(custom?.to || "");
    setCustomErr("");
    setPopOpen(true);
  }

  function applyCustom(f = fromDate, t = toDate) {
    if (!f && !t) {
      setCustomErr("Pick a From or To date.");
      return;
    }
    if (f && t && t < f) {
      setCustomErr("To date must be on or after From date.");
      return;
    }
    setCustom({ from: f, to: t });
    setAge(-1);
    setPage(0);
    setPopOpen(false);
  }

  function preset(p: string) {
    const today = new Date();
    const iso = (x: Date) => new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const ago = (n: number) => {
      const x = new Date(today);
      x.setDate(x.getDate() - n);
      return x;
    };
    let from: Date | null = null;
    let to = new Date(today);
    if (p === "this") from = new Date(today.getFullYear(), today.getMonth(), 1);
    else if (p === "last") {
      from = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      to = new Date(today.getFullYear(), today.getMonth(), 0);
    } else if (p === "0") {
      from = new Date(today);
    } else if (p === "1") {
      // A single day, both ends. Falling through to the range below would give
      // yesterday-to-today, which is two days and not what the label says.
      from = ago(1);
      to = ago(1);
    } else from = ago(Number(p));
    const f = from ? iso(from) : "";
    const t = iso(to);
    setFromDate(f);
    setToDate(t);
    applyCustom(f, t);
  }

  // The popover closes on an outside click, a resize or a scroll, as the
  // prototype does — it is positioned fixed, so it would otherwise detach.
  useEffect(() => {
    if (!popOpen) return;
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return;
      if (customChipRef.current?.contains(e.target as Node)) return;
      setPopOpen(false);
    };
    const close = () => setPopOpen(false);
    document.addEventListener("mousedown", onDown);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", close);
    };
  }, [popOpen]);

  function exportCsv() {
    const list = selected.size ? rows.filter((r) => selected.has(r.awb)) : filtered;
    const head = ["Order", "AWB", "Carrier", "Marked delivered", "Days", "Stock cost", "Order value", "Next step"];
    const csv = [head]
      .concat(
        list.map((r) => [
          r.order,
          r.awb,
          r.carrier,
          fmtDate(r.delivered),
          String(r.days),
          r.cost == null ? "" : String(r.cost),
          String(r.orderValue),
          nextStep(r),
        ]),
      )
      .map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv" }));
    a.download = isReturns ? "return-claims.csv" : "rto-claims.csv";
    a.click();
  }


  return (
    <div className="claims-app">
      <ClaimsStyles />
      <BusyBar />
      <div className="wrap">
        {/* The shared bar, not a second copy: this page had its own, so a fix
            to one left the other behind — which is how Sign out kept pushing
            History off the edge here after it had been moved everywhere else. */}
        <ScanNav active="claims" counts={d.counts} />

        <div className="subtabs" role="tablist">
          <button
            className={!isReturns ? "active" : ""}
            role="tab"
            aria-selected={!isReturns}
            onClick={() => setParams({ tab: "rto" })}
          >
            RTO parcels
          </button>
          <button
            className={isReturns ? "active" : ""}
            role="tab"
            aria-selected={isReturns}
            onClick={() => setParams({ tab: "returns" })}
          >
            Customer returns
          </button>
        </div>

        <section className="summary">
          <div className="headline">
            <div className="big">{missing.length.toLocaleString("en-IN")}</div>
            <div className="big-sub">
              <span className="long">
                parcels marked {isReturns ? "returned" : "RTO delivered"} but never scanned in ·{" "}
                {pctOfReturns}% of returns
              </span>
              <span className="short">never scanned in · {pctOfReturns}% of returns</span>
            </div>
          </div>
          <div className="stats">
            <div className="stat">
              <div className="label">Claimable now</div>
              <div className="value green">{inr(claimableTotal)}</div>
            </div>
            <div className="stat">
              <div className="label">
                <span className="long">Stock cost at risk</span>
                <span className="short">At risk</span>
              </div>
              <div className="value">{inr(atRisk)}</div>
            </div>
            <div className="stat">
              <div className="label">Claim window</div>
              <select
                aria-label="Claim window"
                value={claimWindow}
                onChange={(e) => setClaimWindow(Number(e.target.value))}
              >
                <option value="30">30 days</option>
                <option value="45">45 days</option>
                <option value="60">60 days</option>
                <option value="90">90 days</option>
              </select>
            </div>
          </div>
        </section>

        <div className="controls">
          <div className="chips">
            {AGES.map((a) => (
              <button
                key={a}
                className={"chip" + (age === a && !custom ? " active" : "")}
                onClick={() => {
                  setAge(a);
                  setCustom(null);
                  setPage(0);
                }}
              >
                {a ? `${a}+ days` : "All"}{" "}
                <span>
                  {(showScanned ? rows : missing)
                    .filter((r) => r.days >= a)
                    .length.toLocaleString("en-IN")}
                </span>
              </button>
            ))}
            {scannedCount > 0 && (
              <button
                className={"chip" + (showScanned ? " active" : "")}
                onClick={() => {
                  setShowScanned((v) => !v);
                  setPage(0);
                }}
                title="Parcels the bench has physically scanned in"
              >
                {showScanned ? "Hiding none" : "Found"} <span>{scannedCount.toLocaleString("en-IN")}</span>
              </button>
            )}
            <button
              ref={customChipRef}
              className={"chip" + (custom ? " active" : "")}
              onClick={(e) => {
                if ((e.target as HTMLElement).dataset.clear !== undefined) {
                  setCustom(null);
                  setAge(0);
                  setPage(0);
                  return;
                }
                openCustom();
              }}
            >
              {custom ? (
                <>
                  {custom.from && custom.to
                    ? `${fmtDate(custom.from).slice(0, 6)} – ${fmtDate(custom.to).slice(0, 6)}`
                    : custom.from
                      ? `From ${fmtDate(custom.from).slice(0, 6)}`
                      : `Until ${fmtDate(custom.to).slice(0, 6)}`}{" "}
                  <span>{rows.filter(inRange).length.toLocaleString("en-IN")}</span>
                  <span className="x" data-clear aria-label="Clear custom range">
                    ✕
                  </span>
                </>
              ) : (
                "Custom"
              )}
            </button>
          </div>

          <div
            className="pop"
            ref={popRef}
            hidden={!popOpen}
            role="dialog"
            aria-label="Custom date range"
            style={{ left: popPos.left, top: popPos.top }}
            onKeyDown={(e) => {
              if (e.key === "Enter") applyCustom();
              if (e.key === "Escape") setPopOpen(false);
            }}
          >
            <div className="title">Marked delivered between</div>
            <div className="range">
              <div>
                <label htmlFor="fromDate">From</label>
                <input
                  id="fromDate"
                  type="date"
                  value={fromDate}
                  onChange={(e) => setFromDate(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor="toDate">To</label>
                <input id="toDate" type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
              </div>
            </div>
            <div className="presets">
              {/* Today and Yesterday first: a parcel marked returned today is
                  the one someone is most likely to be looking for. The two
                  90-day presets are gone — the age chips above already cover
                  "old", and a claim that far back is past most windows. */}
              <button onClick={() => preset("0")}>Today</button>
              <button onClick={() => preset("1")}>Yesterday</button>
              <button onClick={() => preset("7")}>Last 7 days</button>
              <button onClick={() => preset("30")}>Last 30 days</button>
              <button onClick={() => preset("this")}>This month</button>
              <button onClick={() => preset("last")}>Last month</button>
            </div>
            <div className="err">{customErr}</div>
            <div className="row-btns">
              <button className="btn-ghost" onClick={() => setPopOpen(false)}>
                Cancel
              </button>
              <button className="btn-primary" onClick={() => applyCustom()}>
                Apply
              </button>
            </div>
          </div>

          <div className="filters">
            <input
              type="search"
              placeholder="Search order or AWB"
              aria-label="Search order or AWB"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
            />
            <select
              aria-label="Sort"
              value={sortCol === "days" && sortDir === "desc" ? "old" : sortCol === "days" ? "new" : "cost"}
              onChange={(e) => {
                const v = e.target.value;
                setSortCol(v === "cost" ? "cost" : "days");
                setSortDir(v === "new" ? "asc" : "desc");
                setPage(0);
              }}
            >
              <option value="old">Oldest first</option>
              <option value="new">Newest first</option>
              <option value="cost">Highest cost</option>
            </select>
            <select
              aria-label="Carrier"
              value={carrier}
              onChange={(e) => {
                setCarrier(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Any carrier</option>
              {carriers.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              aria-label="Next step"
              value={step}
              onChange={(e) => {
                setStep(e.target.value);
                setPage(0);
              }}
            >
              <option value="">Any step</option>
              <option>File claim</option>
              <option>Closing soon</option>
              <option>Fix carrier</option>
              <option>Past window</option>
              <option>Found</option>
              <option>Received</option>
              <option>Claim raised</option>
            </select>
            <button className="btn-primary" onClick={exportCsv}>
              {selected.size ? `Export ${selected.size}` : "Export"}
            </button>
          </div>
        </div>

        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="Select all on this page"
                    checked={slice.length > 0 && slice.every((r) => selected.has(r.awb))}
                    onChange={(e) => {
                      const next = new Set(selected);
                      slice.forEach((r) => (e.target.checked ? next.add(r.awb) : next.delete(r.awb)));
                      setSelected(next);
                    }}
                  />
                </th>
                <SortTh col="order" label="Order" />
                <SortTh col="carrier" label="Carrier" />
                <SortTh col="delivered" label="Marked delivered" />
                <SortTh col="days" label="Days" num />
                <SortTh col="cost" label="Stock cost" num />
                <th>Next step</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!slice.length ? (
                <tr>
                  <td colSpan={8} className="empty">
                    No parcels match these filters. Clear the search or pick another carrier.
                  </td>
                </tr>
              ) : (
                slice.map((r) => {
                  const st = nextStep(r);
                  const dot =
                    st === "File claim"
                      ? "ready"
                      : st === "Closing soon"
                        ? "soon"
                        : r.scanned || r.status
                          ? "done"
                          : "";
                  return (
                    <tr key={r.awb} className={r.scanned || r.status ? "done" : ""}>
                      <td className="c-chk">
                        <input
                          type="checkbox"
                          aria-label={`Select ${r.order}`}
                          checked={selected.has(r.awb)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            e.target.checked ? next.add(r.awb) : next.delete(r.awb);
                            setSelected(next);
                          }}
                        />
                      </td>
                      <td className="c-order">
                        <div className="order">{r.order}</div>
                        <div className="awb">{r.awb}</div>
                      </td>
                      <td
                        className={"c-carrier" + (r.carrier === "Unknown" ? " unknown" : "")}
                        data-date={fmtDate(r.delivered)}
                      >
                        {r.carrier}
                      </td>
                      <td className="c-date">{fmtDate(r.delivered)}</td>
                      <td className="num days c-days">{r.days}</td>
                      <td className="num c-cost">
                        <div className="cost">{r.cost == null ? <span className="unknown">unknown</span> : inr(r.cost)}</div>
                        <div className="sub">{inr(r.orderValue)} order</div>
                      </td>
                      <td className="c-step">
                        <span className={"step" + (dot === "ready" ? " ready" : "")}>
                          <span className={"dot " + dot} />
                          {st}
                        </span>
                      </td>
                      <td className="c-act">
                        <div className="actions">
                          <button
                            className={"act" + (r.status === "received" ? " on" : "")}
                            onClick={() => setStatus(r.awb, "received")}
                          >
                            Received
                          </button>
                          <button
                            className={"act" + (r.status === "raised" ? " on" : "")}
                            onClick={() => setStatus(r.awb, "raised")}
                          >
                            Claim raised
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="footer">
          <span>
            {filtered.length ? pageIdx * PAGE_SIZE + 1 : 0}–
            {Math.min((pageIdx + 1) * PAGE_SIZE, filtered.length)} of{" "}
            {filtered.length.toLocaleString("en-IN")}
          </span>
          <div className="pager">
            <button className="btn-ghost" disabled={pageIdx === 0} onClick={() => setPage(pageIdx - 1)}>
              Previous
            </button>
            <button
              className="btn-ghost"
              disabled={pageIdx >= pages - 1}
              onClick={() => setPage(pageIdx + 1)}
            >
              Next
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
