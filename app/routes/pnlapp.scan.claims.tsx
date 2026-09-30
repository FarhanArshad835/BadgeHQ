/**
 * Parcels a courier says it delivered to us, that nobody has physically seen.
 *
 * Two lists, one page, because it is the same argument against the same kind of
 * counterparty:
 *
 *   RTO             - we sent it, the customer refused it, the courier says it
 *                     came back. Aged from the courier's RTO delivery date.
 *   Customer return - the customer sent it back, the courier collected it and
 *                     says it reached our warehouse. Aged from ReturnHQ's
 *                     carrier_received_at.
 *
 * In both cases the courier has stated, in their own data, that they handed the
 * parcel over. If nobody confirmed it on the bench past the grace period, that
 * is a claim, and the list exports as one.
 *
 * Each side ages from ITS OWN courier-stated arrival date, never from the order
 * date. Starting the clock on a date the courier never agreed to is how a claim
 * gets rejected.
 *
 * The two halves fail independently: ReturnHQ is a separate database, so an
 * outage there leaves the RTO list working, and the page says so rather than
 * showing an empty list that reads like good news.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams, useNavigation } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { claimCandidates, returnClaimCandidates, scanCountsToday } from "../utils/scan.server";
import { PnlStyles } from "../utils/pnl-styles";
import { ScanNav } from "../components/ScanNav";
import { ScanProgressBar } from "../components/ScanProgressBar";

/**
 * The grace period before a missing parcel is worth chasing.
 *
 * Labelled by what the operator is deciding — how long to wait — rather than
 * by the date arithmetic behind it. "Delivered to us over 7 days ago" made the
 * reader work out that a longer window means fewer, older, more certain
 * parcels; saying so directly is the whole job of the label.
 */
// "over N days ago" put two time words on one idea. One is enough: how long
// the parcel has been overdue.
const DAY_OPTIONS = [
  { days: 7, label: "Waiting 7+ days" },
  { days: 14, label: "Waiting 14+ days" },
  { days: 30, label: "Waiting 30+ days" },
  { days: 45, label: "Waiting 45+ days" },
];
const DAY_VALUES = DAY_OPTIONS.map((o) => o.days);
const TABS = ["rto", "returns"] as const;
type Tab = (typeof TABS)[number];

function csvResponse(filename: string, header: string, rows: string[][]) {
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [header, ...rows.map((r) => r.map(esc).join(","))].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;

  const url = new URL(request.url);
  const requested = Number(url.searchParams.get("days") || 7);
  const days = DAY_VALUES.includes(requested) ? requested : 7;
  const t = url.searchParams.get("tab");
  const tab: Tab = TABS.includes(t as Tab) ? (t as Tab) : "rto";

  const EMPTY = {
    tab,
    days,
    counts: {} as Record<string, number>,
    rows: [] as any[],
    totalRows: 0,
    scanned: 0,
    eligible: 0,
    undated: 0,
    inFlight: 0,
    available: true,
    totals: { cogs: "0", revenue: "0" },
  };
  if (!shop) return json(EMPTY);

  // Only the visible half is queried. ReturnHQ is a second database over the
  // network; loading it to render the RTO tab would slow every page view.
  if (tab === "returns") {
    const res = await returnClaimCandidates(shop, days);

    if (url.searchParams.get("format") === "csv") {
      return csvResponse(
        `return-claims-${days}d.csv`,
        "order_name,awb,carrier,return_type,courier_delivered_on,days_since",
        res.rows.map((r) => [
          r.orderName,
          r.awb,
          r.carrier,
          r.type,
          r.receivedAt,
          String(r.daysOld),
        ]),
      );
    }

    const counts = await scanCountsToday(shop);
    return json({
      ...EMPTY,
      counts,
      rows: res.rows.slice(0, 500),
      totalRows: res.rows.length,
      scanned: res.scannedCount,
      eligible: res.eligibleCount,
      inFlight: res.inFlight,
      available: res.available,
    });
  }

  const res = await claimCandidates(shop, days);

  if (url.searchParams.get("format") === "csv") {
    const rupee = (v: string | null) => (v == null ? "" : (Number(v) / 100).toFixed(2));
    return csvResponse(
      `rto-claims-${days}d.csv`,
      "order_name,awb,carrier,rto_received_on,days_since_received,order_value,cogs",
      res.rows.map((r) => [
        r.orderName,
        r.awb,
        r.carrier,
        r.receivedAt,
        String(r.daysOld),
        rupee(r.revenueMinor),
        rupee(r.cogsMinor),
      ]),
    );
  }

  const counts = await scanCountsToday(shop);
  return json({
    ...EMPTY,
    counts,
    rows: res.rows.slice(0, 500),
    totalRows: res.rows.length,
    scanned: res.scannedCount,
    eligible: res.eligibleCount,
    undated: res.undatedCount,
    totals: {
      cogs: res.totalCogsMinor.toString(),
      revenue: res.totalRevenueMinor.toString(),
    },
  });
};

const rup = (v: string | null | undefined) =>
  v == null
    ? ""
    : `\u20B9${(Number(v) / 100).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;

export default function Claims() {
  const d = useLoaderData<typeof loader>() as any;
  const [, setParams] = useSearchParams();
  const nav = useNavigation();
  const loading = nav.state === "loading";
  const isReturns = d.tab === "returns";

  const go = (next: Record<string, string>) =>
    setParams({ tab: d.tab, days: String(d.days), ...next });

  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <ScanNav active="claims" counts={d.counts} />

        <div className="pnl-tabs">
          <button
            className="pnl-tab"
            data-active={!isReturns}
            onClick={() => go({ tab: "rto" })}
            disabled={loading}
          >
            RTO parcels
          </button>
          <button
            className="pnl-tab"
            data-active={isReturns}
            onClick={() => go({ tab: "returns" })}
            disabled={loading}
          >
            Customer returns
          </button>
        </div>

        <div className="pnl-scan-toolbar">
          <select
            className="pnl-select"
            value={d.days}
            disabled={loading}
            onChange={(e) => go({ days: e.target.value })}
          >
            {DAY_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
          {/* The full question, spelled out. The dropdown only sets the "how
              long ago" part of it. */}
          <span className="pnl-sub" style={{ fontSize: 12.5 }}>
            since the courier marked it {isReturns ? "returned" : "RTO"} — still not scanned
          </span>
          <a
            className="pnl-btn"
            href={`/pnl-app/scan/claims?tab=${d.tab}&days=${d.days}&format=csv`}
          >
            Export for courier
          </a>
        </div>

        {d.eligible > 0 && (
          <ScanProgressBar
            scanned={d.scanned}
            unscanned={d.totalRows}
            undated={isReturns ? 0 : d.undated}
            graceDays={d.days}
            noun={isReturns ? "returned by the customer" : "RTO"}
          />
        )}

        <div className="pnl-panel" style={{ marginBottom: 14 }}>
          <div className="pnl-section-label">
            {isReturns
              ? "Delivered back by the courier, never scanned in"
              : "Returned by courier, never scanned in"}
          </div>
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", marginTop: 8 }}>
            <div>
              <div style={{ fontSize: 28, fontWeight: 700 }}>
                {(d.totalRows || 0).toLocaleString("en-IN")}
              </div>
              <div className="pnl-sub">parcels</div>
            </div>
            {!isReturns && (
              <>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{rup(d.totals.cogs)}</div>
                  <div className="pnl-sub">stock cost at risk</div>
                </div>
                <div>
                  <div style={{ fontSize: 28, fontWeight: 700 }}>{rup(d.totals.revenue)}</div>
                  <div className="pnl-sub">order value</div>
                </div>
              </>
            )}
            {isReturns && d.inFlight > 0 && (
              <div>
                <div style={{ fontSize: 28, fontWeight: 700 }}>
                  {d.inFlight.toLocaleString("en-IN")}
                </div>
                <div className="pnl-sub">still on the way back</div>
              </div>
            )}
          </div>
        </div>

        {isReturns && !d.available && (
          <div className="pnl-help" style={{ marginBottom: 14 }}>
            <strong>This list could not be built</strong>, so the 0 above is not a real count —
            reload in a moment. Customer returns are the one part of this app that reads a second
            database, and that read failed. The RTO tab uses our own data and is unaffected.
          </div>
        )}

        {/* Coverage, not the clock, is the caveat on the RTO side. */}
        {!isReturns && d.undated > 0 && (
          <div className="pnl-help" style={{ marginBottom: 14 }}>
            <strong>{d.undated.toLocaleString("en-IN")} returned parcels are not shown</strong>{" "}
            because the courier has not given a return date for them. Counting those from anything
            else would start the claim clock on a date the courier never agreed to. Run{" "}
            <strong>backfillDeliveryDates</strong> in the tracking script to fill them in.
          </div>
        )}

        {isReturns && d.inFlight > 0 && (
          <p className="pnl-sub" style={{ marginBottom: 12 }}>
            {d.inFlight.toLocaleString("en-IN")} returns were picked up from the customer but the
            courier has not yet said they reached us. Those are not claimable: the courier is still
            carrying them.
          </p>
        )}

        <div className="pnl-panel">
          {d.rows.length === 0 ? (
            <p className="pnl-sub" style={{ margin: 0 }}>
              {isReturns
                ? d.available
                  ? `Nothing to claim. Every return the courier delivered more than ${d.days} days ago has been scanned in.`
                  : "Nothing to show."
                : d.undated > 0
                  ? "No claimable parcels yet: none of the returned parcels carry a courier return date."
                  : `Nothing to claim. Every parcel the courier returned more than ${d.days} days ago has been scanned in.`}
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
                      {isReturns && <th>Type</th>}
                      <th>{isReturns ? "Courier delivered" : "RTO received"}</th>
                      <th className="pnl-num">Days</th>
                      {!isReturns && <th className="pnl-num">Value</th>}
                      {!isReturns && <th className="pnl-num">Stock cost</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {d.rows.map((r: any, i: number) => (
                      <tr key={(r.awb || r.orderName) + i}>
                        <td>{r.orderName}</td>
                        <td style={{ fontVariantNumeric: "tabular-nums" }}>
                          {r.awb || <span className="pnl-muted">none</span>}
                        </td>
                        <td>{r.carrier || <span className="pnl-muted">unknown</span>}</td>
                        {isReturns && <td>{r.type}</td>}
                        <td style={{ whiteSpace: "nowrap" }}>{r.receivedAt}</td>
                        <td className="pnl-num">{r.daysOld}</td>
                        {!isReturns && <td className="pnl-num">{rup(r.revenueMinor)}</td>}
                        {!isReturns && (
                          <td className="pnl-num">
                            {r.cogsMinor == null ? (
                              <span className="pnl-muted">unknown</span>
                            ) : (
                              rup(r.cogsMinor)
                            )}
                          </td>
                        )}
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
