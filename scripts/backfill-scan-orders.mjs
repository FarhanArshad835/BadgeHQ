/**
 * Fill the order name on scans recorded before the sheet fallback existed.
 *
 * A packet scanned the day it ships has no AWB on its order yet, so the lookup
 * missed and the scan was filed "not in orders". The tracking sheet has had
 * that mapping since the label was printed, and the scanner now consults it —
 * but rows already written keep their empty order name, and re-scanning is
 * refused as a duplicate rather than correcting them.
 *
 * Only fills what is blank. A scan that already matched an order is never
 * touched, and the result moves to "ok" only for rows the sheet can actually
 * resolve.
 *
 * Usage:
 *   node scripts/backfill-scan-orders.mjs            # dry run
 *   node scripts/backfill-scan-orders.mjs --write    # apply
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write");
const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

function resolveUrl(key) {
  if (process.env[key]) return process.env[key];
  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(new RegExp(`^${key}="?([^"\n]+)"?`, "m"));
    if (m) return m[1];
  }
  return null;
}

const dbUrl = resolveUrl("DATABASE_URL");
if (!dbUrl) { console.error("DATABASE_URL not found."); process.exit(1); }
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });

console.log(WRITE ? "MODE: WRITE" : "MODE: dry run (pass --write to apply)");

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: { deliverySheetUrl: true },
});
if (!app?.deliverySheetUrl) {
  console.error("No delivery sheet URL saved in Settings.");
  process.exit(1);
}

const norm = (v) => String(v ?? "").replace(/[^0-9a-zA-Z]/g, "").trim();

console.log("fetching the tracking sheet…");
const res = await fetch(app.deliverySheetUrl, { redirect: "follow" });
if (!res.ok) { console.error("sheet returned", res.status); process.exit(1); }
const lines = (await res.text()).split(/\r?\n/);
const map = new Map();
for (let i = 1; i < lines.length; i++) {
  const c = lines[i].split(",");
  const awb = norm(c[0] || "");
  // "#238043.1" is one shipment of order #238043; the suffix is the sheet's
  // own split-shipment marker and is not part of the name.
  const order = String(c[1] || "").trim().replace(/\.\d+$/, "");
  if (awb.length >= 6 && order) map.set(awb, order);
}
console.log("sheet rows:", lines.length.toLocaleString(), "| AWB->order pairs:", map.size.toLocaleString());

const blanks = await prisma.scanEvent.findMany({
  where: { shop: SHOP, orderName: "" },
  select: { id: true, awb: true, kind: true, result: true },
});
console.log("scans with no order name:", blanks.length.toLocaleString());

const fixes = [];
for (const ev of blanks) {
  const order = map.get(ev.awb);
  if (order) fixes.push({ ...ev, order });
}
console.log("resolvable from the sheet:", fixes.length.toLocaleString());
if (!fixes.length) { await prisma.$disconnect(); process.exit(0); }

fixes.slice(0, 10).forEach((f) => console.log(`   ${f.awb}  ${f.kind}/${f.result}  ->  ${f.order}`));
if (fixes.length > 10) console.log(`   ... and ${fixes.length - 10} more`);

if (!WRITE) {
  console.log("\nDry run. Re-run with --write to apply.");
  await prisma.$disconnect();
  process.exit(0);
}

// Batched: one statement per row would be thousands of round trips.
const CHUNK = 200;
let done = 0;
for (let i = 0; i < fixes.length; i += CHUNK) {
  const slice = fixes.slice(i, i + CHUNK);
  await prisma.$transaction(
    slice.map((f) =>
      prisma.scanEvent.update({
        where: { id: f.id },
        // result follows the order name: a scan that now has an order matched.
        data: { orderName: f.order, result: f.result === "not-found" ? "ok" : f.result },
      }),
    ),
  );
  done += slice.length;
  process.stdout.write(`\rwrote ${done} / ${fixes.length}`);
}
console.log(`\n\nDone. ${done.toLocaleString()} scans now carry an order name.`);
await prisma.$disconnect();
