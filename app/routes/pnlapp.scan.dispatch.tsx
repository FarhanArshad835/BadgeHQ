/**
 * Dispatch scanner.
 *
 * Blocks any AWB already handed to a courier. Verified against the live sheet:
 * ~2,950 AWBs across Delhivery, Bluedart, Shiprocket, Xpressbees and Ecom, so
 * scanning one here means a packet is about to be sent twice.
 *
 * The blocklist is preloaded into the page, so that rejection is decided with
 * no network at all. The server still records the scan and still has the final
 * say.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { getPnlApp, isAuthed } from "../utils/pnl-app.server";
import {
  loadDispatchedSet,
  recordScan,
  syncDispatchedAwbs,
  scanCountsToday,
} from "../utils/scan.server";
import { ClaimsStyles } from "../components/ClaimsStyles";
import { ScanPad } from "../components/ScanPad";
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
    if (!body?.awb) return json({ error: "bad-request" }, { status: 400 });
    return json(await recordScan(shop, "dispatch", String(body.awb)));
  }

  const form = await request.formData();
  if (String(form.get("intent")) === "sync") {
    return json(await syncDispatchedAwbs(shop, app.dispatchSheetUrl));
  }
  return json({ error: "unknown-intent" }, { status: 400 });
};

export default function DispatchScanner() {
  const d = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const nav = useNavigation();
  const syncing = nav.state !== "idle";

  return (
    <div className="claims-app">
      <ClaimsStyles />
      <div className="wrap">
        <ScanNav active="dispatch" counts={d.counts} />

        <ScanPad
          kind="dispatch"
          title="Dispatch"
          hint="Scan each packet as it goes out."
          dispatched={d.dispatched}
          toolbar={
            <div className="sp-toolbar">
              <span>
                <b>{d.syncedCount.toLocaleString("en-IN")}</b> already-dispatched AWBs loaded
                {!d.hasSheet && (
                  <span className="sub">
                    {" "}
                    · No dispatch sheet saved in Settings, so nothing can be blocked.
                  </span>
                )}
              </span>
              <button
                className="btn-ghost"
                disabled={syncing || !d.hasSheet}
                onClick={() => submit({ intent: "sync" }, { method: "POST" })}
              >
                {syncing ? "Syncing…" : "Sync dispatched list"}
              </button>
            </div>
          }
          help={
            <>
              Every scan marks the packet dispatched. A packet on the already-dispatched list shows{" "}
              <b>STOP</b> at once, without waiting for the network, so nothing goes out twice.
            </>
          }
        />
      </div>
    </div>
  );
}
