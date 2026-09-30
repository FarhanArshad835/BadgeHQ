/**
 * Dispatch scanner.
 *
 * Blocks any AWB already handed to a courier. Verified against the live sheet:
 * 2,956 AWBs across Delhivery, Bluedart, Shiprocket, Xpressbees and Ecom, so
 * scanning one here means a packet is about to be sent twice.
 *
 * The blocklist is preloaded into the page, so that rejection is decided with no
 * network at all. The server still records the scan and still has the final say.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import { loadDispatchedSet, recordScan, syncDispatchedAwbs, scanCountsToday , recordScanBulk} from "../utils/scan.server";
import { PnlStyles } from "../utils/pnl-styles";
import { ScanPad } from "../components/ScanPad";
import { BulkScan } from "../components/BulkScan";
import { ScanNav } from "../components/ScanNav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request, "scan")) return redirect("/pnl-app/scan/login");
  const app = await getPnlApp();
  const shop = app.shopDomain;
  // This first query also wakes the database while the operator is still
  // reaching for the first packet, so the cold connection is never felt.
  const [dispatched, counts] = await Promise.all([
    shop ? loadDispatchedSet(shop) : Promise.resolve([]),
    shop ? scanCountsToday(shop) : Promise.resolve({}),
  ]);
  return json({
    dispatched,
    counts,
    hasSheet: Boolean(app.dispatchSheetUrl),
    syncedCount: dispatched.length,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request, "scan")) return json({ error: "unauthorized" }, { status: 401 });
  const app = await getPnlApp();
  const shop = app.shopDomain;
  if (!shop) return json({ error: "not-configured" }, { status: 400 });

  // A scan arrives as JSON from ScanPad; the sync button posts a form.
  const type = request.headers.get("Content-Type") || "";
  if (type.includes("application/json")) {
    const body = await request.json().catch(() => null);
    if (body?.bulk) {
      return json(await recordScanBulk(shop, "dispatch", String(body.bulk)));
    }
    if (!body?.awb) return json({ error: "bad-request" }, { status: 400 });
    const outcome = await recordScan(shop, "dispatch", String(body.awb));
    return json(outcome);
  }

  const form = await request.formData();
  if (String(form.get("intent")) === "sync") {
    const res = await syncDispatchedAwbs(shop, app.dispatchSheetUrl);
    return json(res);
  }
  return json({ error: "unknown-intent" }, { status: 400 });
};

export default function DispatchScanner() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const syncing = nav.state !== "idle";

  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap">
        <ScanNav active="dispatch" counts={d.counts} />

        {!d.hasSheet && (
          <div className="pnl-help" style={{ marginBottom: 12 }}>
            No dispatch sheet URL saved yet. Add it in Profit and Loss settings to load the
            already-dispatched list, otherwise nothing can be blocked.
          </div>
        )}

        <div className="pnl-scan-toolbar">
          <span className="pnl-sub">
            {d.syncedCount.toLocaleString("en-IN")} already-dispatched AWBs loaded
          </span>
          <button
            type="button"
            className="pnl-btn"
            disabled={syncing || !d.hasSheet}
            onClick={() => submit({ intent: "sync" }, { method: "POST" })}
          >
            {syncing ? "Syncing…" : "Sync dispatched list"}
          </button>
        </div>

        <ScanPad
          kind="dispatch"
          title="Dispatch"
          hint="Scan a packet before it goes out."
          dispatched={d.dispatched}
        />

        <BulkScan kind="dispatch" label="Paste a list of AWBs instead" />
      </div>
    </div>
  );
}
