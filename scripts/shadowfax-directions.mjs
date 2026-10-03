/**
 * Five true RTOs and five true customer returns on Shadowfax, compared field
 * by field.
 *
 * Shadowfax was the one courier the earlier comparison could not crack: both
 * directions read "rts_d" / "Returned to Seller" with the same delivery
 * attempts. That comparison labelled samples by how the BENCH filed them,
 * which is the very thing under suspicion - on Delhivery the bench was wrong
 * 1 in 6 times.
 *
 * So ground truth here comes from ReturnHQ, which records what the CUSTOMER
 * asked for and never sees a courier payload:
 *
 *   true customer return = ReturnHQ holds a live (non-cancelled) request
 *   true RTO             = no request at all, and our delivery status says rto
 *
 * ReturnHQ is multi-tenant; only JM Looks (shop_id 3) is ever read.
 *
 * Read-only.
 *
 *   node scripts/shadowfax-directions.mjs
 *   node scripts/shadowfax-directions.mjs --dump    # whole payloads
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const DUMP = process.argv.includes("--dump");
const argN = process.argv.indexOf("--n");
const N = argN > -1 ? Number(process.argv[argN + 1]) || 5 : 5;

/** Reads .env.production too: RETURNHQ_DATABASE_URL is not in the dev set. */
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
if (!rhqUrl) {
  console.error("RETURNHQ_DATABASE_URL not found - run: npx vercel env pull .env.production --environment=production");
  process.exit(1);
}

const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const rhq = new PrismaClient({ datasources: { db: { url: rhqUrl } } });
const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: { shadowfaxApiToken: true },
});
if (!app || !app.shadowfaxApiToken) {
  console.error("No Shadowfax token saved in Settings.");
  process.exit(1);
}

// JM Looks only. The ReturnHQ database serves several merchants.
const reqRows = await rhq.$queryRawUnsafe(
  "SELECT shopify_order_number AS n, type::text AS type, status::text AS status FROM return_requests WHERE shop_id = 3 AND status::text <> 'cancelled'",
);
const rhqByOrder = new Map();
for (const r of reqRows) {
  const n = String(r.n || "").trim();
  if (n) rhqByOrder.set(n, { type: r.type, status: r.status });
}
console.log("ReturnHQ live requests (JM Looks):", rhqByOrder.size);

const scans = await prisma.scanEvent.findMany({
  where: {
    shop: SHOP,
    result: "ok",
    kind: { in: ["rto", "customer-return"] },
    awb: { startsWith: "SF" },
  },
  select: { awb: true, orderName: true, kind: true },
  orderBy: { scannedAt: "desc" },
  take: 3000,
});
console.log("Shadowfax scans available:", scans.length);

// Our own delivery status, used only to confirm a true RTO really came back.
const names = [...new Set(scans.map((s) => s.orderName).filter(Boolean))];
const orders = await prisma.orderFinancials.findMany({
  where: { shop: SHOP, orderName: { in: names } },
  select: { orderName: true, deliveryStatus: true },
});
const statusByOrder = new Map(orders.map((o) => [o.orderName, o.deliveryStatus]));

const trueReturn = scans.filter((s) => rhqByOrder.has(s.orderName));
const trueRto = scans.filter(
  (s) =>
    !rhqByOrder.has(s.orderName) &&
    String(statusByOrder.get(s.orderName) || "").startsWith("rto"),
);
console.log("pool - true customer returns:", trueReturn.length, "| true RTOs:", trueRto.length);

async function track(awb) {
  try {
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
  } catch {
    return null;
  }
}

/** Every field that might carry the direction of travel. */
function summarise(b) {
  const trail = b.tracking_details || [];
  const ids = trail.map((x) => String(x.status_id || "").toLowerCase());
  const has = (re) => ids.some((i) => re.test(i));
  return {
    status: b.status ?? null,
    statusDisplay: b.status_display ?? null,
    firstId: ids[0] ?? null,
    secondId: ids[1] ?? null,
    // Did a courier take it TO someone? Only a forward parcel does.
    everOFD: ids.includes("ofd"),
    everAssignedDelivery: ids.includes("assigned_for_delivery"),
    everDelivered: ids.includes("delivered"),
    // Pickup-side markers.
    everSellerPickup: ids.includes("assigned_for_seller_pickup"),
    everOFP: ids.includes("ofp"),
    everRevHub: has(/rev_hub|reverse/),
    everClientWarehouse: has(/client_warehouse/),
    // Does the item itself carry a return reason? Only a return does.
    returnReason: (b.product_details || [])
      .map((p) => p.return_reason)
      .filter(Boolean)
      .join("|"),
    qcRequired: (b.product_details || []).some((p) => p.qc_required === true),
    // Where it started and ended.
    pickupCity: (b.pickup_details && b.pickup_details.city) || null,
    deliveryCity: (b.delivery_details && b.delivery_details.city) || null,
    codAmount: b.cod_amount ?? null,
    paymentMode: b.payment_mode ?? null,
    orderType: b.order_type ?? null,
    isReverse: b.is_reverse ?? null,
    trailLength: ids.length,
  };
}

const pick = (arr, n) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
};

const groups = { "TRUE CUSTOMER RETURN": [], "TRUE RTO": [] };
for (const [label, pool] of [
  ["TRUE CUSTOMER RETURN", trueReturn],
  ["TRUE RTO", trueRto],
]) {
  for (const s of pick(pool, N)) {
    const body = await track(s.awb);
    if (!body) continue;
    const rq = rhqByOrder.get(s.orderName);
    groups[label].push({
      awb: s.awb,
      order: s.orderName,
      filedAs: s.kind,
      rhq: rq ? rq.type + "/" + rq.status : "-",
      ...summarise(body),
    });
    if (DUMP) {
      console.log("\n--- RAW " + label + " " + s.awb + " (" + s.orderName + ") ---");
      console.log(JSON.stringify(body, null, 2));
    }
  }
  console.log("\n" + "=".repeat(70));
  console.log("== " + label + " (" + groups[label].length + ")");
  console.log("=".repeat(70));
  for (const r of groups[label]) console.log(JSON.stringify(r));
}

console.log("\n>>> fields that separate the two groups:");
const keys = new Set();
for (const g of Object.values(groups)) for (const r of g) for (const k of Object.keys(r)) keys.add(k);
let found = 0;
for (const k of keys) {
  if (["awb", "order", "filedAs", "rhq"].includes(k)) continue;
  const a = new Set(groups["TRUE CUSTOMER RETURN"].map((r) => JSON.stringify(r[k])));
  const b = new Set(groups["TRUE RTO"].map((r) => JSON.stringify(r[k])));
  if (!a.size || !b.size) continue;
  if (![...a].some((v) => b.has(v))) {
    found++;
    console.log("    " + k + ":  return=" + [...a].join("|") + "   rto=" + [...b].join("|"));
  }
}
if (!found) console.log("    (none - no single field separates them)");

await prisma.$disconnect();
await rhq.$disconnect();
