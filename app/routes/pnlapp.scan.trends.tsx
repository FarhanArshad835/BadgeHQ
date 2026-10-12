/**
 * How many parcels go missing each day.
 *
 * Its own screen rather than a strip above the Claims list: Claims answers
 * "which parcels do I chase today", this answers "is today normal". Squeezed
 * over a table the chart could only afford ten bars and half the width; given
 * a page it can run a month and carry the numbers that explain a spike.
 *
 * Counted on the COURIER's date, not the scan date. A parcel marked returned
 * on the 4th that nobody scanned belongs to the 4th however long it stays
 * missing, which is what makes the series a rate rather than a backlog.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { scanCountsToday, missingPerDay } from "../utils/scan.server";
import { ClaimsStyles } from "../components/ClaimsStyles";
import { ScanNav } from "../components/ScanNav";
import { BusyBar, useBusy } from "../components/BusyBar";

const SPANS = [10, 30, 60] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ days: [] as DayRow[], counts: {}, span: 30 });

  const url = new URL(request.url);
  const raw = Number(url.searchParams.get("span") || 30);
  const span = (SPANS as readonly number[]).includes(raw) ? raw : 30;

  const [counts, days] = await Promise.all([scanCountsToday(shop), missingPerDay(shop, span)]);
  return json({ counts, span, days });
};

type DayRow = {
  day: string;
  returned: number;
  found: number;
  missing: number;
  costMinor: string | null;
};

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

function dayLabel(iso: string): string {
  const d = new Date(iso + "T00:00:00Z");
  return `${d.getUTCDate()} ${d.toLocaleString("en-GB", { month: "short", timeZone: "UTC" })}`;
}
function weekday(iso: string): string {
  return new Date(iso + "T00:00:00Z").toLocaleString("en-GB", { weekday: "short", timeZone: "UTC" });
}

export default function Trends() {
  const busy = useBusy();
  const d = useLoaderData<typeof loader>() as {
    days: DayRow[];
    counts: Record<string, number>;
    span: number;
  };
  const [, setParams] = useSearchParams();

  const rows = d.days;
  const peak = Math.max(1, ...rows.map((r) => r.missing));
  const totalMissing = rows.reduce((s, r) => s + r.missing, 0);
  const totalReturned = rows.reduce((s, r) => s + r.returned, 0);
  const cost = rows.reduce((s, r) => s + Number(r.costMinor || 0), 0) / 100;
  // Averaged over days that saw any returns. The newest day is usually still
  // filling, and a flat mean over the span would drag toward zero and make the
  // run look better than it is.
  const active = rows.filter((r) => r.returned > 0).length;
  const perDay = active ? totalMissing / active : 0;
  const worst = rows.reduce<DayRow | null>((a, b) => (!a || b.missing > a.missing ? b : a), null);
  const rate = totalReturned ? (totalMissing / totalReturned) * 100 : 0;

  return (
    <div className="claims-app">
      <ClaimsStyles />
      <BusyBar />
      <div className="wrap">
        <ScanNav active="trends" counts={d.counts} />

        <div className="controls">
          <div className="chips">
            {SPANS.map((s) => (
              <button
                key={s}
                className={"chip" + (d.span === s ? " active" : "")}
                disabled={busy}
                onClick={() => setParams({ span: String(s) })}
              >
                {s} days
              </button>
            ))}
          </div>
        </div>

        {!rows.length ? (
          <div className="table-card">
            <div className="empty" style={{ padding: 28 }}>
              No returns recorded in this span.
            </div>
          </div>
        ) : (
          <>
            <div className="tr-stats">
              <div className="tr-stat">
                <div className="tr-k">Went missing</div>
                <div className="tr-v">{totalMissing.toLocaleString("en-IN")}</div>
                <div className="tr-s">of {totalReturned.toLocaleString("en-IN")} returned</div>
              </div>
              <div className="tr-stat">
                <div className="tr-k">A day</div>
                <div className="tr-v">{perDay.toFixed(1)}</div>
                <div className="tr-s">over {active} active days</div>
              </div>
              <div className="tr-stat">
                <div className="tr-k">Miss rate</div>
                <div className="tr-v">{rate.toFixed(1)}%</div>
                <div className="tr-s">of parcels sent back</div>
              </div>
              <div className="tr-stat">
                <div className="tr-k">Stock at risk</div>
                <div className="tr-v">{cost > 0 ? inr(cost) : "unknown"}</div>
                <div className="tr-s">where cost is known</div>
              </div>
              {worst && worst.missing > 0 && (
                <div className="tr-stat">
                  <div className="tr-k">Worst day</div>
                  <div className="tr-v">{worst.missing}</div>
                  <div className="tr-s">
                    {weekday(worst.day)} {dayLabel(worst.day)}
                  </div>
                </div>
              )}
            </div>

            {/* Bar height is MISSING alone. Scaling it by the day's total made
                a day where everything was found draw as tall as a bad one. */}
            <div className="tr-chart" role="img" aria-label={`Parcels unaccounted for on each of the last ${d.span} days. The table below lists every value.`}>
              {rows.map((r) => (
                <div key={r.day} className="tr-col" title={`${r.missing} missing of ${r.returned} returned — ${weekday(r.day)} ${dayLabel(r.day)}`}>
                  <div className="tr-n">{r.missing || ""}</div>
                  <div className="tr-bar" style={{ height: `${(r.missing / peak) * 100}%` }} />
                  <div className="tr-d">{dayLabel(r.day)}</div>
                </div>
              ))}
            </div>

            {/* Every value is here too, so nothing is reachable only by
                hovering a bar. */}
            <div className="table-card">
              <table>
                <thead>
                  <tr>
                    <th>Day</th>
                    <th className="num">Marked returned</th>
                    <th className="num">Scanned in</th>
                    <th className="num">Still missing</th>
                    <th className="num">Miss rate</th>
                    <th className="num">Stock cost</th>
                  </tr>
                </thead>
                <tbody>
                  {[...rows].reverse().map((r) => (
                    <tr key={r.day}>
                      <td className="c-when">
                        {weekday(r.day)} {dayLabel(r.day)}
                      </td>
                      <td className="num">{r.returned.toLocaleString("en-IN")}</td>
                      <td className="num">{r.found.toLocaleString("en-IN")}</td>
                      <td className="num">
                        <b>{r.missing.toLocaleString("en-IN")}</b>
                      </td>
                      <td className="num">
                        {r.returned ? ((r.missing / r.returned) * 100).toFixed(0) + "%" : "—"}
                      </td>
                      <td className="num">
                        {Number(r.costMinor || 0) > 0 ? (
                          inr(Number(r.costMinor) / 100)
                        ) : (
                          <span className="unknown">unknown</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.claims-app .tr-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 10px; margin-top: 12px; }
.claims-app .tr-stat { border: 1px solid var(--line); border-radius: 9px; padding: 10px 12px; background: var(--surface); }
.claims-app .tr-k { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
.claims-app .tr-v { font-size: 22px; font-weight: 650; line-height: 1.15; margin-top: 3px; font-variant-numeric: tabular-nums; }
.claims-app .tr-s { font-size: 11px; color: var(--muted); margin-top: 1px; }
.claims-app .tr-chart {
  display: flex; align-items: flex-end; gap: 4px; height: 220px;
  border: 1px solid var(--line); border-radius: 10px; background: var(--surface);
  padding: 14px 12px 6px; margin-top: 10px; overflow-x: auto;
}
.claims-app .tr-col { flex: 1 0 20px; min-width: 20px; height: 100%; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; }
.claims-app .tr-bar { width: 100%; max-width: 40px; min-height: 2px; background: #3b4bc8; border-radius: 4px 4px 0 0; transition: opacity .12s; }
.claims-app .tr-col:hover .tr-bar { opacity: .78; }
.claims-app .tr-n { font-size: 11px; font-weight: 600; min-height: 15px; font-variant-numeric: tabular-nums; }
.claims-app .tr-d { font-size: 10px; color: var(--muted); margin-top: 4px; white-space: nowrap; }
@media (max-width: 760px) {
  .claims-app .tr-chart { height: 170px; gap: 2px; }
  /* Labels collide long before the bars do, so thin them rather than the data. */
  .claims-app .tr-col:not(:nth-child(5n+1)) .tr-d { visibility: hidden; }
  .claims-app .tr-n { font-size: 9px; }
  .claims-app .tr-v { font-size: 18px; }
}
`;
