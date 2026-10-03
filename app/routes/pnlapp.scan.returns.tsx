/**
 * Inbound parcels: one scanner for both RTO and customer returns.
 *
 * No tabs, because the operator should not have to classify a parcel by eye and
 * the data already knows. Measured on live data: of 3,000 RTO orders only 4
 * (0.1%) also carried a ReturnHQ request, and of orders WITH a request 2,381 of
 * 2,405 had been delivered first. The two signals barely overlap.
 *
 * The verdict is shown with its REASON, so a wrong call is visible rather than
 * silently filed. A parcel the data cannot place is marked "CHECK" instead of
 * being guessed at confidently.
 *
 * Neither kind writes OrderFinancials.deliveryStatus: the tracking sheet owns
 * that column and the twice-daily cron would overwrite anything put there.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import {
  listSessions,
  loadScannedSet,
  recordScan,
  scanCountsToday,
  sessionScans,
} from "../utils/scan.server";
import { ClaimsStyles } from "../components/ClaimsStyles";
import { BusyBar } from "../components/BusyBar";
import { ScanPad } from "../components/ScanPad";
import { ScanNav } from "../components/ScanNav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  // Both kinds: an inbound scan can be filed either way, so a parcel already
  // booked in as an RTO must not be re-sent as a customer return.
  // ?session= reopens a batch: its scans come back so the operator can carry
  // on adding to the same one rather than starting a parallel list.
  const wanted = new URL(request.url).searchParams.get("session") || "";

  const [counts, rto, cr, sessions, reopenedRto, reopenedCr] = await Promise.all([
    shop ? scanCountsToday(shop) : Promise.resolve({}),
    shop ? loadScannedSet(shop, "rto") : Promise.resolve([]),
    shop ? loadScannedSet(shop, "customer-return") : Promise.resolve([]),
    shop ? listSessions(shop, "rto") : Promise.resolve([]),
    shop && wanted ? sessionScans(shop, "rto", wanted) : Promise.resolve([]),
    shop && wanted ? sessionScans(shop, "customer-return", wanted) : Promise.resolve([]),
  ]);

  // Both kinds, newest first: an inbound session holds RTOs and customer
  // returns together, and listSessions only groups one kind at a time.
  const reopened = [...reopenedRto, ...reopenedCr]
    .sort((a, b) => b.scannedAt.getTime() - a.scannedAt.getTime())
    .map((r) => ({
      awb: r.awb,
      orderName: r.orderName,
      kind: r.kind,
      result: r.result,
      at: new Date(r.scannedAt.getTime() + 5.5 * 60 * 60 * 1000)
        .toISOString()
        .slice(11, 16),
    }));

  return json({
    counts,
    alreadyScanned: [...rto, ...cr],
    sessions,
    reopened: wanted ? { name: wanted, rows: reopened } : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request, "scan")) return json({ error: "unauthorized" }, { status: 401 });
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ error: "not-configured" }, { status: 400 });

  const body = await request.json().catch(() => null);
  if (!body?.awb) return json({ error: "bad-request" }, { status: 400 });

  // "inbound" lets recordScan decide between rto and customer-return.
  // The session is what makes a batch a thing that can be reopened and
  // reported on. The client has been sending it; this never read it, so
  // every scan was filed under no batch at all.
  return json(
    await recordScan(shop, "inbound", String(body.awb), { session: String(body.session || "") }),
  );
};

export default function ReturnsScanner() {
  const d = useLoaderData<typeof loader>();

  return (
    <div className="claims-app">
      <ClaimsStyles />
      <BusyBar />
      <div className="wrap">
        <ScanNav active="returns" counts={d.counts} />

        <ScanPad
          kind="inbound"
          title="Inbound parcels"
          hint="Scan any parcel coming back. RTO or customer return is worked out for you."
          alreadyScanned={d.alreadyScanned}
          sessions={d.sessions}
          reopened={d.reopened}
        />
      </div>
    </div>
  );
}
