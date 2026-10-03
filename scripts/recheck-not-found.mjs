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
const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: {
    shiprocketEmail: true,
    shiprocketPassword: true,
    delhiveryApiKey: true,
    shadowfaxApiToken: true,
  },
});
console.log("not-found scans:", rows.length);
if (!rows.length) { await prisma.$disconnect(); process.exit(0); }

let rhqShopId = null;
if (rhq) {
  const s = await rhq.$queryRawUnsafe(
    `SELECT id FROM shops WHERE shopify_domain = $1 LIMIT 1`, "b03304.myshopify.com");
  rhqShopId = s[0]?.id ?? null;
}

/**
 * Ask the carrier that booked this waybill, routed the way detectCourier does:
 * Shadowfax first so an SF prefix never falls to the Shiprocket default, then
 * Delhivery's own prefix, then Shiprocket as the aggregator. A miss falls
 * through to the others, so a mis-prefixed AWB is not written off on one
 * carrier's denial.
 */
const SR_BASE = "https://apiv2.shiprocket.in/v1/external";
let srToken = null;
async function shiprocketToken() {
  if (srToken !== null) return srToken;
  const r = await fetch(`${SR_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: app.shiprocketEmail, password: app.shiprocketPassword }),
  });
  srToken = (await r.json().catch(() => ({})))?.token || "";
  return srToken;
}

async function askShiprocket(awb) {
  const t = await shiprocketToken();
  if (!t) return null;
  const r = await fetch(`${SR_BASE}/courier/track/awb/${encodeURIComponent(awb)}`, {
    headers: { Authorization: `Bearer ${t}` },
  });
  if (!r.ok) return null;
  const td = (await r.json().catch(() => ({})))?.tracking_data;
  const st = td?.shipment_track?.[0];
  if (!st?.current_status) return null;
  return {
    via: "shiprocket",
    status: st.current_status,
    lastActivity: td?.shipment_track_activities?.[0]?.activity || "",
    // Shiprocket echoes the channel order id it was booked against.
    orderRef: String(st.order_id || td?.order_id || "").trim(),
  };
}

async function askDelhivery(awb) {
  if (!app.delhiveryApiKey) return null;
  const r = await fetch(`https://track.delhivery.com/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Token ${app.delhiveryApiKey}` } });
  if (!r.ok) return null;
  const sd = (await r.json().catch(() => ({})))?.ShipmentData || [];
  const s = sd[0]?.Shipment;
  if (!s?.Status?.Status) return null;
  return {
    via: "delhivery",
    status: s.Status.Status,
    lastActivity: s.Status.Instructions || "",
    // ReferenceNo is OUR order number, the one we gave Delhivery at booking.
    orderRef: String(s.ReferenceNo || "").trim(),
  };
}

async function askShadowfax(awb) {
  if (!app.shadowfaxApiToken) return null;
  const r = await fetch("https://dale.shadowfax.in/api/v4/clients/bulk_track/", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Token ${app.shadowfaxApiToken}` },
    body: JSON.stringify({ awb_numbers: [awb] }),
  });
  if (!r.ok) return null;
  const row = ((await r.json().catch(() => ({})))?.data || [])
    .find((o) => String(o?.awb_number || "").trim() === awb);
  if (!row) return null;
  const scans = Array.isArray(row.tracking_details) ? row.tracking_details : [];
  const latest = scans[scans.length - 1] || {};
  return {
    via: "shadowfax",
    status: String(row.status_display || row.status || "").trim(),
    lastActivity: String(latest.status || "").trim(),
    orderRef: String(row.client_order_id || "").trim(),
  };
}

function detectCourier(awb) {
  const a = String(awb).trim();
  if (a.toUpperCase().startsWith("SF")) return "shadowfax";
  if (a.startsWith("2606")) return "delhivery";
  return "shiprocket";
}

const ASK = { shiprocket: askShiprocket, delhivery: askDelhivery, shadowfax: askShadowfax };

async function askCourier(awb) {
  const first = detectCourier(awb);
  const order = [first, ...["shiprocket", "delhivery", "shadowfax"].filter((k) => k !== first)];
  for (const k of order) {
    try {
      const r = await ASK[k](awb);
      if (r) return r;
    } catch {
      // A carrier being down is not an answer; try the next.
    }
  }
  return null;
}

const changes = [];
const courierSeen = [];
const stats = { orders: 0, reverse: 0, courier: 0, named: 0, asReturn: 0, stillUnknown: 0 };

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

  // 3. Ask the carrier that booked the waybill. It cannot supply an order
  //    name, but it can say whether the parcel is a return and which kind —
  //    and a row we can name the carrier and status for is worth more than one
  //    recorded as simply unknown.
  const carrier = await askCourier(ev.awb);
  if (carrier) {
    stats.courier++;
    const saysRto = /\brto\b|\brts\b|\bdto\b|return(ed)?\s*to\s*(origin|seller|shipper|client)/.test(
      `${carrier.status} ${carrier.lastActivity}`.toLowerCase(),
    );
    courierSeen.push({ awb: ev.awb, via: carrier.via, status: carrier.status, saysRto });
    // No order name exists for these in OUR orders, in ReturnHQ, or in the
    // tracking sheet — checked, all three return nothing. What the courier
    // says is still worth keeping: "Delhivery: DTO" on a row tells the bench
    // the parcel is real and genuinely came back, which "not in orders" does
    // not. The result stays not-found, because we still cannot name the order
    // and saying otherwise would be a claim we cannot support.
    // The carrier hands back the order reference we gave it at booking:
    // Delhivery's ReferenceNo, Shadowfax's client_order_id. Confirmed against
    // our own orders before it is believed — a reference that names no order
    // of ours is a number, not an answer.
    let named = "";
    if (carrier.orderRef) {
      // A reverse pickup's reference is the carrier's own id joined to ours:
      // "R1790086147-232696", where 232696 is the order. Comparing the whole
      // string never matches, so try the tail after the last dash as well as
      // the reference itself.
      const ref = carrier.orderRef;
      const tail = ref.includes("-") ? ref.split("-").pop() : "";
      const tries = [ref, `#${ref}`, ...(tail ? [tail, `#${tail}`] : [])];
      const hit = await prisma.orderFinancials.findFirst({
        where: { shop: SHOP, orderName: { in: tries } },
        select: { orderName: true },
      });
      if (hit) named = hit.orderName;
    }
    if (named) stats.named++;

    // The carrier names the order; ReturnHQ says whether the CUSTOMER sent it
    // back. The reverse waybill never matches — ReturnHQ holds its own pickup
    // token (R23706474924) while the parcel on the bench carries the
    // carrier's (26061111289492) — so the order number is the only bridge
    // between the two systems.
    let kind = ev.kind;
    let reason = "";
    if (named && rhq && rhqShopId != null) {
      const req = await rhq.$queryRawUnsafe(
        `SELECT type::text AS type, status::text AS status
           FROM return_requests
          WHERE shop_id = $1 AND shopify_order_number IN ($2, $3)
          ORDER BY created_at DESC LIMIT 1`,
        rhqShopId, named, named.replace(/^#/, ""),
      );
      const r0 = req[0];
      if (r0) {
        // A cancelled request still means the customer sent it back: the
        // parcel is physically here, so filing it as a courier RTO would put
        // it against the wrong counterparty.
        kind = "customer-return";
        reason = `${r0.type}${r0.status === "cancelled" ? " (cancelled request)" : ""}`;
        stats.asReturn++;
      }
    }

    changes.push({
      ev,
      kind,
      orderName: named,
      note: `${carrier.via}: ${carrier.status}${reason ? ` — ReturnHQ ${reason}` : ""}`,
      via: carrier.via,
      // Named means we can show the order, so it is no longer "not found".
      keepResult: !named,
    });
    continue;
  }

  stats.stillUnknown++;
}

if (courierSeen.length) {
  const byVia = {};
  courierSeen.forEach((c) => (byVia[c.via] = (byVia[c.via] || 0) + 1));
  console.log();
  console.log('courier knows these AWBs:', courierSeen.length, JSON.stringify(byVia));
  console.log('  of those, the courier calls it a return:', courierSeen.filter((c) => c.saysRto).length);
  courierSeen.slice(0, 10).forEach((c) =>
    console.log('   ' + c.awb.padEnd(17) + c.via.padEnd(12) + c.status));
}

console.log("\nresolved by:");
console.log("  our orders (forward AWB) :", stats.orders);
console.log("  ReturnHQ (reverse AWB)   :", stats.reverse);
console.log("  courier knows it         :", stats.courier);
console.log("    of those, NAMED an order:", stats.named);
console.log("    ReturnHQ says customer return:", stats.asReturn);
console.log("  nobody knows it          :", stats.stillUnknown);

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
    await prisma.scanEvent.update({
      where: { id: ev.id },
      data: {
        ...(c.orderName ? { orderName: c.orderName } : {}),
        // A courier confirmation does not name the order, so the row stays
        // not-found rather than claiming a match it cannot show.
        ...(c.keepResult ? {} : { result: "ok" }),
        note: c.note || `rechecked via ${c.via}`,
      },
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
