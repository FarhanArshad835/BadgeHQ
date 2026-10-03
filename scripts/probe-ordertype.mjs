/**
 * Does Delhivery's OrderType actually separate a reverse pickup from a
 * forward RTO?
 *
 * The two parcels that prompted this both read OrderType "Pickup" and were
 * collected from the consignee, but two samples prove nothing. This checks the
 * field against scans we already classified: parcels the operator booked as a
 * customer return should read "Pickup", and ones that genuinely bounced off a
 * customer's door should not.
 *
 * Read-only.
 *
 *   node scripts/probe-ordertype.mjs          # 40 of each kind
 *   node scripts/probe-ordertype.mjs 80
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const N = Number(process.argv[2]) || 40;

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
  select: { delhiveryApiKey: true },
});
if (!app?.delhiveryApiKey) { console.error("No Delhivery key."); process.exit(1); }

async function fetchShipment(awb) {
  const r = await fetch(
    `https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Token ${app.delhiveryApiKey}` } },
  );
  if (!r.ok) return null;
  const d = await r.json().catch(() => ({}));
  return (d?.ShipmentData || [])[0]?.Shipment || null;
}

// Only Delhivery waybills; the field is Delhivery's own.
async function sample(kind) {
  return prisma.scanEvent.findMany({
    where: { shop: SHOP, kind, result: "ok", awb: { startsWith: "2606" } },
    select: { awb: true, orderName: true },
    orderBy: { scannedAt: "desc" },
    take: N,
  });
}

for (const kind of ["customer-return", "rto"]) {
  const rows = await sample(kind);
  console.log(`\n===== scanned as ${kind} (${rows.length}) =====`);
  const tally = new Map();
  for (const row of rows) {
    const s = await fetchShipment(row.awb);
    if (!s) { tally.set("NO ANSWER", (tally.get("NO ANSWER") || 0) + 1); continue; }
    // Was it collected FROM the customer, or sent back from our door?
    const key = [
      `OrderType=${s.OrderType || "-"}`,
      `Status=${s.Status?.Status || "-"}`,
      `ref=${/-R$|^R/i.test(String(s.ReferenceNo || "")) ? "has-R" : "plain"}`,
    ].join("  ");
    tally.set(key, (tally.get(key) || 0) + 1);
  }
  for (const [k, n] of [...tally].sort((a, b) => b[1] - a[1])) {
    console.log(String(n).padStart(4), k);
  }
}

await prisma.$disconnect();
