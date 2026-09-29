/**
 * RTO received and customer return received, on one page.
 *
 * Two tabs rather than two pages because it is one bench doing both jobs, often
 * alternating packet to packet. The KIND still differs in the database, so the
 * two are never conflated in a report.
 *
 * Neither writes OrderFinancials.deliveryStatus. The tracking sheet owns that
 * column and the twice-daily cron would overwrite anything put there, so a scan
 * that appeared to work would quietly revert. What a scan gives you instead is a
 * warehouse-confirmed timestamp, and a visible disagreement when the courier
 * says something different.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { recordScan, scanCountsToday, type ScanKind } from "../utils/scan.server";
import { PnlStyles } from "../utils/pnl-styles";
import { ScanPad } from "../components/ScanPad";
import { ScanNav } from "../components/ScanNav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const counts = app.shopDomain ? await scanCountsToday(app.shopDomain) : {};
  return json({ counts });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request, "scan")) return json({ error: "unauthorized" }, { status: 401 });
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ error: "not-configured" }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (!body?.awb) return json({ error: "bad-request" }, { status: 400 });

  // Validated, not trusted: the kind decides which bucket this lands in.
  const kind: ScanKind = body.kind === "customer-return" ? "customer-return" : "rto";
  const outcome = await recordScan(shop, kind, String(body.awb));
  return json(outcome);
};

export default function ReturnsScanner() {
  const d = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "customer" ? "customer-return" : "rto";

  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <ScanNav active="returns" counts={d.counts} />

        <div className="pnl-scan-tabs" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className={`pnl-scan-tab ${tab === "rto" ? "pnl-scan-tab--on" : ""}`}
            onClick={() => setParams({})}
          >
            RTO received
          </button>
          <button
            type="button"
            className={`pnl-scan-tab ${tab === "customer-return" ? "pnl-scan-tab--on" : ""}`}
            onClick={() => setParams({ tab: "customer" })}
          >
            Customer return received
          </button>
        </div>

        {/* key forces a fresh ScanPad per tab: carrying one tab's session list
            into the other would let an operator think a packet was already
            booked in under the wrong kind. */}
        <ScanPad
          key={tab}
          kind={tab as ScanKind}
          title={tab === "rto" ? "RTO received" : "Customer return received"}
          hint={
            tab === "rto"
              ? "Scan a parcel that came back undelivered."
              : "Scan a parcel a customer sent back."
          }
        />
      </div>
    </div>
  );
}
