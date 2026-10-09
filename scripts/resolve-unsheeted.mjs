/**
 * Resolve orders the tracking sheet has never covered, by asking the carrier.
 *
 * The delivery sync can only report what the sheet knows, and a handful of
 * AWBs never reach it — 51 since July, 42 of them sitting at "unknown" while
 * the carrier has them delivered. #226130 / SF39238010474 is one: Shadowfax
 * says delivered 7 September, the sheet has no row for it at all, so no
 * amount of re-running the tracking job will ever fix it.
 *
 * This goes straight to the carriers for exactly those orders and writes the
 * outcome, using the same prefix routing and the same Shadowfax -> Shiprocket
 * fallback the tracking script uses.
 *
 * rtoReceivedAt is written for an RTO only, matching the importer: a return
 * still moving has not arrived, and dating it would start the claim clock
 * early.
 *
 *   node scripts/resolve-unsheeted.mjs            # dry run
 *   node scripts/resolve-unsheeted.mjs --write    # apply
 *   node scripts/resolve-unsheeted.mjs --since 2026-07-01
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write");
const sinceArg = process.argv.indexOf("--since");
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : "2026-07-01";

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
if (!dbUrl) {
  console.error("DATABASE_URL not found.");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

console.log(WRITE ? "MODE: WRITE" : "MODE: dry run (pass --write to apply)");

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: {
    deliverySheetUrl: true,
    shiprocketEmail: true,
    shiprocketPassword: true,
    delhiveryApiKey: true,
    shadowfaxApiToken: true,
  },
});

// Which AWBs the sheet already covers. Anything in here is the sync's job.
const sheetText = await (await fetch(app.deliverySheetUrl)).text();
const sheetLines = sheetText.split(/\r?\n/);
const inSheet = new Set();
for (let i = 1; i < sheetLines.length; i++) {
  const k = (sheetLines[i].split(",")[0] || "").replace(/[^0-9a-zA-Z]/g, "");
  if (k) inSheet.add(k);
}
console.log("AWBs covered by the sheet:", inSheet.size.toLocaleString("en-IN"));

const candidates = (
  await prisma.orderFinancials.findMany({
    where: {
      shop: SHOP,
      awb: { not: "" },
      orderCreatedAt: { gte: new Date(SINCE + "T00:00:00Z") },
      deliveryStatus: { in: ["unknown", "in_transit", "no-awb"] },
    },
    select: { orderId: true, orderName: true, awb: true, deliveryStatus: true },
  })
).filter((o) => !inSheet.has(o.awb.replace(/[^0-9a-zA-Z]/g, "")));

console.log("unresolved orders the sheet has never seen:", candidates.length);
if (!candidates.length) {
  await prisma.$disconnect();
  process.exit(0);
}

let SR = null;
async function srToken() {
  if (SR !== null) return SR;
  if (!app.shiprocketEmail || !app.shiprocketPassword) return (SR = false);
  const r = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: app.shiprocketEmail, password: app.shiprocketPassword }),
  });
  SR = r.ok ? (await r.json().catch(() => ({}))).token || false : false;
  return SR;
}

/** The same vocabulary the importer maps, reduced to what we need here. */
function outcomeFrom(text) {
  const s = String(text || "").toLowerCase().replace(/[_\-\s]+/g, " ").trim();
  if (!s) return null;
  if (/\brto\b|\brts\b|\bdto\b|return(ed)? to (origin|seller|client)/.test(s)) {
    if (/in transit|in process|initiat|pending|returning/.test(s)) return "rto_in_transit";
    return "rto";
  }
  if (/\blost\b|untraceable|disposed|destroyed/.test(s)) return "lost";
  if (/\bcancel/.test(s)) return "cancelled";
  if (/\bnot delivered\b|\bundelivered\b/.test(s)) return "in_transit";
  if (/\bdelivered\b/.test(s)) return "delivered";
  return "in_transit";
}

async function askShadowfax(awb) {
  if (!app.shadowfaxApiToken) return null;
  const r = await fetch("https://dale.shadowfax.in/api/v4/clients/bulk_track/", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Token " + app.shadowfaxApiToken,
    },
    body: JSON.stringify({ awb_numbers: [awb] }),
  });
  if (!r.ok) return null;
  const row = ((await r.json().catch(() => ({}))).data || [])[0];
  if (!row) return null;
  const scans = row.tracking_details || [];
  const last = scans[scans.length - 1] || {};
  return {
    via: "shadowfax",
    status: row.status_display || row.status || "",
    outcome: outcomeFrom(row.status_display || row.status),
    at: last.created || null,
  };
}

async function askDelhivery(awb) {
  if (!app.delhiveryApiKey) return null;
  const r = await fetch(
    "https://track.delhivery.com/api/v1/packages/json/?waybill=" + encodeURIComponent(awb),
    { headers: { Authorization: "Token " + app.delhiveryApiKey } },
  );
  if (!r.ok) return null;
  const sd = ((await r.json().catch(() => ({}))).ShipmentData || [])[0];
  const s = sd && sd.Shipment;
  if (!s || !s.Status || !s.Status.Status) return null;
  const scans = s.Scans || [];
  const last = (scans[scans.length - 1] || {}).ScanDetail || {};
  // DL on the final scan is the handover; DTO means it came from the customer.
  const code = String(s.Status.Status).toUpperCase();
  const arrived =
    String(last.ScanType || "").toUpperCase() === "DL" &&
    /return accepted|delivered/i.test(String(last.Instructions || ""));
  let text = s.Status.Status;
  if (arrived && (code === "RTO" || code === "DTO")) text = code + " Delivered";
  return {
    via: "delhivery",
    status: text,
    outcome: outcomeFrom(text),
    at: last.ScanDateTime || s.Status.StatusDateTime || null,
  };
}

async function askShiprocket(awb) {
  const t = await srToken();
  if (!t) return null;
  const r = await fetch(
    "https://apiv2.shiprocket.in/v1/external/courier/track/awb/" + encodeURIComponent(awb),
    { headers: { Authorization: "Bearer " + t } },
  );
  if (!r.ok) return null;
  const td = (await r.json().catch(() => ({}))).tracking_data;
  const st = td && (td.shipment_track || [])[0];
  if (!st || !st.current_status) return null;
  return {
    via: "shiprocket",
    status: st.current_status,
    outcome: outcomeFrom(st.current_status),
    at: st.delivered_date || st.rto_delivered_date || st.updated_time_stamp || null,
  };
}

function courierOf(awb) {
  const a = awb.trim().toUpperCase();
  if (a.startsWith("SF")) return "shadowfax";
  if (a.startsWith("2606")) return "delhivery";
  return "shiprocket";
}

/** Routed carrier first, the others after — a miss must not end the search. */
async function resolve(awb) {
  const first = courierOf(awb);
  const askers = { shadowfax: askShadowfax, delhivery: askDelhivery, shiprocket: askShiprocket };
  const order = [first, ...["shiprocket", "delhivery", "shadowfax"].filter((k) => k !== first)];
  for (const k of order) {
    try {
      const r = await askers[k](awb);
      if (r && r.outcome) return r;
    } catch {
      /* a carrier being down must not stop the others being asked */
    }
  }
  return null;
}

const tally = new Map();
let resolved = 0;
let silent = 0;
const writes = [];

for (const o of candidates) {
  const r = await resolve(o.awb);
  if (!r) {
    silent++;
    console.log("   " + o.orderName.padEnd(10) + o.awb.padEnd(18) + "no carrier knows it");
    continue;
  }
  resolved++;
  tally.set(r.outcome, (tally.get(r.outcome) || 0) + 1);
  console.log(
    "   " +
      o.orderName.padEnd(10) +
      o.awb.padEnd(18) +
      o.deliveryStatus.padEnd(12) +
      "-> " +
      r.outcome.padEnd(15) +
      "(" + r.via + ": " + String(r.status).slice(0, 28) + ")",
  );
  writes.push({ o, r });
}

console.log("\nresolved:", resolved, "| no answer:", silent);
for (const [k, v] of [...tally].sort((a, b) => b[1] - a[1])) {
  console.log("   " + String(v).padStart(4) + "  " + k);
}

if (!WRITE) {
  console.log("\nDry run. Pass --write to apply.");
  await prisma.$disconnect();
  process.exit(0);
}

let applied = 0;
for (const { o, r } of writes) {
  const at = r.at ? new Date(r.at) : null;
  const valid = at && !Number.isNaN(at.getTime());
  await prisma.orderFinancials.update({
    // (shop, orderId) is the unique key — orderId alone is not.
    where: { shop_orderId: { shop: SHOP, orderId: o.orderId } },
    data: {
      deliveryStatus: r.outcome,
      deliverySyncedAt: new Date(),
      // Mirrors the importer: a delivery dates deliveredAt, a COMPLETED return
      // dates rtoReceivedAt, and a return still moving dates neither.
      ...(r.outcome === "delivered" && valid ? { deliveredAt: at } : {}),
      ...(r.outcome === "rto" && valid ? { rtoReceivedAt: at } : {}),
    },
  });
  applied++;
}
console.log("\nwrote", applied, "orders.");

await prisma.$disconnect();
