/**
 * One raw forward response and one raw reverse response, per courier.
 *
 * The inbound classifier has to tell a parcel the customer sent BACK from one
 * the courier could not deliver. Both end up on the same bench and, on
 * Delhivery at least, both end up reading "DTO" with "Dispatched for RTO" in
 * the history — so the status text cannot answer it and something structural
 * has to.
 *
 * Delhivery turned out to say OrderType "Pickup" and carry a PP scan leg. What
 * Shiprocket and Shadowfax say is unknown, and guessing a field is how the
 * Shadowfax RTO fix shipped broken once already. So: print both directions,
 * whole, for all three.
 *
 * Samples come from scans we already recorded, because those carry a verdict
 * to compare against. A "-R" reference or a reverse AWB known to ReturnHQ is
 * treated as a likely reverse; everything else is a forward candidate.
 *
 * Read-only.
 *
 *   node scripts/probe-directions.mjs
 *   node scripts/probe-directions.mjs --full    # every scan event, not a digest
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const FULL = process.argv.includes("--full");

function envVar(key) {
  if (process.env[key]) return process.env[key];
  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(new RegExp(`^${key}="?([^"\n]+)"?`, "m"));
    if (m) return m[1];
  }
  return null;
}

const dbUrl = envVar("DATABASE_URL");
if (!dbUrl) { console.error("DATABASE_URL not found."); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
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

const PREFIX = { delhivery: "2606", shadowfax: "SF" };

/** Waybills we scanned, for one courier, newest first. */
async function awbsFor(courier, take) {
  const where = { shop: SHOP, result: "ok" };
  if (courier === "delhivery") where.awb = { startsWith: "2606" };
  else if (courier === "shadowfax") where.awb = { startsWith: "SF" };
  else where.NOT = [{ awb: { startsWith: "2606" } }, { awb: { startsWith: "SF" } }];
  return prisma.scanEvent.findMany({
    where,
    select: { awb: true, kind: true, orderName: true },
    orderBy: { scannedAt: "desc" },
    take,
  });
}

let SR = null;
async function srToken() {
  if (SR) return SR;
  if (!app?.shiprocketEmail || !app?.shiprocketPassword) return null;
  const r = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: app.shiprocketEmail, password: app.shiprocketPassword }),
  });
  if (!r.ok) return null;
  SR = (await r.json().catch(() => ({})))?.token || null;
  return SR;
}

async function raw(courier, awb) {
  if (courier === "delhivery") {
    if (!app?.delhiveryApiKey) return null;
    const r = await fetch(
      `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
      { headers: { Authorization: `Token ${app.delhiveryApiKey}` } },
    );
    if (!r.ok) return null;
    const d = await r.json().catch(() => ({}));
    return (d?.ShipmentData || [])[0]?.Shipment || null;
  }
  if (courier === "shadowfax") {
    if (!app?.shadowfaxApiToken) return null;
    const r = await fetch("https://dale.shadowfax.in/api/v4/clients/bulk_track/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${app.shadowfaxApiToken}`,
      },
      body: JSON.stringify({ awb_numbers: [awb] }),
    });
    if (!r.ok) return null;
    return await r.json().catch(() => null);
  }
  const t = await srToken();
  if (!t) return null;
  const r = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Bearer ${t}` } },
  );
  if (!r.ok) return null;
  return await r.json().catch(() => null);
}

/**
 * Does this payload look like the courier went TO the customer?
 *
 * Deliberately loose: it only has to SORT samples so one of each direction
 * gets printed. The real rule is written afterwards, against the output.
 */
function looksReverse(courier, body) {
  const s = JSON.stringify(body || {}).toLowerCase();
  if (courier === "delhivery") {
    return /"ordertype":\s*"pickup"/.test(s) || /out for pickup|pickup completed/.test(s);
  }
  return /reverse|pickup|return_type|rvp|\bpick ?up\b/.test(s);
}

for (const courier of ["delhivery", "shiprocket", "shadowfax"]) {
  console.log("\n" + "#".repeat(72));
  console.log("##", courier.toUpperCase());
  console.log("#".repeat(72));

  const rows = await awbsFor(courier, 60);
  if (!rows.length) { console.log("no scanned AWBs for this courier"); continue; }

  let fwd = null, rev = null;
  for (const row of rows) {
    if (fwd && rev) break;
    const body = await raw(courier, row.awb);
    if (!body) continue;
    const isRev = looksReverse(courier, body);
    if (isRev && !rev) rev = { row, body };
    if (!isRev && !fwd) fwd = { row, body };
  }

  for (const [label, hit] of [["REVERSE (customer sent it back)", rev], ["FORWARD (courier could not deliver)", fwd]]) {
    console.log("\n" + "-".repeat(72));
    console.log("--", label);
    if (!hit) { console.log("no sample found in the last 60 scans"); continue; }
    console.log("AWB:", hit.row.awb, "| we filed it as:", hit.row.kind, "| order:", hit.row.orderName);
    const b = hit.body;
    if (!FULL && courier === "delhivery" && b?.Scans?.length > 6) {
      // The middle of a trip is "Vehicle Departed" over and over; the ends are
      // where the direction shows. --full prints everything.
      const scans = b.Scans;
      console.log(JSON.stringify({ ...b, Scans: [...scans.slice(0, 4), "...", ...scans.slice(-3)] }, null, 2));
    } else {
      console.log(JSON.stringify(b, null, 2));
    }
  }
}

await prisma.$disconnect();
