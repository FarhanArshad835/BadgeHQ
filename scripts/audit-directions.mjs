/**
 * How often does the courier disagree with how we filed a parcel?
 *
 * The rule under test, learned from matched samples rather than assumed:
 *
 *   Delhivery  OrderType "Pickup"  -> collected FROM the customer
 *              OrderType "COD"/... -> carried TO them, so an RTO if it came back
 *
 *   Shiprocket an NDR reason, or any "Out For Delivery" activity, means a
 *              delivery was ATTEMPTED - a forward parcel. Reverse pickups
 *              booked through ReturnHQ are not Shiprocket waybills at all and
 *              the API answers empty for them.
 *
 *   Shadowfax  nothing separates the two: both read "rts_d"/"Returned to
 *              Seller" and both carry ofd + assigned_for_delivery. Reported,
 *              not guessed at.
 *
 * Read-only. Prints what WOULD change; changes nothing.
 *
 *   node scripts/audit-directions.mjs           # 150 per courier
 *   node scripts/audit-directions.mjs --n 400
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const argN = process.argv.indexOf("--n");
const N = argN > -1 ? Number(process.argv[argN + 1]) || 150 : 150;

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

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: {
    shiprocketEmail: true,
    shiprocketPassword: true,
    delhiveryApiKey: true,
    shadowfaxApiToken: true,
  },
});

function courierOf(awb) {
  const a = String(awb).trim();
  if (a.toUpperCase().startsWith("SF")) return "shadowfax";
  if (a.startsWith("2606")) return "delhivery";
  return "shiprocket";
}

let SR = null;
async function srToken() {
  if (SR) return SR;
  if (!app || !app.shiprocketEmail || !app.shiprocketPassword) return null;
  const r = await fetch("https://apiv2.shiprocket.in/v1/external/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: app.shiprocketEmail, password: app.shiprocketPassword }),
  });
  if (!r.ok) return null;
  SR = (await r.json().catch(() => ({}))).token || null;
  return SR;
}

/**
 * What the courier says this parcel's journey was.
 * Returns "reverse", "forward", or "" when the courier cannot say.
 */
async function askCourier(courier, awb) {
  try {
    if (courier === "delhivery") {
      if (!app || !app.delhiveryApiKey) return "";
      const r = await fetch(
        "https://track.delhivery.com/api/v1/packages/json/?waybill=" + encodeURIComponent(awb),
        { headers: { Authorization: "Token " + app.delhiveryApiKey } },
      );
      if (!r.ok) return "";
      const d = await r.json().catch(() => ({}));
      const sd = d.ShipmentData || [];
      const s = (sd[0] && sd[0].Shipment) || null;
      if (!s) return "";
      const type = String(s.OrderType || "").trim().toLowerCase();
      if (type === "pickup") return "reverse";
      if (type) return "forward";
      return "";
    }
    if (courier === "shiprocket") {
      const t = await srToken();
      if (!t) return "";
      const r = await fetch(
        "https://apiv2.shiprocket.in/v1/external/courier/track/awb/" + encodeURIComponent(awb),
        { headers: { Authorization: "Bearer " + t } },
      );
      if (!r.ok) return "";
      const td = (await r.json().catch(() => ({}))).tracking_data || null;
      if (!td) return "";
      const acts = td.shipment_track_activities || [];
      // An empty answer means the token is not a Shiprocket waybill at all,
      // which is what a ReturnHQ reverse pickup looks like here.
      if (!acts.length) return "";
      const attempted =
        !!(td.ndr && td.ndr.reason) ||
        acts.some((a) => /out for delivery/i.test(String(a.activity || "")));
      return attempted ? "forward" : "";
    }
    return "";
  } catch {
    return "";
  }
}

const scans = await prisma.scanEvent.findMany({
  where: { shop: SHOP, result: "ok", kind: { in: ["rto", "customer-return"] } },
  select: { awb: true, orderName: true, kind: true, scannedAt: true },
  orderBy: { scannedAt: "desc" },
  take: 5000,
});

for (const courier of ["delhivery", "shiprocket"]) {
  const mine = scans.filter((s) => courierOf(s.awb) === courier).slice(0, N);
  console.log("\n" + "=".repeat(68));
  console.log("==", courier.toUpperCase(), "-", mine.length, "parcels");
  console.log("=".repeat(68));

  let agree = 0;
  let silent = 0;
  const wrong = [];
  for (const s of mine) {
    const says = await askCourier(courier, s.awb);
    if (!says) {
      silent++;
      continue;
    }
    const filedReverse = s.kind === "customer-return";
    const saysReverse = says === "reverse";
    if (filedReverse === saysReverse) agree++;
    else wrong.push({ ...s, says });
  }
  console.log("courier agrees with our filing:", agree);
  console.log("courier could not say:        ", silent);
  console.log("DISAGREES:                    ", wrong.length);
  for (const w of wrong) {
    console.log(
      "   " +
        w.awb +
        "  " +
        (w.orderName || "(no order)") +
        "  filed=" +
        w.kind +
        "  courier says=" +
        w.says +
        "  " +
        w.scannedAt.toISOString().slice(0, 10),
    );
  }
}

console.log("\nSHADOWFAX: not audited. Nothing in its payload separated the two");
console.log("directions across 10 matched samples - both read rts_d / 'Returned");
console.log("to Seller' with the same delivery attempts. It needs its own answer.");

await prisma.$disconnect();
