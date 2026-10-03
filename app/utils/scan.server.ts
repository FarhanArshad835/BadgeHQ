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
import { getPnlApp } from "./pnl-app.server";

export type ScanKind = "dispatch" | "rto" | "customer-return";

/**
 * Which kind of inbound parcel this is, decided from the data rather than asked
 * of the operator.
 *
 * The two are separable in practice, measured on live data:
 *   - Of 3,000 RTO orders, only 4 (0.1%) also had a ReturnHQ request.
 *   - Of orders WITH a request, 2,381 of 2,405 were delivered first.
 *
 * So the rule is simply: a live ReturnHQ request means the customer sent it
 * back; otherwise a courier RTO status means it never reached them. Both true
 * is vanishingly rare, and the request wins there because a customer raising a
 * request is a deliberate act while a courier status is a guess about a parcel.
 */
export type InboundKind = "rto" | "customer-return";
export type ScanResult = "ok" | "duplicate" | "not-found" | "blocked" | "error";

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
  /** What this turned out to be. Differs from the request when it was "inbound". */
  kind: ScanKind;
  /** Why that kind was chosen, shown to the operator so a wrong call is visible. */
  detectedReason: string;
  /** False when the data was thin, so the UI can ask for a second look. */
  confident: boolean;
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
  requested: ScanKind | "inbound",
  rawAwb: string,
  opts: { note?: string; force?: boolean; session?: string; bulk?: boolean } = {},
): Promise<ScanOutcome> {
  const awb = normaliseAwb(rawAwb);
  // "inbound" means the operator scanned a returning parcel without saying
  // which sort it is. That is the right default: the data knows, and asking
  // them to classify by eye is how a parcel ends up in the wrong bucket.
  let kind: ScanKind = requested === "inbound" ? "rto" : requested;
  let detected: Awaited<ReturnType<typeof detectInbound>> | null = null;
  if (requested === "inbound" && awb.length >= 6) {
    detected = await detectInbound(shop, awb, !opts.bulk);
    kind = detected.kind;
    // Detection could not reach ReturnHQ, so we do not know what this parcel
    // is. Writing it now would store a guess that the unique constraint then
    // protects from correction: a re-scan is refused as a duplicate rather
    // than reclassified. Refuse instead, and say so.
    if (detected.lookupFailed) {
      return {
        awb,
        kind,
        detectedReason: detected.reason,
        confident: false,
        result: "error",
        message: "NOT SAVED — could not check whether this is a return. Scan it again.",
        orderName: "",
        deliveryStatus: "",
        returnType: "",
        previousScanAt: "",
      };
    }
  }
  const base: ScanOutcome = {
    awb,
    kind,
    detectedReason: detected?.reason || "",
    confident: detected ? detected.confident : true,
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
      await writeScan(shop, kind, awb, "", "blocked", opts.note || "already dispatched", opts.session || "");
      return {
        ...base,
        result: "blocked",
        message: "ALREADY DISPATCHED. Do not send this packet again.",
      };
    }
  }

  // Which order is this? Unknown is normal, not an error: a parcel dispatched
  // since the last sync will not be in OrderFinancials yet.
  // detectInbound already did both lookups; do not repeat them.
  const order = detected
    ? detected.orderName
      ? { orderName: detected.orderName, deliveryStatus: detected.deliveryStatus }
      : null
    : await prisma.orderFinancials.findFirst({
        where: { shop, awb },
        select: { orderName: true, deliveryStatus: true },
        orderBy: { orderCreatedAt: "desc" },
      });

  let returnType = detected?.returnType || "";
  if (!detected && kind === "customer-return" && order?.orderName) {
    // Best effort: a ReturnHQ outage must not stop the packet being recorded.
    try {
      const { returnHqByOrder } = await import("./returnhq.server");
      const map = await returnHqByOrder([order.orderName]);
      returnType = map.get(order.orderName)?.type || "";
    } catch {
      returnType = "";
    }
  }

  // Our own data first; the sheet only answers where it cannot. A packet
  // scanned the day it ships has no AWB on its order yet, and the sheet has
  // that mapping from the moment the label is printed.
  let orderName = order?.orderName || "";
  let fromSheet = false;
  if (!orderName) {
    try {
      const app = await getPnlApp();
      if (app.deliverySheetUrl) {
        const map = await loadSheetAwbMap(app.deliverySheetUrl);
        const hit = map.get(awb);
        if (hit) {
          orderName = hit;
          fromSheet = true;
        }
      }
    } catch {
      // The sheet is a convenience here; a scan must still be recorded.
    }
  }

  const result: ScanResult = orderName ? "ok" : "not-found";
  await writeScan(shop, kind, awb, orderName, result, opts.note || (fromSheet ? "order from sheet" : ""), opts.session || "");

  return {
    ...base,
    result,
    orderName,
    deliveryStatus: order?.deliveryStatus || "",
    returnType,
    message:
      detected?.reason ||
      (fromSheet
        ? `Matched ${orderName} from the tracking sheet.`
        : buildMessage(kind, result, order?.deliveryStatus || "", returnType)),
  };
}

/**
 * Record a pasted list of AWBs.
 *
 * For reconciling a pile that was worked through offline, or clearing a backlog
 * the gun never saw. Each AWB goes through recordScan unchanged, so detection,
 * the duplicate constraint and the not-found path behave exactly as they do at
 * the bench — a bulk paste must not be a second, looser way in.
 *
 * Sequential on purpose. Detection hits ReturnHQ per AWB, and firing a few
 * hundred of those at once would make a bulk paste the heaviest thing the app
 * does. A list this size is pasted rarely and can afford to take its time.
 *
 * Capped, because the caller is a text box: a runaway paste should be refused
 * with a clear message rather than holding a request open for minutes.
 */
export const BULK_SCAN_LIMIT = 500;

export async function recordScanBulk(
  shop: string,
  requested: ScanKind | "inbound",
  rawList: string,
  session = "",
): Promise<{
  results: ScanOutcome[];
  counts: Record<string, number>;
  skipped: number;
  truncated: boolean;
}> {
  // Split on anything that is not part of an AWB: newlines, commas, tabs,
  // spaces, semicolons. A pasted column and a pasted CSV both work.
  const seen = new Set<string>();
  const list: string[] = [];
  let skipped = 0;
  for (const piece of String(rawList || "").split(/[^0-9a-zA-Z]+/)) {
    const awb = normaliseAwb(piece);
    if (!awb) continue;
    if (awb.length < 6) { skipped++; continue; }
    // A list pasted from a spreadsheet often repeats a row. Deduplicating here
    // keeps the report honest: the same packet listed twice is one parcel, not
    // one scan and one duplicate.
    if (seen.has(awb)) { skipped++; continue; }
    seen.add(awb);
    list.push(awb);
  }

  const truncated = list.length > BULK_SCAN_LIMIT;
  const work = truncated ? list.slice(0, BULK_SCAN_LIMIT) : list;

  const results: ScanOutcome[] = [];
  const counts: Record<string, number> = {};
  for (const awb of work) {
    const outcome = await recordScan(shop, requested, awb, { session, bulk: true });
    results.push(outcome);
    counts[outcome.result] = (counts[outcome.result] || 0) + 1;
  }
  return { results, counts, skipped, truncated };
}

/**
 * Turn a carrier's booking reference into one of our order names.
 *
 * Confirmed against our own orders before it is believed: a reference that
 * names no order of ours is a number, not an answer.
 */
async function orderFromCarrierRef(shop: string, ref: string): Promise<string> {
  const clean = String(ref || "").trim();
  if (!clean) return "";
  // The order number can be on either side of a separator, because the two
  // ways a pickup gets booked write it differently:
  //   "R1790086147-232696"  automated, carrier's id first
  //   "228597-R"            booked by hand, order first
  // So every digit run of order length is a candidate, longest first — an
  // order number is 5-7 digits and a carrier id is far longer.
  const parts = clean.match(/\d{5,7}/g) || [];
  const tries = [clean, `#${clean}`];
  for (const n of parts) tries.push(n, `#${n}`);
  const hit = await prisma.orderFinancials.findFirst({
    where: { shop, orderName: { in: tries } },
    select: { orderName: true },
  });
  return hit?.orderName || "";
}

/** The ReturnHQ request type for an order, or "" when there is none. */
async function returnTypeForOrder(orderName: string): Promise<string> {
  try {
    const { returnHqByOrder } = await import("./returnhq.server");
    const map = await returnHqByOrder([orderName]);
    const hit = map.get(orderName);
    // A cancelled request still means the customer sent it back: the parcel is
    // physically here, so filing it as a courier RTO would put it against the
    // wrong counterparty.
    return hit ? hit.type : "";
  } catch {
    return "";
  }
}

/**
 * Does the carrier's own wording mean the parcel is coming back to us?
 *
 * One regex, used everywhere, because the carriers do not share vocabulary:
 * Delhivery says RTO and DTO, Shadowfax "Returned to Seller" or "Returned To
 * Client", Shiprocket "RTO Delivered". Word boundaries matter — without them
 * "introduction" contains "rto".
 */
const CARRIER_SAYS_RETURN =
  /\brto\b|\brts\b|\bdto\b|return(ed)?\s*to\s*(origin|seller|shipper|client)/;

/**
 * Ask the courier what this AWB is.
 *
 * The last resort, and the only lookup that leaves our network. Used when
 * neither OrderFinancials nor ReturnHQ has heard of the waybill — the courier
 * printed the label, so they always know it.
 *
 * Failure is not an error here: an unknown AWB, a missing credential or a slow
 * courier all mean "no answer", and the caller falls back to its own default.
 * A scan must never wait on a third party that is having a bad day, so this is
 * capped well below the time an operator would notice.
 */
/**
 * The whole carrier step must fit inside Vercel's 10s function limit, and a
 * route-level `export const config` is NOT an option here: lifting it that way
 * previously broke this kind of route's single-fetch .data endpoint, and every
 * scan posts to .data. So the budget is enforced here instead.
 *
 * 2.5s covers a healthy carrier answering and leaves room for the order and
 * ReturnHQ lookups that follow. A carrier slower than that is not worth making
 * an operator wait for — the recheck script resolves it afterwards.
 */
async function trackCourier(awb: string, budgetMs = 2500) {
  try {
    const app = await getPnlApp();
    if (!app.shiprocketEmail && !app.delhiveryApiKey && !app.shadowfaxApiToken) return null;
    const { trackParcel } = await import("./tracking.server");
    return await Promise.race([
      trackParcel({
        awb,
        shiprocketEmail: app.shiprocketEmail,
        shiprocketPassword: app.shiprocketPassword,
        delhiveryApiKey: app.delhiveryApiKey,
        shadowfaxApiToken: app.shadowfaxApiToken,
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
    ]);
  } catch {
    return null;
  }
}

/**
 * Work out whether an inbound parcel is an RTO or a customer return.
 *
 * Returns the reason as well as the verdict: an operator who can see WHY will
 * spot a wrong call, and a verdict with no reason is one they either trust
 * blindly or ignore entirely.
 */
export async function detectInbound(
  shop: string,
  awb: string,
  /** False for a pasted list: five scans share one request, and three carrier
   *  lookups each would blow the function's time budget. The list still
   *  records; the recheck script resolves what the carriers would have. */
  askCarrier = true,
): Promise<{
  kind: InboundKind;
  confident: boolean;
  reason: string;
  orderName: string;
  deliveryStatus: string;
  returnType: string;
  /** True when we could not reach ReturnHQ, so the verdict is not usable. */
  lookupFailed?: boolean;
}> {
  const order = await prisma.orderFinancials.findFirst({
    where: { shop, awb },
    select: { orderName: true, deliveryStatus: true },
    orderBy: { orderCreatedAt: "desc" },
  });

  if (!order) {
    // OrderFinancials only holds the FORWARD AWB. A customer return travels on
    // a reverse waybill (Delhivery's begin with "R"), so the label on a
    // returning parcel will never be found above — and defaulting to RTO would
    // file every reverse pickup as a courier return. ReturnHQ is the only place
    // that waybill exists, so ask it before guessing.
    try {
      const { returnHqByReverseAwb } = await import("./returnhq.server");
      const rev = await returnHqByReverseAwb(awb);
      if (rev && rev.status !== "cancelled") {
        return {
          kind: "customer-return",
          confident: true,
          reason: `Reverse pickup for ${rev.orderName}: customer raised a ${rev.type} request.`,
          orderName: rev.orderName,
          deliveryStatus: "",
          returnType: rev.type,
        };
      }
    } catch {
      // The lookup FAILED — we do not know what this parcel is. Recording it
      // as an RTO would store a guess permanently, and the unique constraint
      // means a later re-scan is refused as a duplicate rather than correcting
      // it. Marked unknown and not confident so the caller can refuse to file
      // it and the operator can scan it again.
      return {
        kind: "rto",
        confident: false,
        reason: "LOOKUP FAILED — not recorded. Scan this packet again.",
        orderName: "",
        deliveryStatus: "",
        returnType: "",
        lookupFailed: true,
      };
    }

    // Neither of our own systems knows this AWB. Ask the courier, who is the
    // one party that definitely does: they printed the label. This is the only
    // step that leaves our network, so it runs last and only when nothing else
    // has answered — a few hundred milliseconds on a parcel we would otherwise
    // have filed under a guess is worth it.
    const carrier = askCarrier ? await trackCourier(awb) : null;
    if (carrier) {
      // The carrier hands back the reference we gave it at booking. A reverse
      // pickup joins the carrier's own id to ours — "R1790086147-232696" —
      // so the order is the tail after the dash. This is the ONLY bridge from
      // a waybill to an order when neither of our tables knows the AWB:
      // ReturnHQ stores its own pickup token (R23706474924), never the
      // carrier's waybill, so the two can only meet through the order number.
      const named = await orderFromCarrierRef(shop, carrier.orderRef || "");
      if (named) {
        const returnType = await returnTypeForOrder(named);
        if (returnType) {
          return {
            kind: "customer-return",
            confident: true,
            reason: `${named}: customer raised a ${returnType} request.`,
            orderName: named,
            deliveryStatus: "",
            returnType,
          };
        }
        return {
          kind: "rto",
          confident: true,
          reason: `${named}, per the courier. No return request on it.`,
          orderName: named,
          deliveryStatus: "",
          returnType: "",
        };
      }

      const text = `${carrier.status} ${carrier.lastActivity}`.toLowerCase();
      // The courier's own words decide it. "RTO", "return to origin" and
      // "returned to seller" all mean the parcel is coming back to us because
      // the customer never took it — which is an RTO, whatever we call it.
      const saysRto = CARRIER_SAYS_RETURN.test(text);
      if (saysRto) {
        return {
          kind: "rto",
          confident: true,
          reason: `Courier says "${carrier.status}". Not in our orders yet.`,
          orderName: "",
          deliveryStatus: "",
          returnType: "",
        };
      }
      // The courier knows the AWB but is not calling it a return. Worth saying
      // exactly what they DID say, so the operator can judge rather than
      // trusting a guess dressed up as an answer.
      return {
        kind: "rto",
        confident: false,
        reason: `Courier says "${carrier.status}", not a return. Check the packet.`,
        orderName: "",
        deliveryStatus: "",
        returnType: "",
      };
    }

    // Nothing to go on. RTO is the safer default: it is the commoner inbound
    // parcel, and miscalling a return as an RTO loses less than the reverse
    // (which would imply a customer request that does not exist).
    return {
      kind: "rto",
      confident: false,
      reason: "Not in our orders, and the courier does not know this AWB either.",
      orderName: "",
      deliveryStatus: "",
      returnType: "",
    };
  }

  let returnType = "";
  try {
    const { returnHqByOrder } = await import("./returnhq.server");
    const map = await returnHqByOrder([order.orderName]);
    const hit = map.get(order.orderName);
    // A cancelled request is not a parcel coming back.
    if (hit && hit.status !== "cancelled") returnType = hit.type;
  } catch {
    // ReturnHQ being down must not stop a packet being booked in.
    returnType = "";
  }

  const isRto = order.deliveryStatus === "rto" || order.deliveryStatus === "rto_in_transit";

  if (returnType) {
    return {
      kind: "customer-return",
      confident: true,
      reason: isRto
        ? `Customer raised a ${returnType} request, though the courier also says RTO.`
        : `Customer raised a ${returnType} request.`,
      orderName: order.orderName,
      deliveryStatus: order.deliveryStatus,
      returnType,
    };
  }

  if (isRto) {
    return {
      kind: "rto",
      confident: true,
      reason: "Courier returned it undelivered.",
      orderName: order.orderName,
      deliveryStatus: order.deliveryStatus,
      returnType: "",
    };
  }

  // No return request, and our own status does not say RTO. Before guessing,
  // ask the courier: our deliveryStatus comes from a twice-daily sheet sync and
  // lags reality by hours, so a parcel on the bench can still read "in_transit"
  // here while the courier has already marked it RTO. Quoting our stale value
  // as if the courier said it is how an RTO got filed as a customer return.
  const live = await trackCourier(awb);
  if (live) {
    const saysRto = CARRIER_SAYS_RETURN.test(
      `${live.status} ${live.lastActivity}`.toLowerCase(),
    );
    if (saysRto) {
      return {
        kind: "rto",
        confident: true,
        reason: `Courier says "${live.status}". No return request on ${order.orderName}.`,
        orderName: order.orderName,
        deliveryStatus: order.deliveryStatus,
        returnType: "",
      };
    }
    // The courier does not call it a return either, yet it is on the bench.
    // Say exactly what they DID say so the operator can judge.
    return {
      kind: "customer-return",
      confident: false,
      reason: `Courier says "${live.status}", not a return, and there is no return request on ${order.orderName}.`,
      orderName: order.orderName,
      deliveryStatus: order.deliveryStatus,
      returnType: "",
    };
  }

  // The courier could not be reached. Fall back to what we hold, and say that
  // the status is ours rather than implying the courier just said it.
  return {
    kind: "customer-return",
    confident: false,
    reason:
      order.deliveryStatus === "delivered"
        ? "Was delivered, but there is NO return request. Check with the customer."
        : `We last had ${order.orderName} as "${order.deliveryStatus}" and there is no return request.`,
    orderName: order.orderName,
    deliveryStatus: order.deliveryStatus,
    returnType: "",
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
  session = "",
): Promise<void> {
  const data = { orderName, result, note, session, scannedAt: new Date() };
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

/**
 * Customer returns the courier delivered, split by whether the bench saw them.
 *
 * The same shape as claimCandidates, against a different counterparty. It joins
 * two systems that do not know about each other: ReturnHQ holds the courier's
 * delivery claim, ScanEvent holds our own physical confirmation.
 *
 * Matching is by AWB, and a return carries a REVERSE waybill — so this compares
 * against the AWB recorded on the scan, which is what the operator's gun read.
 * Comparing on order name instead would miss a scan recorded before the reverse
 * lookup existed, and an order with two return requests would collide.
 */
export async function returnClaimCandidates(
  shop: string,
  graceDays: number,
): Promise<{
  rows: Array<{
    orderName: string;
    awb: string;
    carrier: string;
    receivedAt: string;
    daysOld: number;
    type: string;
    /** True when the bench has physically scanned this parcel in. */
    scanned: boolean;
  }>;
  /** Delivered returns past the cutoff: the denominator for the bar. */
  eligibleCount: number;
  scannedCount: number;
  inFlight: number;
  available: boolean;
}> {
  const { unconfirmedReturns } = await import("./returnhq.server");
  const res = await unconfirmedReturns(graceDays);
  if (!res.available) {
    return { rows: [], eligibleCount: 0, scannedCount: 0, inFlight: res.inFlight, available: false };
  }

  // Which of these has the bench actually scanned? Chunked: an IN list of
  // several thousand is refused by the planner well before it is slow.
  const awbs = res.rows.map((r) => normaliseAwb(r.awb)).filter(Boolean);
  const seen = new Set<string>();
  for (let i = 0; i < awbs.length; i += 2000) {
    const scans = await prisma.scanEvent.findMany({
      where: { shop, kind: "customer-return", awb: { in: awbs.slice(i, i + 2000) } },
      select: { awb: true },
    });
    for (const sc of scans) seen.add(sc.awb);
  }

  // Flagged, not dropped: the caller filters them out by default but can show
  // them, so the list can answer "did we find it?" as well as "what is missing?"
  const rows = res.rows.map((r) => ({ ...r, scanned: seen.has(normaliseAwb(r.awb)) }));
  return {
    rows,
    eligibleCount: res.rows.length,
    scannedCount: seen.size,
    inFlight: res.inFlight,
    available: true,
  };
}

/**
 * AWB to order name, read from the tracking sheet.
 *
 * OrderFinancials only knows an AWB once Shopify has reported the fulfillment,
 * which lags dispatch: a packet scanned on the bench the day it ships has no
 * AWB on its order yet, so the lookup missed and the scan was filed
 * "not in orders" even though we hold the order perfectly well.
 *
 * The sheet has that mapping from the moment the label is printed, so it
 * answers exactly the window our own data cannot. Used ONLY as a fallback,
 * after OrderFinancials: our own data is the authority when it has an answer.
 *
 * Cached in memory for the life of the warm function — the sheet is ~128,000
 * rows and re-fetching it per scan would make every scan slower than the
 * database lookup it is backing up.
 */
const SHEET_CACHE_MS = 10 * 60 * 1000;
let _sheetMap: Map<string, string> | null = null;
let _sheetAt = 0;
let _sheetLoading: Promise<Map<string, string>> | null = null;

async function loadSheetAwbMap(url: string): Promise<Map<string, string>> {
  if (_sheetMap && Date.now() - _sheetAt < SHEET_CACHE_MS) return _sheetMap;
  // One fetch shared by concurrent scans: a bulk paste would otherwise pull
  // the whole sheet once per AWB.
  if (_sheetLoading) return _sheetLoading;

  _sheetLoading = (async () => {
    const map = new Map<string, string>();
    try {
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`sheet ${res.status}`);
      const text = await res.text();
      const lines = text.split(/\r?\n/);
      for (let i = 1; i < lines.length; i++) {
        const cells = lines[i].split(",");
        const awb = normaliseAwb(cells[0] || "");
        // "#238043.1" is one shipment of order #238043; the suffix is the
        // sheet's own split-shipment marker and is not part of the name.
        const order = String(cells[1] || "").trim().replace(/\.\d+$/, "");
        if (awb.length >= 6 && order) map.set(awb, order);
      }
    } catch (e: any) {
      console.error("[scan] sheet map", String(e?.message || e).slice(0, 160));
    }
    _sheetMap = map;
    _sheetAt = Date.now();
    _sheetLoading = null;
    return map;
  })();
  return _sheetLoading;
}


/**
 * Sessions on this scanner, newest first, with what is in each.
 *
 * A session is just a name on a scan, not a row of its own — so it cannot get
 * out of step with the scans it holds, and deleting one is impossible by
 * construction. Reopening one means filtering on that name.
 */
export async function listSessions(
  shop: string,
  kind: ScanKind,
): Promise<Array<{ name: string; count: number; lastAt: string }>> {
  const rows = await prisma.scanEvent.groupBy({
    by: ["session"],
    where: { shop, kind, session: { not: "" } },
    _count: true,
    _max: { scannedAt: true },
    orderBy: { _max: { scannedAt: "desc" } },
    take: 30,
  });
  return rows.map((r) => ({
    name: r.session,
    count: r._count,
    lastAt: r._max.scannedAt ? r._max.scannedAt.toISOString() : "",
  }));
}

/** The scans in one session, for reopening it on the bench. */
export async function sessionScans(shop: string, kind: ScanKind, session: string) {
  if (!session) return [];
  return prisma.scanEvent.findMany({
    where: { shop, kind, session },
    orderBy: { scannedAt: "desc" },
    take: 500,
  });
}


/** Claim statuses the bench can set, matching the prototype's two actions. */
export type ClaimStatus = "received" | "raised";

/** Set or clear a claim status on one parcel. Clicking the active one clears. */
export async function setParcelClaim(
  shop: string,
  awb: string,
  kind: ScanKind,
  status: ClaimStatus | "",
  note = "",
): Promise<void> {
  const clean = normaliseAwb(awb);
  if (!clean) return;
  if (!status) {
    await prisma.parcelClaim.deleteMany({ where: { shop, awb: clean } });
    return;
  }
  await prisma.parcelClaim.upsert({
    where: { shop_awb: { shop, awb: clean } },
    create: { shop, awb: clean, kind, status, note },
    update: { status, note, kind },
  });
}

/** Claim statuses for a set of AWBs, so the table can show them. */
export async function claimStatuses(
  shop: string,
  awbs: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < awbs.length; i += 2000) {
    const rows = await prisma.parcelClaim.findMany({
      where: { shop, awb: { in: awbs.slice(i, i + 2000) } },
      select: { awb: true, status: true },
    });
    for (const r of rows) out.set(r.awb, r.status);
  }
  return out;
}

/** Recent scans for the history page and the session list. */
export async function recentScans(
  shop: string,
  kind: ScanKind | null,
  limit = 200,
  /** Result is a separate axis from kind: "which RTOs did not match an order"
   *  is a real question, and folding it into the kind list could not ask it. */
  result: ScanResult | null = null,
  /** AWB or order name. Matched in the DATABASE, not the page: the list is
   *  capped, so filtering the loaded rows would search a slice and call it a
   *  search — the row you want is usually the one not loaded. */
  search = "",
) {
  return prisma.scanEvent.findMany({
    where: { shop, ...(kind ? { kind } : {}), ...(result ? { result } : {}), ...scanSearchWhere(search) },
    orderBy: { scannedAt: "desc" },
    take: limit,
  });
}

/** Shared by the list and its count, so the two can never disagree. */
export function scanSearchWhere(search: string) {
  const q = String(search || "").trim();
  if (!q) return {};
  // A gun reads an AWB verbatim and a person types an order with or without
  // the "#", so both fields are matched and the hash is optional.
  const bare = q.replace(/^#/, "");
  return {
    OR: [
      { awb: { contains: q, mode: "insensitive" as const } },
      { orderName: { contains: bare, mode: "insensitive" as const } },
    ],
  };
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

/**
 * RTO parcels the courier says came back, that nobody has scanned in.
 *
 * Each one is stock we have been told to expect and have not seen, so past the
 * grace period it is a claim against the courier.
 *
 * The clock is rtoReceivedAt: the date the COURIER says the parcel arrived back
 * with us, imported from the tracking sheet's Delivered Date column. That is the
 * only defensible basis for a claim, because it is the courier's own record of
 * handing the parcel over.
 *
 * Orders with no such date are EXCLUDED rather than aged from something else.
 * The order date would be wrong (always earlier than the return) and
 * deliverySyncedAt would be worse (7,243 orders share one sync day, which is
 * when a backfill ran). A claim sent on a made-up date is worse than a claim
 * not sent, so the count of undated rows is returned for the UI to show.
 */
/** Columns the claims table can be ordered by. */
export type ClaimSort = "days" | "value" | "cost" | "order" | "carrier";

export async function claimCandidates(
  shop: string,
  graceDays: number,
  sort: ClaimSort = "days",
  dir: "asc" | "desc" = "desc",
): Promise<{
  rows: Array<{
    orderName: string;
    awb: string;
    carrier: string;
    receivedAt: string;
    daysOld: number;
    revenueMinor: string;
    cogsMinor: string | null;
    /** True when the bench has physically scanned this parcel in. */
    scanned: boolean;
  }>;
  totalCogsMinor: bigint;
  totalRevenueMinor: bigint;
  scannedCount: number;
  /** Dated RTOs past the cutoff: the denominator scannedCount is a share OF. */
  eligibleCount: number;
  /** RTOs with no courier return date, so they cannot be claimed yet. */
  undatedCount: number;
}> {
  const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

  // Terminal 'rto' only. A parcel still coming back has not arrived, so it is
  // neither claimable nor a gap in our data — counting it as "missing a date"
  // would pad the caveat with parcels the courier is still legitimately
  // carrying, which is the same mistake as claiming on them.
  const undatedCount = await prisma.orderFinancials.count({
    where: {
      shop,
      deliveryStatus: "rto",
      awb: { not: "" },
      rtoReceivedAt: null,
    },
  });

  const rtos = await prisma.orderFinancials.findMany({
    where: {
      shop,
      deliveryStatus: "rto",
      awb: { not: "" },
      rtoReceivedAt: { lt: cutoff },
    },
    select: {
      orderName: true,
      awb: true,
      carrier: true,
      rtoReceivedAt: true,
      grossRevenueMinor: true,
      cogsMinor: true,
    },
    orderBy: { rtoReceivedAt: "asc" },
    // No take: a cap here would silently truncate the totals, and 7 days vs 45
    // days would report identical money because the cap bit before the filter.
    // The row list is trimmed for display in the route instead.
  });
  if (!rtos.length) {
    return { rows: [], totalCogsMinor: 0n, totalRevenueMinor: 0n, scannedCount: 0, eligibleCount: 0, undatedCount };
  }

  // Which of those have actually been scanned in? Chunked: an IN list of
  // several thousand AWBs is refused by the planner well before it is slow.
  const seen = new Set<string>();
  const awbs = rtos.map((r) => r.awb);
  for (let i = 0; i < awbs.length; i += 2000) {
    const scans = await prisma.scanEvent.findMany({
      where: { shop, kind: "rto", awb: { in: awbs.slice(i, i + 2000) } },
      select: { awb: true },
    });
    for (const s of scans) seen.add(s.awb);
  }

  const now = Date.now();
  // Scanned parcels are RETURNED, flagged rather than dropped. They are the
  // proof the process is working, and a list that can only ever show failures
  // cannot answer "did we find it?" — the caller filters them out by default.
  const rows = rtos.map((r) => ({
    orderName: r.orderName,
    awb: r.awb,
    carrier: r.carrier,
    receivedAt: r.rtoReceivedAt!.toISOString().slice(0, 10),
    daysOld: Math.floor((now - r.rtoReceivedAt!.getTime()) / 86400000),
    revenueMinor: r.grossRevenueMinor.toString(),
    cogsMinor: r.cogsMinor == null ? null : r.cogsMinor.toString(),
    scanned: seen.has(r.awb),
  }));

  // Sorted over the WHOLE set, before the route trims to 500. Sorting only the
  // visible page would reorder an arbitrary slice and call it "the highest
  // value", which is worse than not offering the control at all.
  const sign = dir === "asc" ? 1 : -1;
  const num = (v: string | null) => (v == null ? -1 : Number(v));
  rows.sort((a, b) => {
    switch (sort) {
      case "value":
        return sign * (num(a.revenueMinor) - num(b.revenueMinor));
      case "cost":
        // Unknown cost sorts last in either direction: it is absent data, not
        // a low number, and letting it lead a descending list would be a lie.
        if (a.cogsMinor == null || b.cogsMinor == null) {
          return (a.cogsMinor == null ? 1 : 0) - (b.cogsMinor == null ? 1 : 0);
        }
        return sign * (num(a.cogsMinor) - num(b.cogsMinor));
      case "order":
        return sign * a.orderName.localeCompare(b.orderName, undefined, { numeric: true });
      case "carrier":
        return sign * (a.carrier || "￿").localeCompare(b.carrier || "￿");
      default:
        return sign * (a.daysOld - b.daysOld);
    }
  });

  let totalCogsMinor = 0n;
  let totalRevenueMinor = 0n;
  for (const r of rtos) {
    if (seen.has(r.awb)) continue;
    totalCogsMinor += r.cogsMinor ?? 0n;
    totalRevenueMinor += r.grossRevenueMinor;
  }

  return { rows, totalCogsMinor, totalRevenueMinor, scannedCount: seen.size, eligibleCount: rtos.length, undatedCount };
}
