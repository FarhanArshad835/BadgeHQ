/**
 * Move scans the courier says we filed in the wrong direction.
 *
 * Distinct from reclassify-scans.mjs, which only revisits scans that never
 * matched an order (result "not-found"). These matched fine; what is wrong is
 * the KIND. A customer return filed as a courier RTO sits against the wrong
 * counterparty in Claims and the P&L, and because (shop, kind, awb) is unique
 * a re-scan at the bench is refused as a duplicate rather than correcting it.
 *
 * The rules are the ones measured this session, not guesses:
 *
 *   Delhivery   OrderType "Pickup"  -> collected FROM the customer = return
 *               anything else       -> carried TO them, so a return leg = RTO
 *               (120 parcels checked: 98 agreed, 20 disagreed, 2 silent)
 *
 *   Shadowfax   status "delivered"  -> it reached the customer, so a parcel
 *                                      now on our bench is one they sent back
 *               rts_* / cancelled   -> never reached them = RTO
 *               (150 parcels checked: 150 agreed, 0 disagreed)
 *
 *   Shiprocket  left alone. 120 checked, 0 disagreements — there is nothing
 *               to fix, and the reverse pickups it cannot answer for are
 *               ReturnHQ tokens rather than Shiprocket waybills.
 *
 * The scan time is preserved: it records when a physical parcel was handled,
 * and rewriting it to now would falsify the bench log.
 *
 *   node scripts/fix-scan-direction.mjs           # dry run
 *   node scripts/fix-scan-direction.mjs --write   # apply
 *   node scripts/fix-scan-direction.mjs --n 500   # how many to examine
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write");
/**
 * Also delete a row the courier contradicts when the correct row ALREADY
 * exists. Separate from --write because this destroys a scan record rather
 * than moving one, and the two deserve different levels of deliberateness.
 */
const PRUNE = process.argv.includes("--prune");
const argN = process.argv.indexOf("--n");
const LIMIT = argN > -1 ? Number(process.argv[argN + 1]) || 2000 : 2000;

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

console.log(WRITE ? "MODE: WRITE" : "MODE: dry run (pass --write to apply)");

const app = await prisma.pnlApp.findUnique({
  where: { id: "default" },
  select: { delhiveryApiKey: true, shadowfaxApiToken: true },
});

function courierOf(awb) {
  const a = String(awb).trim();
  if (a.toUpperCase().startsWith("SF")) return "shadowfax";
  if (a.startsWith("2606")) return "delhivery";
  return "shiprocket";
}

/** "customer-return", "rto", or "" when the courier cannot say. */
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
      if (type === "pickup") return "customer-return";
      if (type) return "rto";
      // No OrderType: Delhivery draws the same line in the status itself.
      const st = String((s.Status && s.Status.Status) || "").trim().toUpperCase();
      if (st === "DTO") return "customer-return";
      if (st === "RTO") return "rto";
      return "";
    }
    if (courier === "shadowfax") {
      if (!app || !app.shadowfaxApiToken) return "";
      const r = await fetch("https://dale.shadowfax.in/api/v4/clients/bulk_track/", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Token " + app.shadowfaxApiToken,
        },
        body: JSON.stringify({ awb_numbers: [awb] }),
      });
      if (!r.ok) return "";
      const d = await r.json().catch(() => ({}));
      const row = (d.data || [])[0];
      if (!row) return "";
      const st = String(row.status || "").toLowerCase().trim();
      if (st === "delivered") return "customer-return";
      if (st.startsWith("rts") || st.startsWith("rto")) return "rto";
      return "";
    }
    return "";
  } catch {
    return "";
  }
}

const scans = await prisma.scanEvent.findMany({
  where: {
    shop: SHOP,
    result: "ok",
    kind: { in: ["rto", "customer-return"] },
    OR: [{ awb: { startsWith: "2606" } }, { awb: { startsWith: "SF" } }],
  },
  orderBy: { scannedAt: "desc" },
  take: LIMIT,
});
console.log("inbound scans to examine:", scans.length.toLocaleString());

let agree = 0;
let silent = 0;
const moves = [];
for (const ev of scans) {
  const says = await askCourier(courierOf(ev.awb), ev.awb);
  if (!says) {
    silent++;
    continue;
  }
  if (says === ev.kind) {
    agree++;
    continue;
  }
  moves.push({ ev, to: says });
}

console.log("courier agrees:", agree);
console.log("courier silent:", silent);
console.log("TO MOVE:       ", moves.length);
for (const m of moves) {
  console.log(
    "   " +
      m.ev.awb +
      "  " +
      (m.ev.orderName || "(no order)") +
      "  " +
      m.ev.kind +
      " -> " +
      m.to +
      "  scanned " +
      m.ev.scannedAt.toISOString().slice(0, 10),
  );
}

if (!WRITE) {
  console.log("\nDry run. Pass --write to apply.");
  await prisma.$disconnect();
  process.exit(0);
}

let moved = 0;
let blocked = 0;
let pruned = 0;
for (const m of moves) {
  // The kind is part of the unique key, so the row has to move rather than be
  // updated. If the destination already holds this AWB the parcel was scanned
  // under both kinds; leave it and report, rather than destroying either row.
  const existing = await prisma.scanEvent.findUnique({
    where: { shop_kind_awb: { shop: SHOP, kind: m.to, awb: m.ev.awb } },
    select: { id: true },
  });
  if (existing) {
    // The parcel was scanned under both kinds, and the courier agrees with
    // the row that already exists — so THIS row is the stale duplicate. A
    // delete cannot be undone, so it needs its own flag rather than riding
    // along with --write.
    if (!PRUNE) {
      blocked++;
      console.log(
        "   SKIP " + m.ev.awb + " — already filed as " + m.to +
          "; this " + m.ev.kind + " row is the stale one (--prune removes it)",
      );
      continue;
    }
    await prisma.scanEvent.delete({ where: { id: m.ev.id } });
    pruned++;
    console.log("   PRUNED stale " + m.ev.kind + " row:", m.ev.awb);
    continue;
  }
  await prisma.$transaction([
    prisma.scanEvent.delete({ where: { id: m.ev.id } }),
    prisma.scanEvent.create({
      data: {
        shop: SHOP,
        kind: m.to,
        awb: m.ev.awb,
        orderName: m.ev.orderName,
        result: m.ev.result,
        // Says why this row reads differently from the day it was scanned.
        note: (m.ev.note ? m.ev.note + " | " : "") + "direction corrected from courier",
        session: m.ev.session,
        // Preserved: when the parcel was physically handled.
        scannedAt: m.ev.scannedAt,
      },
    }),
  ]);
  moved++;
}
console.log(
  "\nmoved:",
  moved,
  "| pruned stale duplicates:",
  pruned,
  "| skipped (already both kinds):",
  blocked,
);

await prisma.$disconnect();
