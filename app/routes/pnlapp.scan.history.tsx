/**
 * Everything scanned, filterable, with a CSV download.
 *
 * The scanners deliberately do not change order status, so this page is where
 * the value currently sits: a warehouse-confirmed record that can be compared
 * against what the courier sheet claims.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { recentScans, scanCountsToday, type ScanKind } from "../utils/scan.server";
import { PnlStyles } from "../utils/pnl-styles";
import { ScanNav } from "../components/ScanNav";

const KINDS: Record<string, string> = {
  dispatch: "Dispatch",
  rto: "RTO received",
  "customer-return": "Customer return",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ rows: [], counts: {}, kind: "" });

  const url = new URL(request.url);
  const raw = url.searchParams.get("kind") || "";
  const kind = (["dispatch", "rto", "customer-return"].includes(raw) ? raw : null) as ScanKind | null;

  const rows = await recentScans(shop, kind, 500);

  if (url.searchParams.get("format") === "csv") {
    const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const IST = 5.5 * 60 * 60 * 1000;
    const csv = [
      "scanned_ist,kind,awb,order_name,result,note",
      ...rows.map((r) =>
        [
          esc(new Date(r.scannedAt.getTime() + IST).toISOString().slice(0, 19).replace("T", " ")),
          esc(r.kind),
          esc(r.awb),
          esc(r.orderName),
          esc(r.result),
          esc(r.note),
        ].join(","),
      ),
    ].join("\n");
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="scans${kind ? "-" + kind : ""}.csv"`,
        "Cache-Control": "no-store",
      },
    });
  }

  const counts = await scanCountsToday(shop);
  return json({
    counts,
    kind: kind || "",
    rows: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      awb: r.awb,
      orderName: r.orderName,
      result: r.result,
      note: r.note,
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
  result: string;
  note: string;
  at: string;
};

export default function ScanHistory() {
  const d = useLoaderData<typeof loader>() as {
    rows: Row[];
    counts: Record<string, number>;
    kind: string;
  };
  const [params, setParams] = useSearchParams();
  const kind = params.get("kind") || "";

  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <ScanNav active="history" counts={d.counts} />

        <div className="pnl-scan-toolbar">
          <select
            className="pnl-select"
            value={kind}
            onChange={(e) => {
              const v = e.target.value;
              setParams(v ? { kind: v } : {});
            }}
          >
            <option value="">All scans</option>
            <option value="dispatch">Dispatch</option>
            <option value="rto">RTO received</option>
            <option value="customer-return">Customer return</option>
          </select>
          <a
            className="pnl-btn"
            href={`/pnl-app/scan/history?format=csv${kind ? `&kind=${kind}` : ""}`}
          >
            Export CSV
          </a>
        </div>

        <div className="pnl-panel">
          {d.rows.length === 0 ? (
            <p className="pnl-sub" style={{ margin: 0 }}>Nothing scanned yet.</p>
          ) : (
            <div className="pnl-table-wrap">
              <table className="pnl-table">
                <thead>
                  <tr>
                    <th>When (IST)</th>
                    <th>Type</th>
                    <th>AWB</th>
                    <th>Order</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {d.rows.map((r) => (
                    <tr key={r.id}>
                      <td style={{ whiteSpace: "nowrap" }}>{r.at}</td>
                      <td>{KINDS[r.kind] || r.kind}</td>
                      <td>{r.awb}</td>
                      <td>{r.orderName || <span className="pnl-muted">not in orders</span>}</td>
                      <td className={`pnl-scan-result pnl-scan-result--${r.result}`}>{r.result}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
