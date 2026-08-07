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
 *  Returns null for a status we don't recognise (skip, don't guess). */
export function mapSheetStatus(raw: string): DeliveryOutcome | "no-awb" | null {
  const s = String(raw || "").toLowerCase().replace(/[_\-\s]+/g, " ").trim();
  if (!s) return null;
  // RTO must be checked before "delivered" — "RTO Delivered" is a return.
  if (/\brto\b|return(ed)? to origin|\brts\b/.test(s)) {
    return /in transit|initiat|returning/.test(s) ? "rto_in_transit" : "rto";
  }
  if (/\blost\b|untraceable/.test(s)) return "lost";
  if (/\bcancel(l?ed|ed)?\b/.test(s)) return "cancelled";
  if (/\bdelivered\b/.test(s)) return "delivered"; // plain delivered (RTO handled above)
  if (/in transit|out for delivery|shipped|pickup|dispatch|ofd/.test(s)) return "in_transit";
  return null;
}

/**
 * Parse an uploaded CSV of AWB → delivery status. Tolerant of column order and
 * extra columns: it finds the AWB column (a long digit run) and the delivery-
 * status column (by header name), from the header row. Returns AWB→outcome pairs.
 */
export function parseDeliveryCsv(csv: string): {
  pairs: Array<{ awb: string; outcome: DeliveryOutcome | "no-awb" }>;
  totalRows: number;
  skipped: number;
} {
  const lines = csv.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (!lines.length) return { pairs: [], totalRows: 0, skipped: 0 };

  // Header: locate the AWB and status columns by name.
  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase().trim());
  let awbCol = header.findIndex((h) => h === "awb" || h.includes("awb") || h.includes("waybill"));
  let statusCol = header.findIndex((h) => h.includes("delivery status") || h === "status" || h.includes("status"));
  // If no recognisable header, assume col0 = AWB, col2 = status (the sheet's shape).
  const hasHeader = awbCol !== -1 || statusCol !== -1;
  if (awbCol === -1) awbCol = 0;
  if (statusCol === -1) statusCol = 2;

  const pairs: Array<{ awb: string; outcome: DeliveryOutcome | "no-awb" }> = [];
  let skipped = 0;
  const start = hasHeader ? 1 : 0;
  for (let i = start; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const awb = String(cells[awbCol] ?? "").replace(/[^0-9]/g, "").trim();
    const outcome = mapSheetStatus(String(cells[statusCol] ?? ""));
    if (!awb || awb.length < 8 || !outcome) {
      skipped++;
      continue;
    }
    pairs.push({ awb, outcome });
  }
  return { pairs, totalRows: lines.length - start, skipped };
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
  pairs: Array<{ awb: string; outcome: string }>,
): Promise<{ updated: number; delivered: number; rto: number }> {
  if (!pairs.length) return { updated: 0, delivered: 0, rto: 0 };

  // Dedup by AWB (last wins) so the VALUES list is clean.
  const byAwb = new Map<string, string>();
  for (const p of pairs) byAwb.set(p.awb, p.outcome);
  const entries = Array.from(byAwb.entries());

  const now = new Date();
  let updated = 0;
  const CHUNK = 2000;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const slice = entries.slice(i, i + CHUNK);
    const values = Prisma.join(
      slice.map(([awb, outcome]) => Prisma.sql`(${awb}, ${outcome})`),
    );
    // Update matching orders; set deliveredAt only for delivered.
    const res = await prisma.$executeRaw`
      UPDATE "OrderFinancials" AS o
      SET "deliveryStatus" = v.outcome,
          "deliveredAt" = CASE WHEN v.outcome = 'delivered' THEN ${now} ELSE NULL END,
          "deliverySyncedAt" = ${now}
      FROM (VALUES ${values}) AS v(awb, outcome)
      WHERE o.shop = ${shop} AND o.awb = v.awb
    `;
    updated += Number(res);
  }

  const delivered = entries.filter(([, o]) => o === "delivered").length;
  const rto = entries.filter(([, o]) => o === "rto" || o === "rto_in_transit").length;
  return { updated, delivered, rto };
}
