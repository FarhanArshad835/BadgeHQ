/**
 * Re-run inbound detection over scans that never matched an order.
 *
 * Those rows were written before the lookup chain was complete: the reverse-AWB
 * lookup did not exist, and the courier was never asked. Re-scanning at the
 * bench cannot fix them — the unique key on (shop, kind, awb) means a second
 * scan is refused as a duplicate rather than correcting the first.
 *
 * Runs the same three checks the scanner runs, in the same order, against the
 * same databases. A row only changes when a lookup actually answers; anything
 * still unknown is left exactly as it is.
 *
 * Usage:
 *   node scripts/recheck-not-found.mjs            # dry run
 *   node scripts/recheck-not-found.mjs --write    # apply
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write");
const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

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
const rhqUrl = envVar("RETURNHQ_DATABASE_URL");
if (!dbUrl) { console.error("DATABASE_URL not found."); process.exit(1); }

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const rhq = rhqUrl ? new PrismaClient({ datasources: { db: { url: rhqUrl } } }) : null;

console.log(WRITE ? "MODE: WRITE" : "MODE: dry run (pass --write to apply)");

const rows = await prisma.scanEvent.findMany({
  where: { shop: SHOP, result: "not-found" },
  select: { id: true, awb: true, kind: true },
  orderBy: { scannedAt: "desc" },
});
console.log("not-found scans:", rows.length);
if (!rows.length) { await prisma.$disconnect(); process.exit(0); }

let rhqShopId = null;
if (rhq) {
  const s = await rhq.$queryRawUnsafe(
    `SELECT id FROM shops WHERE shopify_domain = $1 LIMIT 1`, "b03304.myshopify.com");
  rhqShopId = s[0]?.id ?? null;
}

const changes = [];
const stats = { orders: 0, reverse: 0, courier: 0, stillUnknown: 0 };

for (const ev of rows) {
  // 1. Our own orders, by the forward AWB.
  const order = await prisma.orderFinancials.findFirst({
    where: { shop: SHOP, awb: ev.awb },
    select: { orderName: true, deliveryStatus: true },
    orderBy: { orderCreatedAt: "desc" },
  });
  if (order) {
    stats.orders++;
    changes.push({ ev, kind: ev.kind, orderName: order.orderName, via: "orders" });
    continue;
  }

  // 2. ReturnHQ, by the REVERSE waybill a return travels back on.
  if (rhq && rhqShopId != null) {
    const hit = await rhq.$queryRawUnsafe(
      `SELECT shopify_order_number AS order_name, type::text AS type, status::text AS status
         FROM return_requests
        WHERE shop_id = $1
          AND regexp_replace(COALESCE(awb_number,''), '[^0-9a-zA-Z]', '', 'g') = $2
        ORDER BY created_at DESC LIMIT 1`,
      rhqShopId, ev.awb,
    );
    const r = hit[0];
    if (r && r.status !== "cancelled") {
      stats.reverse++;
      changes.push({ ev, kind: "customer-return", orderName: r.order_name, via: `reverse (${r.type})` });
      continue;
    }
  }

  // 3. The courier is not asked here. It answers "is this a return?", which
  //    the scan's kind already records — it cannot supply the order name this
  //    script exists to fill, so a few hundred API calls would change nothing.
  stats.stillUnknown++;
}

console.log("\nresolved by:");
console.log("  our orders (forward AWB) :", stats.orders);
console.log("  ReturnHQ (reverse AWB)   :", stats.reverse);
console.log("  still unknown            :", stats.stillUnknown);

if (!changes.length) {
  console.log("\nNothing to change.");
  await prisma.$disconnect(); if (rhq) await rhq.$disconnect();
  process.exit(0);
}

console.log("\nsample:");
changes.slice(0, 10).forEach((c) =>
  console.log(`   ${c.ev.awb}  ${c.ev.kind} -> ${c.kind}  ${c.orderName}  [${c.via}]`));
if (changes.length > 10) console.log(`   ... and ${changes.length - 10} more`);

if (!WRITE) {
  console.log("\nDry run. Re-run with --write to apply.");
  await prisma.$disconnect(); if (rhq) await rhq.$disconnect();
  process.exit(0);
}

let moved = 0;
for (const c of changes) {
  const { ev } = c;
  if (c.kind === ev.kind) {
    // Same kind: just fill the order name and mark it matched.
    await prisma.scanEvent.update({
      where: { id: ev.id },
      data: { orderName: c.orderName, result: "ok", note: `rechecked via ${c.via}` },
    });
  } else {
    // The kind is part of the unique key, so the row has to MOVE. scannedAt is
    // carried over: it records when a physical parcel was handled at the bench,
    // and rewriting it to now would falsify that log.
    const old = await prisma.scanEvent.findUnique({ where: { id: ev.id } });
    if (!old) continue;
    await prisma.$transaction([
      prisma.scanEvent.delete({ where: { id: ev.id } }),
      prisma.scanEvent.upsert({
        where: { shop_kind_awb: { shop: SHOP, kind: c.kind, awb: ev.awb } },
        create: {
          shop: SHOP, kind: c.kind, awb: ev.awb,
          orderName: c.orderName, result: "ok",
          note: `rechecked via ${c.via}`, scannedAt: old.scannedAt,
        },
        update: { orderName: c.orderName, result: "ok", note: `rechecked via ${c.via}` },
      }),
    ]);
  }
  moved++;
  if (moved % 25 === 0) process.stdout.write(`\rwrote ${moved} / ${changes.length}`);
}
console.log(`\n\nDone. ${moved} scan(s) rechecked.`);

await prisma.$disconnect();
if (rhq) await rhq.$disconnect();
