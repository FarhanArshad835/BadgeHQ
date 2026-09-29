/**
 * Warehouse scanning: dispatch, RTO received, customer return received.
 *
 * Scans are recorded and NOTHING ELSE. They deliberately do not write
 * OrderFinancials.deliveryStatus: the tracking sheet owns that column and the
 * twice-daily cron (fetchAndApplyDeliverySheet) would overwrite anything put
 * there, so a scan that "worked" would silently revert within hours. Scans
 * accumulate on their own so they can later be reconciled AGAINST the sheet.
 */
import prisma from "../db.server";

export type ScanKind = "dispatch" | "rto" | "customer-return";
export type ScanResult = "ok" | "duplicate" | "not-found" | "blocked";

/**
 * Normalise a scanned code the same way parseDeliveryCsv does.
 *
 * Case is KEPT on purpose. delivery-import.server.ts documents a real bug where
 * stripping to digits turned "7D131105745" into "7131105745" and nothing
 * matched; lowercasing would break the same AWBs a different way. Only
 * punctuation and whitespace come out, which is what a barcode gun adds.
 */
export function normaliseAwb(raw: string): string {
  return String(raw || "").replace(/[^0-9a-zA-Z]/g, "");
}

export type ScanOutcome = {
  awb: string;
  result: ScanResult;
  /** What the operator should be told, in their words not ours. */
  message: string;
  orderName: string;
  /** Courier status we hold for that order, so a mismatch is visible. */
  deliveryStatus: string;
  /** ReturnHQ request type for a customer return, when one exists. */
  returnType: string;
  /** When this AWB was already scanned for this purpose. */
  previousScanAt: string;
};

/**
 * Record one scan.
 *
 * The unique constraint on (shop, kind, awb) is what makes duplicate detection
 * real: two guns scanning the same packet at once cannot both succeed, which a
 * read-then-write check could not guarantee.
 */
export async function recordScan(
  shop: string,
  kind: ScanKind,
  rawAwb: string,
  opts: { note?: string; force?: boolean } = {},
): Promise<ScanOutcome> {
  const awb = normaliseAwb(rawAwb);
  const base: ScanOutcome = {
    awb,
    result: "ok",
    message: "",
    orderName: "",
    deliveryStatus: "",
    returnType: "",
    previousScanAt: "",
  };

  if (awb.length < 6) {
    return { ...base, result: "not-found", message: "That does not look like an AWB." };
  }

  // Already scanned for this same purpose?
  const prior = await prisma.scanEvent.findUnique({
    where: { shop_kind_awb: { shop, kind, awb } },
  });
  if (prior && !opts.force) {
    return {
      ...base,
      result: "duplicate",
      orderName: prior.orderName,
      previousScanAt: prior.scannedAt.toISOString(),
      message: `Already scanned ${timeAgo(prior.scannedAt)}. Set this packet aside.`,
    };
  }

  // Dispatch only: is this parcel already with a courier?
  if (kind === "dispatch") {
    const sent = await prisma.dispatchedAwb.findUnique({
      where: { shop_awb: { shop, awb } },
    });
    if (sent && !opts.force) {
      await writeScan(shop, kind, awb, "", "blocked", opts.note || "already dispatched");
      return {
        ...base,
        result: "blocked",
        message: "ALREADY DISPATCHED. Do not send this packet again.",
      };
    }
  }

  // Which order is this? Unknown is normal, not an error: a parcel dispatched
  // since the last sync will not be in OrderFinancials yet.
  const order = await prisma.orderFinancials.findFirst({
    where: { shop, awb },
    select: { orderName: true, deliveryStatus: true, orderCreatedAt: true },
    orderBy: { orderCreatedAt: "desc" },
  });

  let returnType = "";
  if (kind === "customer-return" && order?.orderName) {
    // Best effort: a ReturnHQ outage must not stop the packet being recorded.
    try {
      const { returnHqByOrder } = await import("./returnhq.server");
      const map = await returnHqByOrder([order.orderName]);
      returnType = map.get(order.orderName)?.type || "";
    } catch {
      returnType = "";
    }
  }

  const result: ScanResult = order ? "ok" : "not-found";
  await writeScan(shop, kind, awb, order?.orderName || "", result, opts.note || "");

  return {
    ...base,
    result,
    orderName: order?.orderName || "",
    deliveryStatus: order?.deliveryStatus || "",
    returnType,
    message: buildMessage(kind, result, order?.deliveryStatus || "", returnType),
  };
}

/** Upsert so a forced re-scan updates the row rather than throwing on the constraint. */
async function writeScan(
  shop: string,
  kind: ScanKind,
  awb: string,
  orderName: string,
  result: ScanResult,
  note: string,
): Promise<void> {
  const data = { orderName, result, note, scannedAt: new Date() };
  await prisma.scanEvent.upsert({
    where: { shop_kind_awb: { shop, kind, awb } },
    create: { shop, kind, awb, ...data },
    update: data,
  });
}

/** What to tell the operator. Plain language, and never a bare status code. */
function buildMessage(kind: ScanKind, result: ScanResult, delivery: string, returnType: string): string {
  if (result === "not-found") {
    return "Recorded, but this AWB is not in our orders yet. Normal for a recent dispatch.";
  }
  if (kind === "dispatch") return "Ready to dispatch.";
  if (kind === "rto") {
    // The courier disagreeing is worth surfacing at the bench, not later.
    return delivery === "rto" || delivery === "rto_in_transit"
      ? "RTO received."
      : `RTO received, but the courier says "${delivery || "unknown"}".`;
  }
  // customer-return
  if (!returnType) return "Return received, but there is NO request in ReturnHQ.";
  return `Return received (${returnType} request).`;
}

/** "3 minutes ago" reads faster than a timestamp at a packing bench. */
function timeAgo(d: Date): string {
  const secs = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) === 1 ? "" : "s"} ago`;
}

/**
 * Pull the already-dispatched list from the dispatch sheet's Apps Script.
 *
 * Deliberately a button, not a per-scan lookup: that endpoint was measured at
 * 2.4s, 13.4s and once a 30s timeout for a single read. A background sync can
 * absorb that; a scan cannot.
 */
export async function syncDispatchedAwbs(
  shop: string,
  url: string,
): Promise<{ ok: true; count: number } | { ok: false; reason: string }> {
  if (!url) return { ok: false, reason: "No dispatch sheet URL saved in Settings." };

  let awbs: string[] = [];
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(60000) });
    if (!res.ok) return { ok: false, reason: `Sheet returned ${res.status}.` };
    const body: any = await res.json().catch(() => null);
    if (!body || body.status !== "ok" || !Array.isArray(body.awbs)) {
      return { ok: false, reason: "Sheet did not return an AWB list." };
    }
    awbs = body.awbs.map((a: unknown) => normaliseAwb(String(a))).filter((a: string) => a.length >= 6);
  } catch (e: any) {
    return { ok: false, reason: String(e?.message || e).slice(0, 160) };
  }
  if (!awbs.length) return { ok: false, reason: "Sheet returned no usable AWBs." };

  const unique = Array.from(new Set(awbs));
  const now = new Date();

  // Replace wholesale: the sheet is the list, so an AWB dropped from it should
  // stop blocking. Delete and insert in one transaction, or a concurrent scan
  // could see an empty table and wave a dispatched packet through.
  await prisma.$transaction([
    prisma.dispatchedAwb.deleteMany({ where: { shop } }),
    prisma.dispatchedAwb.createMany({
      data: unique.map((awb) => ({ shop, awb, syncedAt: now })),
      skipDuplicates: true,
    }),
  ]);

  return { ok: true, count: unique.length };
}

/**
 * Every dispatched AWB, for preloading into the page.
 *
 * ~3,000 AWBs is roughly 45KB, so the scanner can answer "already dispatched"
 * with no network at all. That is what makes the common rejection instant
 * rather than merely fast.
 */
export async function loadDispatchedSet(shop: string): Promise<string[]> {
  const rows = await prisma.dispatchedAwb.findMany({
    where: { shop },
    select: { awb: true },
  });
  return rows.map((r) => r.awb);
}

/** Recent scans for the history page and the session list. */
export async function recentScans(shop: string, kind: ScanKind | null, limit = 200) {
  return prisma.scanEvent.findMany({
    where: { shop, ...(kind ? { kind } : {}) },
    orderBy: { scannedAt: "desc" },
    take: limit,
  });
}

/** Today's counts per kind, for the dashboard tiles. */
export async function scanCountsToday(shop: string): Promise<Record<string, number>> {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  const startIst = new Date(
    Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS,
  );
  const rows = await prisma.scanEvent.groupBy({
    by: ["kind"],
    where: { shop, scannedAt: { gte: startIst } },
    _count: true,
  });
  const out: Record<string, number> = { dispatch: 0, rto: 0, "customer-return": 0 };
  for (const r of rows) out[r.kind] = r._count;
  return out;
}
