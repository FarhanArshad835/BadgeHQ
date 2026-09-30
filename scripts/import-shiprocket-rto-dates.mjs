/**
 * Fill rtoReceivedAt from a Shiprocket "All Orders" CSV export.
 *
 * Why this exists: the Claims page ages a courier claim from the date the
 * parcel came back to us, and that date only ever lived in the tracking
 * sheet's Delivered Date column — which was blank on every RTO row. Shiprocket's
 * own export carries "RTO Delivered Date" on all 17,091 of its RTO shipments,
 * so one file supplies in seconds what the Apps Script drain needs six passes
 * and thousands of API calls to collect.
 *
 * Scope is deliberately narrow. This writes ONE column, rtoReceivedAt, and only
 * where it is currently null. It does not touch deliveryStatus: the tracking
 * sheet owns that column and the twice-daily cron would overwrite anything
 * written here, so a status change made here would silently revert.
 *
 * Shadowfax RTOs are not in this export and still need the Apps Script drain.
 *
 * Usage:
 *   node scripts/import-shiprocket-rto-dates.mjs <file.csv>          # dry run
 *   node scripts/import-shiprocket-rto-dates.mjs <file.csv> --write  # apply
 *
 * Reads DATABASE_URL from the environment, or from a .env file beside the repo.
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import readline from "node:readline";
import path from "node:path";

const file = process.argv[2];
const WRITE = process.argv.includes("--write");

if (!file) {
  console.error("usage: node scripts/import-shiprocket-rto-dates.mjs <file.csv> [--write]");
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error("no such file:", file);
  process.exit(1);
}

const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

function resolveDatabaseUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(/^DATABASE_URL="?([^"\n]+)"?/m);
    if (m) return m[1];
  }
  return null;
}

const url = resolveDatabaseUrl();
if (!url) {
  console.error("DATABASE_URL not set and not found in a .env file.");
  process.exit(1);
}

/** CSV splitter that respects quotes — the export quotes addresses and names. */
function splitCsv(line) {
  const out = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else q = false;
      } else cur += c;
    } else if (c === '"') q = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/** Shiprocket writes the string "N/A" for an empty date, not an empty cell. */
const present = (v) => v != null && v !== "N/A" && String(v).trim() !== "";

/**
 * "2026-09-15 12:10:09" in IST -> a UTC Date.
 *
 * Parsed by hand rather than with `new Date(str)`: that would read the string
 * as the machine's local time, so the same file would import different dates
 * on a laptop in Delhi and a server in Virginia. The claim clock is counted in
 * days, so a shift of a few hours can move a parcel across a day boundary.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
function parseIstTimestamp(raw) {
  const m = String(raw).trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0));
  const dt = new Date(asUtc - IST_OFFSET_MS);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// AWBs are matched exactly as OrderFinancials stores them: alphanumerics kept,
// case preserved. Lower-casing corrupts Bluedart codes like 7D131105745.
const normaliseAwb = (raw) => String(raw ?? "").replace(/[^0-9a-zA-Z]/g, "").trim();

const prisma = new PrismaClient({ datasources: { db: { url } } });

console.log(WRITE ? "MODE: WRITE" : "MODE: dry run (pass --write to apply)");
console.log("shop:", SHOP);
console.log("file:", file);

// ── 1. Read the export ──────────────────────────────────────────────────────
const rtoDates = new Map(); // awb -> Date
let lineItems = 0;
let rtoRows = 0;
let unparseableDates = 0;
const unparseableSample = [];

const rl = readline.createInterface({
  input: fs.createReadStream(file, { encoding: "utf8" }),
  crlfDelay: Infinity,
});

let idx = null;
for await (const line of rl) {
  if (!line.trim()) continue;
  if (idx === null) {
    const header = splitCsv(line);
    idx = {
      awb: header.indexOf("AWB Code"),
      status: header.indexOf("Status"),
      rtoDelivered: header.indexOf("RTO Delivered Date"),
    };
    const missing = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k);
    if (missing.length) {
      console.error("CSV is missing expected column(s):", missing.join(", "));
      console.error("Is this a Shiprocket 'All Orders' export?");
      process.exit(1);
    }
    continue;
  }
  lineItems++;
  const c = splitCsv(line);
  if ((c[idx.status] || "").trim().toUpperCase() !== "RTO DELIVERED") continue;

  const awb = normaliseAwb(c[idx.awb]);
  if (!awb) continue;
  const rawDate = c[idx.rtoDelivered];
  if (!present(rawDate)) continue;

  rtoRows++;
  const parsed = parseIstTimestamp(rawDate);
  if (!parsed) {
    unparseableDates++;
    if (unparseableSample.length < 5) unparseableSample.push(`${awb}: ${JSON.stringify(rawDate)}`);
    continue;
  }
  // The export is one row per product line, so an order repeats. Keep the
  // EARLIEST date: that is when the parcel actually arrived, and it is the
  // conservative choice for a claim clock.
  const seen = rtoDates.get(awb);
  if (!seen || parsed < seen) rtoDates.set(awb, parsed);
}

console.log("\n=== export ===");
console.log("line items          :", lineItems.toLocaleString());
console.log("RTO DELIVERED rows  :", rtoRows.toLocaleString());
console.log("distinct AWBs       :", rtoDates.size.toLocaleString());
if (unparseableDates) {
  console.log("unparseable dates   :", unparseableDates.toLocaleString(), "(skipped)");
  unparseableSample.forEach((s) => console.log("   ", s));
}
if (!rtoDates.size) {
  console.log("\nNothing to import.");
  await prisma.$disconnect();
  process.exit(0);
}

// ── 2. Match against orders that still lack a date ──────────────────────────
const candidates = await prisma.orderFinancials.findMany({
  where: { shop: SHOP, awb: { not: "" }, rtoReceivedAt: null },
  select: { awb: true, orderName: true, deliveryStatus: true },
});
console.log("\n=== our orders with no RTO date ===");
console.log("candidates          :", candidates.length.toLocaleString());

const updates = [];
const byStatus = {};
for (const o of candidates) {
  const when = rtoDates.get(o.awb);
  if (!when) continue;
  updates.push({ awb: o.awb, when });
  byStatus[o.deliveryStatus] = (byStatus[o.deliveryStatus] || 0) + 1;
}

console.log("matched in export   :", updates.length.toLocaleString());
console.log("their current status:", JSON.stringify(byStatus));

// A date on an order we do NOT consider an RTO is worth seeing, not hiding: it
// means our status and Shiprocket's disagree, and the claims list reads status.
const notRto = Object.entries(byStatus)
  .filter(([k]) => k !== "rto" && k !== "rto_in_transit")
  .reduce((n, [, v]) => n + v, 0);
if (notRto) {
  console.log(
    `\nNote: ${notRto.toLocaleString()} of these are not currently classified as RTO.`,
  );
  console.log("The date is still correct (Shiprocket says the parcel came back), but");
  console.log("the claims list filters on deliveryStatus, so they will not appear there");
  console.log("until the tracking sheet agrees. Re-syncing the sheet is what fixes that.");
}

if (!updates.length) {
  console.log("\nNothing to write.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("\nsample:");
updates.slice(0, 8).forEach((u) => console.log("   ", u.awb, "->", u.when.toISOString().slice(0, 10)));

if (!WRITE) {
  console.log(`\nDry run. ${updates.length.toLocaleString()} rows would be updated.`);
  console.log("Re-run with --write to apply.");
  await prisma.$disconnect();
  process.exit(0);
}

// ── 3. Write ────────────────────────────────────────────────────────────────
// Chunked, and each statement re-checks rtoReceivedAt IS NULL so a concurrent
// sheet sync that filled the date first is never overwritten by this file.
const CHUNK = 500;
let written = 0;
for (let i = 0; i < updates.length; i += CHUNK) {
  const slice = updates.slice(i, i + CHUNK);
  const res = await prisma.$transaction(
    slice.map((u) =>
      prisma.orderFinancials.updateMany({
        where: { shop: SHOP, awb: u.awb, rtoReceivedAt: null },
        data: { rtoReceivedAt: u.when },
      }),
    ),
  );
  written += res.reduce((n, r) => n + r.count, 0);
  process.stdout.write(`\rwrote ${written.toLocaleString()} / ${updates.length.toLocaleString()}`);
}
console.log(`\n\nDone. ${written.toLocaleString()} orders now carry an RTO received date.`);

const remaining = await prisma.orderFinancials.count({
  where: { shop: SHOP, deliveryStatus: { in: ["rto", "rto_in_transit"] }, awb: { not: "" }, rtoReceivedAt: null },
});
console.log(`RTOs still with no date: ${remaining.toLocaleString()} (mostly Shadowfax — use the Apps Script drain).`);

await prisma.$disconnect();
