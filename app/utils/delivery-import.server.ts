/**
 * Delivery-status import — the uploaded OMS/tracking sheet is the AUTHORITY for
 * delivery outcome (the user's decision), replacing carrier-API classification.
 *
 * The sheet is keyed by AWB (matches OrderFinancials.awb) with a "Delivery
 * Status" column. This parses the CSV, maps each status to our outcome
 * vocabulary, and bulk-updates OrderFinancials.deliveryStatus by AWB in one SQL
 * statement (fast enough for 100k+ rows). Unknown/blank statuses are skipped,
 * never guessed.
 */
import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import type { DeliveryOutcome } from "./pnl-sync.server";

/** Map a sheet "Delivery Status" string to our outcome. Same vocabulary the
 *  carrier classifier produces, so the monthly engine treats them identically.
 *  Returns null for a status we don't recognise (skip, don't guess).
 *
 *  The return vocabulary is carrier-specific and does NOT share words. Delhivery
 *  and Shiprocket say "RTO"; Shadowfax says "Returned to Seller" / "RTS". A rule
 *  written for one silently drops the other: 2,841 Shadowfax "Returned to
 *  Seller" rows mapped to null and never counted as returns at all.
 *
 *  Order matters twice over, and both orderings are load-bearing:
 *    - return before delivered, so "RTO Delivered" is a return, not a sale;
 *    - NEGATIVE before positive, so "Return to Seller Not Delivered" is a failed
 *      return rather than matching the word "delivered" sitting inside it. */
export function mapSheetStatus(raw: string): DeliveryOutcome | "no-awb" | null {
  const s = String(raw || "").toLowerCase().replace(/[_\-\s]+/g, " ").trim();
  if (!s) return null;

  // "dto" is Delhivery's code for a parcel it collected FROM the customer — a
  // customer return. Without it here, "DTO Delivered" falls through to the
  // plain "delivered" rule below and the P&L books a returned parcel as a
  // completed sale, which is the most expensive way to be wrong.
  const isReturn = /\brto\b|\brts\b|\bdto\b|return(ed)? to (origin|seller|client)/.test(s);

  if (isReturn) {
    // A return that FAILED is not a completed return. Checked first because
    // "not delivered" contains "delivered" and would otherwise book the parcel
    // as a sale to the customer.
    if (/\bnot delivered\b|\bundelivered\b/.test(s)) return "rto_in_transit";
    // Still moving back to us. "In process" and "pending" are Shadowfax's
    // wording for a return that has been raised but has not arrived, so the
    // claim clock must not start on them.
    if (/in transit|in process|initiat|pending|returning|out for delivery|ofd/.test(s)) {
      return "rto_in_transit";
    }
    return "rto";
  }

  if (/\blost\b|untraceable/.test(s)) return "lost";
  if (/\bcancel(l?ed|ed)?\b/.test(s)) return "cancelled";
  if (/\bnot delivered\b|\bundelivered\b/.test(s)) return "in_transit";
  if (/\bdelivered\b/.test(s)) return "delivered"; // plain delivered (returns handled above)
  if (/in transit|out for delivery|shipped|pickup|dispatch|ofd/.test(s)) return "in_transit";
  // Shadowfax's in-transit vocabulary, which shares almost no words with the
  // other two carriers'. Without these the row returns null, the importer
  // skips it entirely, and the order sits at "unknown" having never been
  // synced at all — 87 of the 204 September unknowns were exactly this.
  //
  // Every one of them means the parcel is SOMEWHERE IN THE NETWORK and has
  // not reached a terminal outcome, so they all map to in_transit. None of
  // them is a delivery or a return, and guessing either would be worse than
  // the unknown they replace.
  if (
    /\bnot picked\b|\bnot attempted\b|\bpincode updated\b|\bnew\b|\breceived at\b|\bassigned for\b|\bnot contactable\b|\bon hold\b|\bopen\b|\bmanifest|\bdelay\b|\bpending\b|\bndr\b/.test(s)
  ) {
    return "in_transit";
  }
  // A parcel the carrier has written off. Not a return — nothing comes back —
  // so it is the same loss as "lost" and belongs in that bucket rather than
  // sitting unknown and holding the month below the resolution gate.
  if (/\bdisposed\b|\bdestroyed\b/.test(s)) return "lost";
  // Everything else stays null ON PURPOSE. "No Status" and "Auth Error" are
  // the sheet admitting it does not know — "Auth Error" especially means the
  // carrier lookup FAILED, and mapping that to in_transit would turn a
  // credential problem into a silent claim about where the parcel is.
  return null;
}

/**
 * Parse a date from the tracking sheet.
 *
 * Google publishes these in the sheet's own locale, so both "9/26/2026" and
 * "26/09/2026" turn up. Where the first number is above 12 it can only be a
 * day, which disambiguates most rows; the rest fall back to the sheet's
 * observed M/D/YYYY. Anything unparseable returns null rather than a guess: a
 * wrong date here would start a claim clock at the wrong moment.
 */
function parseSheetDate(raw: unknown): Date | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;

  const slash = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    const y = Number(slash[3]);
    // First number over 12 can only be a day.
    const [month, day] = a > 12 ? [b, a] : [a, b];
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(Date.UTC(y, month - 1, day));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[0]}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Parse an uploaded CSV of AWB → delivery status. Tolerant of column order and
 * extra columns: it finds the AWB column (a long digit run) and the delivery-
 * status column (by header name), from the header row. Returns AWB→outcome pairs.
 */
export function parseDeliveryCsv(csv: string): {
  pairs: Array<{ awb: string; outcome: DeliveryOutcome | "no-awb"; deliveredAt: Date | null }>;
  totalRows: number;
  skipped: number;
} {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { pairs: [], totalRows: 0, skipped: 0 };

  // Header: locate the AWB and status columns by name.
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  let awbCol = header.findIndex((h) => h === "awb" || h.includes("awb") || h.includes("waybill"));
  let statusCol = header.findIndex((h) => h.includes("delivery status") || h === "status" || h.includes("status"));
  // The date the courier says the parcel arrived. For an RTO that is the date it
  // came back to US, which is the only usable clock for a courier claim.
  const dateCol = header.findIndex((h) => h.includes("delivered date") || h.includes("delivery date"));
  // If no recognisable header, assume col0 = AWB, col2 = status (the sheet's shape).
  const hasHeader = awbCol !== -1 || statusCol !== -1;
  if (awbCol === -1) awbCol = 0;
  if (statusCol === -1) statusCol = 2;

  const pairs: Array<{ awb: string; outcome: DeliveryOutcome | "no-awb"; deliveredAt: Date | null }> = [];
  let skipped = 0;
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    // Keep ALPHANUMERICS — some AWBs contain letters (e.g. BlueDart "7D131105745",
    // Shiprocket "SRSP…"). Stripping to digits corrupted them ("7D131105745" ->
    // "7131105745") so they never matched OrderFinancials.awb (stored verbatim
    // from Shopify), leaving delivered orders stuck as "unknown". Only remove
    // whitespace/punctuation, and don't lower-case (AWBs are case-sensitive IDs).
    const awb = String(cells[awbCol] ?? "").replace(/[^0-9a-zA-Z]/g, "").trim();
    const outcome = mapSheetStatus(String(cells[statusCol] ?? ""));
    if (!awb || awb.length < 8 || !outcome) {
      skipped++;
      continue;
    }
    pairs.push({ awb, outcome, deliveredAt: dateCol === -1 ? null : parseSheetDate(cells[dateCol]) });
  }
  return { pairs, totalRows: lines.length - start, skipped };
}

/**
 * Fetch the published-to-web delivery sheet (a Google "Publish to web → CSV"
 * URL) and apply it. No Google auth — the URL returns the live CSV directly.
 * This is the automatic path: a button and the nightly cron call it so delivery
 * status stays fresh without a manual download/upload.
 */
export async function fetchAndApplyDeliverySheet(
  shop: string,
  url: string,
): Promise<{ ok: true; matched: number; delivered: number; rto: number; parsed: number; skipped: number } | { ok: false; reason: string }> {
  if (!url) return { ok: false, reason: "No delivery-sheet URL set in Settings." };
  // Guard: must look like a published Google CSV (or any CSV endpoint).
  if (!/^https?:\/\//i.test(url)) return { ok: false, reason: "The delivery-sheet URL must start with http(s)://." };

  let text: string;
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { ok: false, reason: `Sheet URL returned HTTP ${res.status}. Re-check the Publish-to-web link.` };
    text = await res.text();
    // A private/unpublished sheet returns an HTML login page, not CSV.
    if (/^\s*</.test(text) || /<html/i.test(text.slice(0, 200))) {
      return { ok: false, reason: "That URL returned a web page, not CSV. Use File → Share → Publish to web → the AWB tab → CSV." };
    }
  } catch {
    return { ok: false, reason: "Couldn't fetch the delivery-sheet URL. Check the link and try again." };
  }

  const { pairs, totalRows, skipped } = parseDeliveryCsv(text);
  if (!pairs.length) {
    return { ok: false, reason: `No usable rows in the sheet (parsed ${totalRows}). It needs an AWB column and a Delivery Status column.` };
  }
  const res = await applyDeliveryStatuses(shop, pairs);
  return { ok: true, matched: res.updated, delivered: res.delivered, rto: res.rto, parsed: pairs.length, skipped };
}

/** Minimal CSV line splitter that respects double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Bulk-apply parsed delivery statuses to OrderFinancials by AWB. Uses a single
 * UPDATE ... FROM (VALUES ...) per chunk so 100k rows apply in seconds, not
 * 100k round-trips. Only rows whose AWB exists are touched; returns how many
 * order rows were updated.
 */
export async function applyDeliveryStatuses(
  shop: string,
  pairs: Array<{ awb: string; outcome: string; deliveredAt?: Date | null }>,
): Promise<{ updated: number; delivered: number; rto: number; rtoDated: number }> {
  if (!pairs.length) return { updated: 0, delivered: 0, rto: 0, rtoDated: 0 };

  // Dedup by AWB (last wins) so the VALUES list is clean.
  const byAwb = new Map<string, { outcome: string; deliveredAt: Date | null }>();
  for (const p of pairs) byAwb.set(p.awb, { outcome: p.outcome, deliveredAt: p.deliveredAt ?? null });
  const entries = Array.from(byAwb.entries());

  const now = new Date();
  let updated = 0;
  const CHUNK = 2000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values = Prisma.join(
      slice.map(([awb, v]) => Prisma.sql`(${awb}, ${v.outcome}, ${v.deliveredAt}::timestamp)`),
    );
    // IS DISTINCT FROM on BOTH columns: a row whose status is unchanged but
    // which has just gained a return date must still be written, or the claim
    // clock would never arrive for the 21,392 RTOs already sitting terminal.
    //
    // rtoReceivedAt is written for 'rto' ONLY, never 'rto_in_transit'. A return
    // that is still moving has not reached our warehouse, so dating it would
    // start the claim clock while the courier is still legitimately carrying
    // the parcel — and a claim raised on a date the courier can disprove is
    // worse than no claim at all.
    //
    // It is COALESCEd, never overwritten with null: once a courier has told us
    // when a parcel came back, a later sync with a blank cell must not erase it.
    const res = await prisma.$executeRaw`
      UPDATE "OrderFinancials" AS o
      SET "deliveryStatus" = v.outcome,
          "deliveredAt" = CASE WHEN v.outcome = 'delivered' THEN ${now} ELSE NULL END,
          "rtoReceivedAt" = CASE
            WHEN v.outcome = 'rto'
              THEN COALESCE(v.delivered_at, o."rtoReceivedAt")
            ELSE o."rtoReceivedAt" END,
          "deliverySyncedAt" = ${now}
      FROM (VALUES ${values}) AS v(awb, outcome, delivered_at)
      WHERE o.shop = ${shop} AND o.awb = v.awb
        AND (
          o."deliveryStatus" IS DISTINCT FROM v.outcome
          OR (v.outcome = 'rto'
              AND v.delivered_at IS NOT NULL
              AND o."rtoReceivedAt" IS NULL)
        )
    `;
    updated += Number(res);
  }

  const delivered = entries.filter(([, v]) => v.outcome === "delivered").length;
  const rto = entries.filter(([, v]) => v.outcome === "rto" || v.outcome === "rto_in_transit").length;
  const rtoDated = entries.filter(
    ([, v]) => (v.outcome === "rto" || v.outcome === "rto_in_transit") && v.deliveredAt != null,
  ).length;
  return { updated, delivered, rto, rtoDated };
}

/**
 * Resolve orders the tracking sheet has never covered, by asking the carrier.
 *
 * The sheet is the authority for delivery status, but it is not complete: a
 * handful of AWBs never reach it at all, and an order whose waybill has no row
 * there can never be updated by the sync however many times it runs. Found
 * 83 such orders across 2026, 67 of them delivered weeks earlier while the
 * dashboard still read "unknown".
 *
 * Two distinct failures produced that, and both are covered here:
 *   - the AWB is absent from the sheet, so nothing ever asks about it
 *   - the AWB IS asked about, but by the wrong carrier. An SF prefix does not
 *     prove Shadowfax booked it; some are Shiprocket's "Shadowfax Fashion"
 *     service, which Shadowfax's own API disowns. So a miss on the routed
 *     carrier falls through to the others rather than ending the search.
 *
 * Deliberately narrow. It only touches orders that are UNRESOLVED and whose
 * AWB the sheet does not carry — never one the sheet has an opinion about,
 * which stays the sheet's to own.
 */
export async function resolveUnsheetedOrders(
  shop: string,
  sheetUrl: string,
  opts: {
    shiprocketEmail?: string;
    shiprocketPassword?: string;
    delhiveryApiKey?: string;
    shadowfaxApiToken?: string;
    /** Cap per run: this is a live carrier call per order on a cron clock. */
    limit?: number;
    /** Wall-clock ceiling. The count alone is not a budget: each order can
     *  try three carriers at 4s apiece, so 60 orders is 12 minutes in the
     *  worst case against the cron's 300s. Whichever limit is hit first
     *  stops the run, and the rest are picked up tomorrow. */
    budgetMs?: number;
  },
): Promise<{ ok: boolean; checked: number; resolved: number; reason?: string }> {
  const limit = opts.limit ?? 60;
  const budgetMs = opts.budgetMs ?? 60_000;
  const startedAt = Date.now();
  let sheetAwbs: Set<string>;
  try {
    const res = await fetch(sheetUrl);
    if (!res.ok) return { ok: false, checked: 0, resolved: 0, reason: `sheet HTTP ${res.status}` };
    const lines = (await res.text()).split(/\r?\n/);
    sheetAwbs = new Set<string>();
    for (let i = 1; i < lines.length; i++) {
      const k = (lines[i].split(",")[0] || "").replace(/[^0-9a-zA-Z]/g, "");
      if (k) sheetAwbs.add(k);
    }
  } catch (e: any) {
    return { ok: false, checked: 0, resolved: 0, reason: String(e?.message || e).slice(0, 120) };
  }
  // An empty read means the fetch succeeded but gave us nothing. Treating that
  // as "the sheet covers no AWBs" would send every unresolved order to the
  // carriers at once.
  if (sheetAwbs.size < 1000) {
    return { ok: false, checked: 0, resolved: 0, reason: `sheet looks truncated (${sheetAwbs.size} AWBs)` };
  }

  const candidates = (
    await prisma.orderFinancials.findMany({
      where: {
        shop,
        awb: { not: "" },
        deliveryStatus: { in: ["unknown", "in_transit"] },
      },
      select: { orderId: true, awb: true },
      orderBy: { orderCreatedAt: "desc" },
      take: 4000,
    })
  )
    .filter((o) => !sheetAwbs.has(o.awb.replace(/[^0-9a-zA-Z]/g, "")))
    .slice(0, limit);

  if (!candidates.length) return { ok: true, checked: 0, resolved: 0 };

  const { trackParcel } = await import("./tracking.server");
  let resolved = 0;
  let checked = 0;
  for (const o of candidates) {
    if (Date.now() - startedAt > budgetMs) break;
    checked++;
    try {
      // trackParcel already routes by prefix and falls through on a miss.
      const r = await trackParcel({ awb: o.awb, ...opts });
      if (!r) continue;
      const outcome = mapSheetStatus(`${r.status} ${r.lastActivity}`);
      if (!outcome || outcome === "no-awb") continue;
      const at = r.lastUpdate ? new Date(r.lastUpdate) : null;
      const dated = at && !Number.isNaN(at.getTime()) ? at : null;
      await prisma.orderFinancials.update({
        where: { shop_orderId: { shop, orderId: o.orderId } },
        data: {
          deliveryStatus: outcome,
          deliverySyncedAt: new Date(),
          // Same rule as the sheet importer: a return still moving is not
          // dated, or the claim clock starts while the courier still has it.
          ...(outcome === "delivered" && dated ? { deliveredAt: dated } : {}),
          ...(outcome === "rto" && dated ? { rtoReceivedAt: dated } : {}),
        },
      });
      resolved++;
    } catch (e: any) {
      console.error("[unsheeted]", o.awb, String(e?.message || e).slice(0, 120));
    }
  }
  return { ok: true, checked, resolved };
}
