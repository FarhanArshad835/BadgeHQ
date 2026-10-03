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
import { useLoaderData } from "@remix-run/react";
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
import { ColumnFilter } from "../components/ColumnFilter";
import { ScanNav } from "../components/ScanNav";
import { BusyBar } from "../components/BusyBar";

/** Rows the client filters over. Money is in rupees: the client only displays it. */
type ClaimRow = {
  /** Which bucket the parcel came from — the column that replaced the tabs. */
  type: "rto" | "return";
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

  if (!shop) {
    return json({ rows: [] as ClaimRow[], counts: {}, undated: 0, inFlight: 0, available: true });
  }

  const counts = await scanCountsToday(shop);

  // Both sources in one list. A parcel on the bench is a parcel; which kind it
  // is belongs in a column, not in a tab the operator has to remember to
  // switch. The two were already the same row shape.
  const [rto, ret] = await Promise.all([
    claimCandidates(shop, 0, "days", "desc"),
    returnClaimCandidates(shop, 0),
  ]);

  const awbs = [...rto.rows.map((r) => r.awb), ...ret.rows.map((r) => r.awb)].filter(Boolean);
  const statuses = await claimStatuses(shop, awbs);
  const rupees = (minor: string | null) => (minor == null ? null : Math.round(Number(minor) / 100));

  const rows: ClaimRow[] = [
    ...rto.rows.map((r) => ({
      type: "rto" as const,
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
    ...ret.rows.map((r) => ({
      type: "return" as const,
      order: r.orderName,
      awb: r.awb,
      carrier: r.carrier || "Unknown",
      delivered: r.receivedAt,
      days: r.daysOld,
      // ReturnHQ holds no stock cost, so a return shows unknown rather than a
      // zero that would read as free.
      cost: null,
      orderValue: 0,
      status: statuses.get(r.awb) || "",
      scanned: r.scanned,
    })),
  ];

  return json({
    counts,
    rows,
    undated: rto.undatedCount,
    inFlight: ret.inFlight,
    available: ret.available,
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

/** A date as YYYY-MM-DD in the browser's own day, not UTC. */
const isoDay = (x: Date) =>
  new Date(x.getTime() - x.getTimezoneOffset() * 60000).toISOString().slice(0, 10);

/** One whole day, n days back, as the inclusive range the filter wants. */
const dayRange = (ago: number) => {
  const x = new Date();
  x.setDate(x.getDate() - ago);
  const d = isoDay(x);
  return { from: d, to: d };
};

const DAY_CHIPS = [
  { label: "Today", ago: 0 },
  { label: "Yesterday", ago: 1 },
];
const PAGE_SIZE = 50;
/** The steps nextStep() can return, in the order a claim moves through them. */
const STEPS = [
  "File claim",
  "Closing soon",
  "Fix carrier",
  "Past window",
  "Found",
  "Received",
  "Claim raised",
];

const inr = (n: number) => "\u20B9" + n.toLocaleString("en-IN");
const fmtDate = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

export default function Claims() {
  const d = useLoaderData<typeof loader>() as {
    rows: ClaimRow[];
    counts: Record<string, number>;
    undated: number;
    inFlight: number;
    available: boolean;
  };

  // Local copy so a status click repaints immediately; the POST follows.
  const [rows, setRows] = useState<ClaimRow[]>(d.rows);
  useEffect(() => setRows(d.rows), [d.rows]);

  const [age, setAge] = useState(0);
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(null);
  const [search, setSearch] = useState("");
  const [carrier, setCarrier] = useState("");
  // What the two tabs used to do, as a filter — so both kinds can also be seen
  // together, which is how a bench actually works through a pile.
  const [typeFilter, setTypeFilter] = useState("");
  const [step, setStep] = useState("");
  // The claim window still decides "Past window" and "Closing soon" in the
  // Next step column. The summary strip that used to let it be changed is
  // gone, so it holds at the figure that was its default.
  const claimWindow = 60;
  // The sort dropdown and the column headers set the same state, so they can
  // never disagree about what the table is showing.
  const [sortCol, setSortCol] = useState<
    "days" | "cost" | "order" | "carrier" | "delivered" | "type"
  >("days");
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
        case "type":
          return sign * a.type.localeCompare(b.type);
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
          (!typeFilter || r.type === typeFilter) &&
          (!carrier || r.carrier === carrier) &&
          (!step || nextStep(r) === step) &&
          (!q || r.order.toLowerCase().includes(q) || r.awb.toLowerCase().includes(q)),
      )
      .sort(cmp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, carrier, step, sortCol, sortDir, age, custom, claimWindow, showScanned, typeFilter]);

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
    filter,
  }: {
    col: typeof sortCol;
    label: string;
    num?: boolean;
    /** The column's own filter: its options, and where the chosen value lives. */
    filter?: {
      value: string;
      set: (v: string) => void;
      any: string;
      options: Array<{ value: string; label: string }>;
    };
  }) => {
    const active = sortCol === col;
    const on = !!filter?.value;
    return (
      <th
        className={(num ? "num" : "") + (filter ? " has-filter" : "") + (on ? " filtered" : "")}
        aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : "none"}
      >
        <span className="th-in">
          <button
            type="button"
            className="sort"
            onClick={() => {
              if (active) setSortDir(sortDir === "desc" ? "asc" : "desc");
              else {
                setSortCol(col);
                setSortDir("desc");
              }
              setPage(0);
            }}
          >
            {/* A filtered column says what it is filtered to, so a narrowed
                list never looks like a short one. */}
            {on ? filter!.options.find((o) => o.value === filter!.value)?.label || label : label}
            <span className="arrow" aria-hidden>
              {active && sortDir === "asc" ? "▲" : "▼"}
            </span>
          </button>
          {filter && (
            <ColumnFilter
              label={label}
              value={filter.value}
              onPick={(v) => {
                filter.set(v);
                setPage(0);
              }}
              any={filter.any}
              options={filter.options}
            />
          )}
        </span>
      </th>
    );
  };

  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageIdx = Math.min(page, pages - 1);
  const slice = filtered.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);

  // Still counted: the chips show how many are missing and how many the bench
  // has found. The money totals went with the summary strip.
  const missing = rows.filter((r) => !r.scanned);
  const scannedCount = rows.filter((r) => r.scanned).length;

  async function setStatus(awb: string, next: "received" | "raised") {
    const row = rows.find((r) => r.awb === awb);
    const current = row?.status || "";
    const value = current === next ? "" : next;
    setRows((rs) => rs.map((r) => (r.awb === awb ? { ...r, status: value } : r)));
    try {
      await fetch(window.location.pathname + ".data" + window.location.search, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // The row's own type, not the tab it was under: with one list there is
              // no tab, and defaulting would file every customer return as an RTO.
        body: JSON.stringify({ awb, status: value, tab: row?.type === "return" ? "returns" : "rto" }),
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
    const iso = isoDay;
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
    const head = ["Order", "AWB", "Type", "Carrier", "Marked delivered", "Days", "Stock cost", "Order value", "Next step"];
    const csv = [head]
      .concat(
        list.map((r) => [
          r.order,
          r.awb,
          r.type === "return" ? "Customer return" : "RTO",
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
    a.download = typeFilter === "return"
      ? "return-claims.csv"
      : typeFilter === "rto"
        ? "rto-claims.csv"
        : "claims.csv";
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

        <div className="controls">
          <div className="chips">
            {/* All, then the two days someone actually asks for by name. The
                "7+ days" ladder is gone: age is a column now, so sorting by
                Days answers "what is oldest" better than four fixed steps,
                and the custom range covers any other span. */}
            <button
              className={"chip" + (!age && !custom ? " active" : "")}
              onClick={() => {
                setAge(0);
                setCustom(null);
                setPage(0);
              }}
            >
              All{" "}
              <span>{(showScanned ? rows : missing).length.toLocaleString("en-IN")}</span>
            </button>
            {DAY_CHIPS.map((c) => {
              const r = dayRange(c.ago);
              const on = custom?.from === r.from && custom?.to === r.to;
              return (
                <button
                  key={c.label}
                  className={"chip" + (on ? " active" : "")}
                  onClick={() => {
                    setFromDate(r.from);
                    setToDate(r.to);
                    applyCustom(r.from, r.to);
                  }}
                >
                  {c.label}{" "}
                  <span>
                    {(showScanned ? rows : missing)
                      .filter((x) => x.delivered >= r.from && x.delivered <= r.to)
                      .length.toLocaleString("en-IN")}
                  </span>
                </button>
              );
            })}
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
              {/* Today and Yesterday lead here too, matching the chips above:
                  the same day picked either way lights the same chip. */}
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
                <SortTh
                  col="type"
                  label="Type"
                  filter={{
                    value: typeFilter,
                    set: setTypeFilter,
                    any: "Both kinds",
                    options: [
                      { value: "rto", label: "RTO" },
                      { value: "return", label: "Customer return" },
                    ],
                  }}
                />
                <SortTh
                  col="carrier"
                  label="Carrier"
                  filter={{
                    value: carrier,
                    set: setCarrier,
                    any: "Any carrier",
                    options: carriers.map((c) => ({ value: c, label: c })),
                  }}
                />
                <SortTh col="delivered" label="Marked delivered" />
                <SortTh col="days" label="Days" num />
                <SortTh col="cost" label="Stock cost" num />
                {/* Next step is computed from the claim window rather than
                    stored, so it filters but does not sort. */}
                <th className={"has-filter" + (step ? " filtered" : "")}>
                  <span className="th-in">
                    <span className="th-label">{step || "Next step"}</span>
                    <ColumnFilter
                      label="Next step"
                      value={step}
                      onPick={(v) => {
                        setStep(v);
                        setPage(0);
                      }}
                      any="Any step"
                      options={STEPS.map((x) => ({ value: x, label: x }))}
                    />
                  </span>
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!slice.length ? (
                <tr>
                  <td colSpan={9} className="empty">
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
                      <td className="c-type">
                        <span className={`type-tag ${r.type}`}>
                          {r.type === "return" ? "Return" : "RTO"}
                        </span>
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
