/**
 * Dump a courier's COMPLETE raw response for one or more AWBs.
 *
 * Written because the inbound classifier needs to tell a forward RTO from a
 * reverse pickup, and the courier knows which it is — but the parser keeps only
 * Status, Instructions and ReferenceNo, so whatever states the direction is
 * discarded before anything can read it.
 *
 * Nothing here guesses at field names: it prints the payload whole so the
 * mapping can be written against what the carrier actually sends. Guessing a
 * status id is how the Shadowfax RTO fix shipped broken the first time.
 *
 * Read-only. Touches no rows.
 *
 * Usage:
 *   node scripts/probe-courier-raw.mjs 26061111291275 26061111291301
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const AWBS = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!AWBS.length) {
  console.error("Pass one or more AWBs.");
  process.exit(1);
}

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
if (!dbUrl) {
  console.error("DATABASE_URL not found.");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: {
    shiprocketEmail: true,
    shiprocketPassword: true,
    delhiveryApiKey: true,
    shadowfaxApiToken: true,
  },
});

/** The same prefix routing the scanner and the Apps Script both use. */
function detectCourier(awb) {
  const a = String(awb).trim();
  if (a.toUpperCase().startsWith("SF")) return "shadowfax";
  if (a.startsWith("2606")) return "delhivery";
  return "shiprocket";
}

async function srToken() {
  if (!app?.shiprocketEmail || !app?.shiprocketPassword) return null;
  const r = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: app.shiprocketEmail, password: app.shiprocketPassword }),
  });
  if (!r.ok) return null;
  return (await r.json().catch(() => ({})))?.token || null;
}

let SR = null;

async function raw(awb) {
  const via = detectCourier(awb);
  if (via === "delhivery") {
    if (!app?.delhiveryApiKey) return { via, error: "no delhivery key" };
    const r = await fetch(
      `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
      { headers: { Authorization: `Token ${app.delhiveryApiKey}` } },
    );
    return { via, http: r.status, body: await r.json().catch(() => null) };
  }
  if (via === "shadowfax") {
    if (!app?.shadowfaxApiToken) return { via, error: "no shadowfax token" };
    const r = await fetch("https://dale.shadowfax.in/api/v4/clients/bulk_track/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Token ${app.shadowfaxApiToken}`,
      },
      body: JSON.stringify({ awb_numbers: [awb] }),
    });
    return { via, http: r.status, body: await r.json().catch(() => null) };
  }
  SR = SR || (await srToken());
  if (!SR) return { via, error: "no shiprocket token" };
  const r = await fetch(
    `https://apiv2.shiprocket.in/v1/external/courier/track/awb/${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Bearer ${SR}` } },
  );
  return { via, http: r.status, body: await r.json().catch(() => null) };
}

for (const awb of AWBS) {
  console.log("\n" + "=".repeat(70));
  console.log("AWB", awb);

  // What we already recorded, so the courier's answer can be read against it.
  const scans = await prisma.scanEvent.findMany({
    where: { awb },
    select: { kind: true, result: true, orderName: true, scannedAt: true, note: true },
  });
  console.log("our scans:", JSON.stringify(scans, null, 2));

  const out = await raw(awb);
  console.log("via:", out.via, "http:", out.http ?? "-");
  if (out.error) console.log("error:", out.error);
  // Whole payload, no field picking — the point is to see what is there.
  console.log(JSON.stringify(out.body, null, 2));
}

await prisma.$disconnect();
