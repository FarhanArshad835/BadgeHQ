/**
 * How many parcels went missing on each of the last N days.
 *
 * Bars rather than the area plot DailyTrend uses: these are counts of discrete
 * events on discrete days, not a continuous quantity, and the question is
 * "which day was bad" — a comparison between days, which bar length answers
 * directly.
 *
 * A day's bar is the parcels whose courier marked them returned THAT day and
 * which nobody has scanned in since. So it answers "how much is going missing
 * daily", not "how much is outstanding" — a parcel found later leaves the bar
 * it was in, which is the point.
 *
 * Scoped to the rows the filters have already selected, so the chart and the
 * table below it can never disagree about what is being counted.
 *
 * Every value is also in the table, so nothing here is reachable only by
 * hovering.
 */
import { useMemo, useState } from "react";

type Row = { delivered: string; scanned: boolean; cost: number | null };

const BAR = "#3b4bc8";
const BAR_FOUND = "#cfd3ea";
const GRID = "#e8e8e6";
const INK_MUTED = "#6b6b68";

/** "2026-10-11" -> "11 Oct", and the weekday for the tooltip. */
function dayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}
function weekday(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleString("en-GB", {
    weekday: "short",
    timeZone: "UTC",
  });
}

/** Today in IST as YYYY-MM-DD — the same day boundary the rest of the app uses. */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function daysBack(n: number): string[] {
  const out: string[] = [];
  const end = new Date(istToday() + "T00:00:00Z");
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setUTCDate(d.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

export function MissingPerDay({
  rows,
  days = 10,
  inr,
}: {
  rows: Row[];
  days?: number;
  inr: (n: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);

  const series = useMemo(() => {
    const span = daysBack(days);
    const index = new Map(span.map((d, i) => [d, i]));
    const missing = span.map(() => 0);
    const found = span.map(() => 0);
    const cost = span.map(() => 0);
    for (const r of rows) {
      const i = index.get(r.delivered);
      if (i === undefined) continue;
      if (r.scanned) found[i]++;
      else {
        missing[i]++;
        cost[i] += r.cost ?? 0;
      }
    }
    return span.map((day, i) => ({ day, missing: missing[i], found: found[i], cost: cost[i] }));
  }, [rows, days]);

  const peak = Math.max(1, ...series.map((p) => p.missing + p.found));
  const total = series.reduce((s, p) => s + p.missing, 0);
  // Averaged over the days that actually have data: a span whose later days
  // have not been marked returned yet would drag a flat mean toward zero and
  // make the run look better than it is.
  const active = series.filter((p) => p.missing + p.found > 0).length;
  const perDay = active ? Math.round(total / active) : 0;

  if (!rows.length) return null;

  return (
    <div className="mpd">
      <div className="mpd-head">
        <span className="mpd-title">Going missing per day</span>
        <span className="mpd-sub">
          {total.toLocaleString("en-IN")} in {days} days · about {perDay.toLocaleString("en-IN")} a day
        </span>
      </div>

      <div className="mpd-bars" role="img" aria-label={`Parcels unaccounted for on each of the last ${days} days`}>
        {series.map((p, i) => {
          const h = ((p.missing + p.found) / peak) * 100;
          const foundShare = p.missing + p.found ? (p.found / (p.missing + p.found)) * 100 : 0;
          return (
            <div
              key={p.day}
              className={"mpd-col" + (hover === i ? " on" : "")}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {hover === i && (
                <div className="mpd-tip">
                  <b>{p.missing.toLocaleString("en-IN")}</b> missing
                  {p.found > 0 && <span className="mpd-tip-sub"> · {p.found} found</span>}
                  {p.cost > 0 && <div className="mpd-tip-sub">{inr(p.cost)} stock</div>}
                  <div className="mpd-tip-day">
                    {weekday(p.day)} {dayLabel(p.day)}
                  </div>
                </div>
              )}
              <div className="mpd-stack" style={{ height: `${Math.max(h, p.missing + p.found ? 3 : 0)}%` }}>
                {/* Found sits ON TOP of missing, so the dark part always starts
                    at the baseline and days stay comparable at a glance. */}
                {foundShare > 0 && <div className="mpd-found" style={{ height: `${foundShare}%` }} />}
              </div>
              <div className="mpd-n">{p.missing || ""}</div>
              <div className="mpd-day">{dayLabel(p.day)}</div>
            </div>
          );
        })}
      </div>
      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.mpd { border: 1px solid ${GRID}; border-radius: 10px; padding: 12px 14px 8px; margin-top: 10px; background: #fff; }
.mpd-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.mpd-title { font-size: 12px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #3a3a38; }
.mpd-sub { font-size: 12px; color: ${INK_MUTED}; }
.mpd-bars { display: flex; align-items: flex-end; gap: 6px; height: 104px; margin-top: 10px; }
.mpd-col { position: relative; flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; height: 100%; cursor: default; }
/* The bar grows from a fixed-height track so every column shares a baseline. */
.mpd-col .mpd-stack { width: 100%; max-width: 46px; background: ${BAR}; border-radius: 4px 4px 0 0; display: flex; flex-direction: column; transition: opacity .12s; }
.mpd-col.on .mpd-stack { opacity: .82; }
.mpd-found { width: 100%; background: ${BAR_FOUND}; border-radius: 4px 4px 0 0; }
.mpd-n { font-size: 11px; font-weight: 600; color: #3a3a38; margin-top: 3px; min-height: 14px; font-variant-numeric: tabular-nums; }
.mpd-day { font-size: 10px; color: ${INK_MUTED}; white-space: nowrap; }
.mpd-tip { position: absolute; bottom: calc(100% + 6px); left: 50%; transform: translateX(-50%); z-index: 5;
  background: #1f1f1e; color: #fff; font-size: 11px; line-height: 1.45; padding: 6px 9px; border-radius: 7px; white-space: nowrap; pointer-events: none; }
.mpd-tip-sub { opacity: .78; }
.mpd-tip-day { opacity: .6; margin-top: 2px; }
@media (max-width: 640px) {
  .mpd-bars { height: 84px; gap: 3px; }
  /* Every other label, so they stop colliding on a phone. */
  .mpd-col:nth-child(even) .mpd-day { visibility: hidden; }
  .mpd-n { font-size: 10px; }
}
`;
