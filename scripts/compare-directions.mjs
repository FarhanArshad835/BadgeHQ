/**
 * Five forward and five reverse parcels per courier, picked at random, with
 * their fields compared.
 *
 * The point is to find which field ACTUALLY separates a parcel the customer
 * sent back from one the courier could not deliver - not to confirm a guess.
 * So samples are labelled from ground truth we already hold, never from the
 * carrier payload being tested:
 *
 *   reverse = ReturnHQ holds a live request for the order
 *   forward = it does not
 *
 * Then it reports which fields hold one value across every reverse sample and
 * a different one across every forward sample. A field that does that is the
 * separator worth coding against.
 *
 * Read-only.
 *
 *   node scripts/compare-directions.mjs
 *   node scripts/compare-directions.mjs --n 5 --dump
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const argN = process.argv.indexOf("--n");
const N = argN > -1 ? Number(process.argv[argN + 1]) || 5 : 5;
const DUMP = process.argv.includes("--dump");

function envVar(key) {
  if (process.env[key]) return process.env[key];
  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(new RegExp("^" + key + '="?([^"\n]+)"?', "m"));
    if (m) return m[1];
  }
  return null;
}

const dbUrl = envVar("DATABASE_URL");
const rhqUrl = envVar("RETURNHQ_DATABASE_URL");
if (!dbUrl) {
  console.error("DATABASE_URL not found.");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const rhq = rhqUrl ? new PrismaClient({ datasources: { db: { url: rhqUrl } } }) : null;
const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: {
    shiprocketEmail: true,
    shiprocketPassword: true,
    delhiveryApiKey: true,
    shadowfaxApiToken: true,
  },
});

/** Orders ReturnHQ holds a live request for: the customer sent these back. */
async function returnhqOrders() {
  if (!rhq) return new Set();
  try {
    const rows = await rhq.$queryRawUnsafe(
      "SELECT DISTINCT shopify_order_number AS n FROM return_requests WHERE shop_id = 3 AND status::text <> 'cancelled'",
    );
    return new Set(rows.map((r) => String(r.n || "").trim()).filter(Boolean));
  } catch (e) {
    console.error("ReturnHQ unreadable:", String((e && e.message) || e).slice(0, 140));
    return new Set();
  }
}

function courierOf(awb) {
  const a = String(awb).trim();
  if (a.toUpperCase().startsWith("SF")) return "shadowfax";
  if (a.startsWith("2606")) return "delhivery";
  return "shiprocket";
}

let SR = null;
async function srToken() {
  if (SR) return SR;
  if (!app || !app.shiprocketEmail || !app.shiprocketPassword) return null;
  const r = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: app.shiprocketEmail, password: app.shiprocketPassword }),
  });
  if (!r.ok) return null;
  SR = (await r.json().catch(() => ({}))).token || null;
  return SR;
}

async function raw(courier, awb) {
  try {
    if (courier === "delhivery") {
      if (!app || !app.delhiveryApiKey) return null;
      const r = await fetch(
        "https://track.delhivery.com/api/v1/packages/json/?waybill=" + encodeURIComponent(awb),
        { headers: { Authorization: "Token " + app.delhiveryApiKey } },
      );
      if (!r.ok) return null;
      const d = await r.json().catch(() => ({}));
      const sd = d.ShipmentData || [];
      return (sd[0] && sd[0].Shipment) || null;
    }
    if (courier === "shadowfax") {
      if (!app || !app.shadowfaxApiToken) return null;
      const r = await fetch("https://dale.shadowfax.in/api/v4/clients/bulk_track/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Token " + app.shadowfaxApiToken,
        },
        body: JSON.stringify({ awb_numbers: [awb] }),
      });
      if (!r.ok) return null;
      const d = await r.json().catch(() => ({}));
      return (d.data && d.data[0]) || null;
    }
    const t = await srToken();
    if (!t) return null;
    const r = await fetch(
      "https://apiv2.shiprocket.in/v1/external/courier/track/awb/" + encodeURIComponent(awb),
      { headers: { Authorization: "Bearer " + t } },
    );
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return d.tracking_data || null;
  } catch {
    return null;
  }
}

/** The fields worth comparing, flattened per courier. */
function summarise(courier, b) {
  if (!b) return null;
  if (courier === "delhivery") {
    const scans = Array.isArray(b.Scans) ? b.Scans.map((x) => x.ScanDetail || {}) : [];
    const last = scans[scans.length - 1] || {};
    const st = b.Status || {};
    return {
      OrderType: b.OrderType ?? null,
      status: st.Status ?? null,
      statusType: st.StatusType ?? null,
      reverseInTransit: b.ReverseInTransit ?? null,
      refHasR: /-R$|^R/i.test(String(b.ReferenceNo || "")),
      lastScan: last.Scan ?? null,
      lastScanType: last.ScanType ?? null,
      scanTypes: [...new Set(scans.map((s) => s.ScanType).filter(Boolean))].sort().join(","),
      everOFD: scans.some((s) => /out for delivery/i.test(String(s.Instructions || ""))),
      everOFP: scans.some((s) => /out for pickup/i.test(String(s.Instructions || ""))),
    };
  }
  if (courier === "shiprocket") {
    const st = (b.shipment_track && b.shipment_track[0]) || {};
    const acts = b.shipment_track_activities || [];
    return {
      is_return: b.is_return ?? null,
      ndrReason: (b.ndr && b.ndr.reason) || "",
      nprReason: (b.npr && b.npr.reason) || "",
      currentStatus: st.current_status ?? null,
      currentStatusId: st.current_status_id ?? null,
      returnAwb: st.return_awb_code || "",
      shipmentStatus: b.shipment_status ?? null,
      everOFD: acts.some((a) => /out for delivery/i.test(String(a.activity || ""))),
      everOFP: acts.some((a) => /out for pickup/i.test(String(a.activity || ""))),
    };
  }
  const trail = b.tracking_details || [];
  const ids = trail.map((x) => String(x.status_id || "").toLowerCase());
  return {
    status: b.status ?? null,
    statusDisplay: b.status_display ?? null,
    firstStatusId: ids[0] ?? null,
    everOFD: ids.includes("ofd"),
    everAssignedDelivery: ids.includes("assigned_for_delivery"),
    everSellerPickup: ids.includes("assigned_for_seller_pickup"),
    everRevHub: ids.some((i) => i.includes("rev_hub")),
    hasReturnReason: (b.product_details || []).some((p) => !!p.return_reason),
  };
}

const rhqSet = await returnhqOrders();
console.log("ReturnHQ orders with a live request:", rhqSet.size);

const scans = await prisma.scanEvent.findMany({
  where: { shop: SHOP, result: "ok", kind: { in: ["rto", "customer-return"] } },
  select: { awb: true, orderName: true, kind: true },
  orderBy: { scannedAt: "desc" },
  take: 4000,
});
console.log("scans available:", scans.length);

const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

for (const courier of ["delhivery", "shiprocket", "shadowfax"]) {
  const mine = scans.filter((s) => courierOf(s.awb) === courier);
  // Ground truth, best available. ReturnHQ is authoritative where we can read
  // it; where we cannot, the operator's own filing is the next best label, and
  // it is still independent of the carrier payload under test.
  const reverse = mine.filter(
    (s) => rhqSet.has(s.orderName) || s.kind === "customer-return",
  );
  const forward = mine.filter(
    (s) => !rhqSet.has(s.orderName) && s.kind === "rto",
  );

  console.log("\n" + "#".repeat(70));
  console.log(
    "##",
    courier.toUpperCase(),
    "| reverse pool",
    reverse.length,
    "| forward pool",
    forward.length,
  );
  console.log("#".repeat(70));

  const groups = { REVERSE: [], FORWARD: [] };
  for (const [label, pool] of [
    ["REVERSE", reverse],
    ["FORWARD", forward],
  ]) {
    for (const s of pick(pool, N)) {
      const body = await raw(courier, s.awb);
      const sum = summarise(courier, body);
      if (!sum) continue;
      groups[label].push({ awb: s.awb, order: s.orderName, filedAs: s.kind, ...sum });
      if (DUMP) {
        console.log("\n--- RAW " + label + " " + s.awb + " (" + s.orderName + ") ---");
        console.log(JSON.stringify(body, null, 2));
      }
    }
    console.log("\n" + label + " (" + groups[label].length + " answered)");
    for (const r of groups[label]) console.log("  ", JSON.stringify(r));
  }

  const keys = new Set();
  for (const g of Object.values(groups)) for (const r of g) for (const k of Object.keys(r)) keys.add(k);
  console.log("\n>>> fields that separate the two groups:");
  let found = 0;
  for (const k of keys) {
    if (["awb", "order", "filedAs"].includes(k)) continue;
    const rv = new Set(groups.REVERSE.map((r) => JSON.stringify(r[k])));
    const fw = new Set(groups.FORWARD.map((r) => JSON.stringify(r[k])));
    if (!rv.size || !fw.size) continue;
    if (![...rv].some((v) => fw.has(v))) {
      found++;
      console.log("    " + k + ":  reverse=" + [...rv].join("|") + "   forward=" + [...fw].join("|"));
    }
  }
  if (!found) console.log("    (none cleanly separates them in this sample)");
}

await prisma.$disconnect();
if (rhq) await rhq.$disconnect();
