/**
 * Re-run inbound detection over scans recorded before a detection fix.
 *
 * A ScanEvent is keyed on (shop, kind, awb), so a parcel filed under the wrong
 * kind cannot simply be updated — the row has to move. Re-scanning at the bench
 * does not fix it either: the duplicate check sees the existing row and refuses,
 * so a wrong classification is sticky until something like this corrects it.
 *
 * The specific case this was written for: customer returns travel on a REVERSE
 * waybill that OrderFinancials never holds, so before that lookup existed every
 * reverse pickup was recorded as "rto / not-found".
 *
 * Only rows whose verdict actually CHANGES are touched, and the scan time is
 * preserved — it is a record of when a physical parcel was handled, and
 * rewriting it to now would falsify the bench log.
 *
 * Usage:
 *   node scripts/reclassify-scans.mjs            # dry run
 *   node scripts/reclassify-scans.mjs --write    # apply
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
    const m = fs.readFileSync(p, "utf8").match(new RegExp(`^${key}="?([^"\\n]+)"?`, "m"));
    if (m) return m[1];
  }
  return null;
}

const dbUrl = resolveUrl("DATABASE_URL");
const rhqUrl = resolveUrl("RETURNHQ_DATABASE_URL");
if (!dbUrl) { console.error("DATABASE_URL not found."); process.exit(1); }
if (!rhqUrl) { console.error("RETURNHQ_DATABASE_URL not found — detection needs it."); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const rhq = new PrismaClient({ datasources: { db: { url: rhqUrl } } });

console.log(WRITE ? "MODE: WRITE" : "MODE: dry run (pass --write to apply)");

const shopRow = await rhq.$queryRawUnsafe(
  `SELECT id FROM shops WHERE shopify_domain = $1 LIMIT 1`, "b03304.myshopify.com",
);
const rhqShopId = shopRow[0]?.id;
if (rhqShopId == null) { console.error("JM Looks not found in ReturnHQ."); process.exit(1); }

// Candidates: inbound scans we could not tie to an order. A reverse waybill is
// the commonest reason, and it is the only one this can repair.
const candidates = await prisma.scanEvent.findMany({
  where: { shop: SHOP, kind: { in: ["rto", "customer-return"] }, result: "not-found" },
  orderBy: { scannedAt: "desc" },
});
console.log("unmatched inbound scans:", candidates.length.toLocaleString());
if (!candidates.length) {
  console.log("Nothing to check.");
  await prisma.$disconnect(); await rhq.$disconnect();
  process.exit(0);
}

const changes = [];
for (const ev of candidates) {
  const rows = await rhq.$queryRawUnsafe(
    `SELECT shopify_order_number AS order_name, type::text AS type, status::text AS status
       FROM return_requests
      WHERE shop_id = $1
        AND regexp_replace(COALESCE(awb_number,''), '[^0-9a-zA-Z]', '', 'g') = $2
      ORDER BY created_at DESC LIMIT 1`,
    rhqShopId, ev.awb,
  );
  const r = rows[0];
  if (!r || r.status === "cancelled") continue;
  // Already right? Leave it alone.
  if (ev.kind === "customer-return" && ev.orderName === r.order_name) continue;
  changes.push({ ev, orderName: r.order_name, type: r.type });
}

console.log("resolvable as customer returns:", changes.length.toLocaleString());
if (!changes.length) {
  console.log("Nothing to change.");
  await prisma.$disconnect(); await rhq.$disconnect();
  process.exit(0);
}

for (const c of changes.slice(0, 20)) {
  console.log(`  ${c.ev.awb}  ${c.ev.kind}/not-found  ->  customer-return/ok  ${c.orderName} (${c.type})`);
}
if (changes.length > 20) console.log(`  ... and ${changes.length - 20} more`);

if (!WRITE) {
  console.log("\nDry run. Re-run with --write to apply.");
  await prisma.$disconnect(); await rhq.$disconnect();
  process.exit(0);
}

let moved = 0;
for (const c of changes) {
  const { ev, orderName } = c;
  // Delete then create, in one transaction: the kind is part of the unique key,
  // so the row genuinely moves rather than being updated in place. scannedAt is
  // carried over — it records when a parcel was physically handled.
  await prisma.$transaction([
    prisma.scanEvent.deleteMany({ where: { shop: SHOP, kind: ev.kind, awb: ev.awb } }),
    prisma.scanEvent.upsert({
      where: { shop_kind_awb: { shop: SHOP, kind: "customer-return", awb: ev.awb } },
      create: {
        shop: SHOP,
        kind: "customer-return",
        awb: ev.awb,
        orderName,
        result: "ok",
        note: `reclassified from ${ev.kind} (reverse AWB)`,
        scannedAt: ev.scannedAt,
      },
      update: { orderName, result: "ok", note: `reclassified from ${ev.kind} (reverse AWB)` },
    }),
  ]);
  moved++;
}
console.log(`\nDone. ${moved.toLocaleString()} scan(s) reclassified as customer returns.`);

await prisma.$disconnect();
await rhq.$disconnect();
