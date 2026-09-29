/**
 * RTO parcels the courier says came back, that nobody has scanned in.
 *
 * Stock we were told to expect and have not seen. Past the grace period that is
 * a claim against the courier, and the list is exportable so it can be sent as
 * one.
 *
 * The page is deliberately honest about its weakest input: the courier's own
 * return date would be the right clock, but the tracking sheet leaves Delivered
 * Date blank on every RTO row, so this ages from the ORDER date instead. That is
 * always earlier than the return, so a parcel can appear here before it is
 * genuinely claimable. Saying so is better than a confident wrong number that
 * gets sent to a courier.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams, useNavigation } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { claimCandidates, scanCountsToday } from "../utils/scan.server";
import { PnlStyles } from "../utils/pnl-styles";
import { ScanNav } from "../components/ScanNav";

const DAY_OPTIONS = [7, 14, 30, 45];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ rows: [], counts: {}, days: 7, totals: { cogs: "0", revenue: "0" }, scanned: 0 });

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("days") || 7);
  const days = DAY_OPTIONS.includes(requested) ? requested : 7;

  const res = await claimCandidates(shop, days);

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rup = (v: string | null) => (v == null ? "" : (Number(v) / 100).toFixed(2));
    const csv = [
      "order_name,awb,carrier,ordered_on,days_since_order,order_value,cogs",
      ...res.rows.map((r) =>
        [
          esc(r.orderName),
          esc(r.awb),
          esc(r.carrier),
          esc(r.orderedAt),
          String(r.daysOld),
          rup(r.revenueMinor),
          rup(r.cogsMinor),
        ].join(","),
      ),
    ].join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="rto-claims-${days}d.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const counts = await scanCountsToday(shop);
  return json({
    counts,
    days,
    rows: res.rows.slice(0, 500),
    totalRows: res.rows.length,
    scanned: res.scannedCount,
    totals: {
      cogs: res.totalCogsMinor.toString(),
      revenue: res.totalRevenueMinor.toString(),
    },
  });
};

const rup = (v: string | null | undefined) =>
  v == null ? "" : `₹${(Number(v) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default function Claims() {
  const d = useLoaderData<typeof loader>() as any;
  const [, setParams] = useSearchParams();
  const nav = useNavigation();
  const loading = nav.state === "loading";

  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <ScanNav active="claims" counts={d.counts} />

        <div className="pnl-scan-toolbar">
          <select
            className="pnl-select"
            value={d.days}
            disabled={loading}
            onChange={(e) => setParams({ days: e.target.value })}
          >
            {DAY_OPTIONS.map((n) => (
              <option key={n} value={n}>
                Unscanned after {n} days
              </option>
            ))}
          </select>
          <a className="pnl-btn" href={`/pnl-app/scan/claims?days=${d.days}&format=csv`}>
            Export for courier
          </a>
        </div>

        <div className="pnl-panel" style={{ marginBottom: 14 }}>
          <div className="pnl-section-label">Not received</div>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 8 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {(d.totalRows || 0).toLocaleString("en-IN")}
              </div>
              <div className="pnl-sub">parcels</div>
            </div>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{rup(d.totals.cogs)}</div>
              <div className="pnl-sub">stock cost at risk</div>
            </div>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>{rup(d.totals.revenue)}</div>
              <div className="pnl-sub">order value</div>
            </div>
          </div>
        </div>

        {/* The clock is the weak input, so it is stated rather than buried. */}
        <div className="pnl-help" style={{ marginBottom: 14 }}>
          Counted from the <strong>order date</strong>, not the date the courier returned the
          parcel. The tracking sheet leaves Delivered Date blank on every RTO row, so there is no
          return date to read yet. An order date is always earlier than its return, so a parcel can
          show up here before it is genuinely claimable. Run{" "}
          <strong>backfillDeliveryDates</strong> in the tracking script and this becomes exact.
        </div>

        {d.scanned > 0 && (
          <p className="pnl-sub" style={{ marginBottom: 12 }}>
            {d.scanned.toLocaleString("en-IN")} of these were scanned in and are excluded.
          </p>
        )}

        <div className="pnl-panel">
          {d.rows.length === 0 ? (
            <p className="pnl-sub" style={{ margin: 0 }}>
              Nothing to claim. Every returned parcel older than {d.days} days has been scanned in.
            </p>
          ) : (
            <>
              <div className="pnl-table-wrap">
                <table className="pnl-table">
                  <thead>
                    <tr>
                      <th>Order</th>
                      <th>AWB</th>
                      <th>Carrier</th>
                      <th>Ordered</th>
                      <th className="pnl-num">Days</th>
                      <th className="pnl-num">Value</th>
                      <th className="pnl-num">Stock cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r: any) => (
                      <tr key={r.awb}>
                        <td>{r.orderName}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>{r.awb}</td>
                        <td>{r.carrier || <span className="pnl-muted">unknown</span>}</td>
                        <td style={{ whiteSpace: "nowrap" }}>{r.orderedAt}</td>
                        <td className="pnl-num">{r.daysOld}</td>
                        <td className="pnl-num">{rup(r.revenueMinor)}</td>
                        <td className="pnl-num">
                          {r.cogsMinor == null ? <span className="pnl-muted">unknown</span> : rup(r.cogsMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {d.totalRows > d.rows.length && (
                <p className="pnl-sub" style={{ marginTop: 10, fontSize: 12 }}>
                  Showing the oldest {d.rows.length} of {d.totalRows.toLocaleString("en-IN")}. The
                  export has all of them.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
