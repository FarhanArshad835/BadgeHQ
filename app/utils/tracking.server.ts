/**
 * Live parcel tracking for the WhatsApp support bot.
 *
 * When a shopper asks "where's my order?", the merchant's DoubleTick flow bot
 * has almost always already posted the order number and AWB into the thread
 * (e.g. "Order Number: 208976  AWB: 152980560267062"). So we don't need Shopify
 * at all — which matters, because BadgeHQ has NO Protected Customer Data
 * approval and cannot query orders/fulfillments. We pull the AWB straight out of
 * the conversation text and ask the carrier directly.
 *
 * jmlooks books ~70% of parcels with Shiprocket and the rest with Delhivery, so
 * we try both. Delhivery reuses the key already saved for the storefront
 * delivery-estimate feature (DeliverySettings.apiToken); Shiprocket uses the
 * email/password saved on AiReplySettings.
 *
 * The carrier logic mirrors ReturnHQ's tracking clients (same endpoints, same
 * IST timestamp handling), trimmed to a read-only status lookup. The result is
 * a plain-language summary the LLM turns into a natural reply — it is never sent
 * verbatim, so the bot can answer follow-ups like "kitna time lagega" in the
 * shopper's own language.
 */

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";
const DELHIVERY_API_URL = "https://track.delhivery.com";

export type TrackingResult = {
  awb: string;
  carrier: "shiprocket" | "delhivery";
  /** Clean current status, e.g. "In Transit", "Delivered", "Out for Delivery". */
  status: string;
  /** The latest scan's activity text, verbatim from the courier. Matters because
   *  the shipment-level `status` lags: it can read "In Transit" while the most
   *  recent event is a failed delivery ("customer not available", "no such
   *  address"). The AI needs the real latest event, not just the rolled-up
   *  status, or it tells a customer whose delivery FAILED that it's on its way. */
  lastActivity: string;
  /** Where it was last scanned, if the carrier gave a location. */
  location: string;
  /** Carrier's last-update timestamp, human phrasing (IST), if available. */
  lastUpdate: string;
  /** True once the carrier reports the parcel delivered. */
  delivered: boolean;
  /** True when the latest scan looks like a failed/undelivered attempt (NDR),
   *  so the AI can flag it instead of saying "on its way". */
  failedAttempt: boolean;
  /** The reference WE gave the carrier at booking — Delhivery's ReferenceNo,
   *  Shadowfax's client_order_id. A reverse pickup joins the carrier's own id
   *  to ours ("R1790086147-232696"), so the order is the tail after the dash.
   *  The only bridge to an order when no table of ours knows the waybill. */
  orderRef?: string;
  /**
   * True when the carrier COLLECTED this parcel from the customer, rather than
   * carrying it to them and bringing it back.
   *
   * The difference is the whole RTO-versus-customer-return question, and the
   * status text cannot answer it: a reverse pickup arrives reading "DTO" with
   * "Dispatched for RTO" in its history, exactly like a parcel the customer
   * refused. Only the direction of the journey separates them.
   */
  pickedUpFromCustomer?: boolean;
};

/**
 * Pull the most likely AWB out of free conversation text.
 *
 * AWBs are long digit runs. Shiprocket AWBs are typically 10-16 digits;
 * Delhivery waybills 11-14. Order numbers (5-6 digits) are too short to be an
 * AWB, so a >=8-digit run is a safe floor that never collides with them. We
 * prefer a number explicitly labelled "AWB", then fall back to the longest bare
 * digit run — the longest is almost always the AWB, since order numbers and
 * phone fragments are shorter.
 */
export function extractAwb(text: string): string | null {
  const t = String(text || "");

  // Labelled AWB wins — "AWB: 152980560267062", "awb 152980560267062".
  const labelled = t.match(/awb\s*[:#-]?\s*(\d{8,})/i);
  if (labelled) return labelled[1];

  // Otherwise the longest 8+ digit run. Strip separators inside a run first
  // ("1529 8056 0267 062" -> one number) is deliberately NOT done: carriers
  // print AWBs unbroken, and joining across spaces risks welding two numbers.
  const runs = t.match(/\d{8,}/g);
  if (!runs || runs.length === 0) return null;
  return runs.sort((a, b) => b.length - a.length)[0];
}

/** IST-aware timestamp phrasing. Carriers return naive IST datetimes (no TZ);
 *  JS would read them as UTC and be 5h30m off, so we tag +05:30 before parsing,
 *  matching ReturnHQ's parseIndianCarrierTimestamp. Returns "" on unparseable
 *  input rather than a wrong date. */
function phraseIstTimestamp(raw: string): string {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  let d: Date;
  const hasTz = /(?:Z|[+-]\d{2}:?\d{2})$/.test(trimmed);
  const m = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(\.\d+)?$/);
  if (hasTz) {
    d = new Date(trimmed);
  } else if (m) {
    d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7] ?? ""}+05:30`);
  } else {
    d = new Date(trimmed);
  }
  if (isNaN(d.getTime())) return "";
  // Render in IST, e.g. "22 Jul, 1:21 PM".
  return d.toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

const DELIVERED_RE = /\bdelivered\b/i;
const NOT_DELIVERED_RE = /\b(un|not\s+)delivered\b/i;

function isDelivered(status: string): boolean {
  return DELIVERED_RE.test(status) && !NOT_DELIVERED_RE.test(status);
}

// A failed delivery attempt / NDR (non-delivery report). Couriers phrase these
// many ways — "undelivered", "customer not available", "no such address",
// "consignee not available", "CNEE", "attempt failed", "refused". When the
// latest scan is one of these, the parcel is NOT simply "on its way" — the
// customer needs to know the attempt failed and what to do.
const FAILED_ATTEMPT_RE =
  /undelivered|not\s+available|no\s+such|cnee|consignee|address\s+(issue|incomplete|wrong)|attempt\s+fail|delivery\s+fail|refused|rto|return\s+to\s+origin|ndr/i;

function isFailedAttempt(text: string): boolean {
  const t = String(text || "");
  if (isDelivered(t)) return false; // a delivered scan is never a failed attempt
  return FAILED_ATTEMPT_RE.test(t);
}

const SHADOWFAX_BULK_URL = "https://dale.shadowfax.in/api/v4/clients/bulk_track/";

/**
 * Shadowfax: POST the waybill to the bulk endpoint, read the one result back.
 *
 * Bulk is the only tracking endpoint Shadowfax exposes, so a single AWB goes in
 * a list of one. Mirrors the tracking script's trackWithShadowfaxBulk, including
 * the detail that its terminal RTO scan reads "Returned To Client" under
 * status_id rto_d or rts_d — words no other carrier uses, which is why matching
 * on prose alone misses it.
 */
async function trackShadowfax(token: string, awb: string): Promise<TrackingResult | null> {
  const res = await fetch(SHADOWFAX_BULK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Token ${token}` },
    body: JSON.stringify({ awb_numbers: [awb] }),
    signal: AbortSignal.timeout(4000),
  });
  if (!res.ok) return null;
  const body = await res.json().catch(() => null);
  const row = (Array.isArray(body?.data) ? body.data : []).find(
    (o: any) => String(o?.awb_number || "").trim() === awb,
  );
  if (!row) return null;

  const scans: any[] = Array.isArray(row.tracking_details) ? row.tracking_details : [];
  const latest = scans[scans.length - 1] || {};
  const status = String(row.status_display || row.status || "").trim();
  const lastActivity = String(latest.status || "").trim();

  // The parcel is back with us, whatever Shadowfax calls it.
  const terminal = new Set(["delivered", "rto_d", "rts_d"]);
  const id = String(latest.status_id || "").toLowerCase().trim();

  return {
    awb,
    // Shadowfax is its own carrier, but the type names the two the app knew
    // first. Reported as delhivery so existing callers keep working; the
    // status text is what any caller actually reads.
    carrier: "delhivery",
    status: status || "Unknown",
    lastActivity,
    location: String(latest.location || "").trim(),
    lastUpdate: String(latest.created || "").trim(),
    delivered: id === "delivered",
    failedAttempt: FAILED_ATTEMPT_RE.test(`${status} ${lastActivity}`),
    orderRef: String(row.client_order_id || "").trim(),
  };
}

/** Shiprocket: authenticate, then GET /courier/track/awb/{awb}. Mirrors
 *  ReturnHQ's getShiprocketTrackingStatus but returns a compact summary. */
async function trackShiprocket(
  email: string,
  password: string,
  awb: string,
): Promise<TrackingResult | null> {
  const authRes = await fetch(`${SHIPROCKET_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(4000),
  });
  const auth = await authRes.json().catch(() => ({}));
  if (!authRes.ok || !auth?.token) return null;

  const res = await fetch(
    `${SHIPROCKET_BASE_URL}/courier/track/awb/${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(4000) },
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const td = data?.tracking_data;
  if (!td || td?.error) return null;

  const activities: any[] = Array.isArray(td.shipment_track_activities)
    ? td.shipment_track_activities
    : [];
  const latest = activities[0] || {};
  // Shipment-level status is the clean one ("Delivered", "In Transit"); the
  // latest activity text is often a cryptic courier code.
  const shipmentStatus = String(
    td.shipment_status_text ?? td.shipment_track?.[0]?.current_status ?? latest.activity ?? "",
  ).trim();
  if (!shipmentStatus) return null;

  const lastActivity = String(latest.activity || "").trim();
  return {
    awb,
    carrier: "shiprocket",
    status: shipmentStatus,
    lastActivity,
    location: String(latest.location || "").trim(),
    lastUpdate: phraseIstTimestamp(String(latest.date || "")),
    delivered: isDelivered(shipmentStatus) || isDelivered(lastActivity),
    // The latest activity is the freshest truth — the rolled-up status lags.
    failedAttempt: isFailedAttempt(lastActivity) || isFailedAttempt(shipmentStatus),
    orderRef: String(td.shipment_track?.[0]?.order_id ?? "").trim(),
  };
}

/** Delhivery: GET /api/v1/packages/json/?waybill=. Mirrors ReturnHQ's
 *  getTrackingStatusBatch for a single AWB. */
/**
 * Did Delhivery collect this parcel FROM the customer?
 *
 * OrderType is the carrier's own word for the job it was given: "Pickup" means
 * a courier went to the consignee's address and took the parcel away, which is
 * a customer return however the status later reads.
 *
 * Corroborated by the scan trail rather than trusted alone — a reverse pickup
 * carries "Out for pickup" and "Pickup completed" at the consignee's location,
 * and those phrases never appear on a forward shipment, which is dispatched
 * from our warehouse instead.
 *
 * This matters because the end state is identical either way: both arrive
 * reading "DTO"/"RETURN Accepted", so anything reading only the status files
 * every manually-booked return as a courier RTO.
 */
function isReversePickup(shipment: any): boolean {
  if (String(shipment?.OrderType || "").trim().toLowerCase() === "pickup") return true;
  const scans: any[] = Array.isArray(shipment?.Scans) ? shipment.Scans : [];
  return scans.some((x) => {
    const d = x?.ScanDetail || {};
    const text = `${d.Instructions || ""}`.toLowerCase();
    // "Out for pickup" / "Pickup completed" — the courier going TO the customer.
    // ScanType "PP" is Delhivery's own marker for the pickup leg.
    return (
      String(d.ScanType || "").toUpperCase() === "PP" ||
      /out for pickup|pickup completed/.test(text)
    );
  });
}

async function trackDelhivery(apiKey: string, awb: string): Promise<TrackingResult | null> {
  const res = await fetch(
    `${DELHIVERY_API_URL}/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Token ${apiKey}` }, signal: AbortSignal.timeout(4000) },
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const shipment = (data?.ShipmentData || [])[0]?.Shipment;
  const status = String(shipment?.Status?.Status || "").trim();
  if (!shipment || !status) return null;

  // Delhivery puts the reason for a failed attempt in Status.Instructions
  // (e.g. "Consignee not available"); fall back to the status text itself.
  const instructions = String(shipment.Status?.Instructions || "").trim();
  const lastActivity = instructions || status;
  return {
    awb,
    carrier: "delhivery",
    status,
    lastActivity,
    location: String(shipment.Status?.StatusLocation || "").trim(),
    lastUpdate: phraseIstTimestamp(String(shipment.Status?.StatusDateTime || "")),
    delivered: isDelivered(status),
    failedAttempt: isFailedAttempt(status) || isFailedAttempt(instructions),
    orderRef: String(shipment.ReferenceNo || "").trim(),
    pickedUpFromCustomer: isReversePickup(shipment),
  };
}

/**
 * Try to resolve a live tracking status for an AWB using whatever carrier
 * credentials the merchant has. Shiprocket is tried first (70% of parcels), then
 * Delhivery. A carrier that doesn't recognise the AWB (or isn't configured)
 * returns null and we fall through. On total failure returns null and the caller
 * degrades to the normal handoff — never a hard error to the shopper.
 */
/** Delhivery books its own waybills under this prefix; everything else routes
 *  to Shiprocket, which is the aggregator. Matches the tracking script. */
const DELHIVERY_PREFIX = "2606";
/** Shadowfax waybills start "SF", case-insensitively. */
const SHADOWFAX_PREFIX = "SF";

/**
 * Which carrier booked this waybill.
 *
 * The same rule, in the same order, as detectCourier in the tracking script:
 * Shadowfax FIRST so an SF-prefixed AWB never falls through to the Shiprocket
 * default, then Delhivery's own prefix, then Shiprocket as the aggregator that
 * books everything else.
 *
 * Keeping the two in step matters: a mismatch means the sheet and the app
 * disagree about who to ask, and the wrong carrier answers "no shipment present
 * against this tracking id" — a denial confident enough to look like a fact.
 */
function detectCourier(awb: string): "shadowfax" | "delhivery" | "shiprocket" {
  const a = String(awb).trim();
  if (a.toUpperCase().startsWith(SHADOWFAX_PREFIX)) return "shadowfax";
  if (a.startsWith(DELHIVERY_PREFIX)) return "delhivery";
  return "shiprocket";
}

export async function trackParcel(opts: {
  awb: string;
  shiprocketEmail?: string;
  shiprocketPassword?: string;
  delhiveryApiKey?: string;
  shadowfaxApiToken?: string;
}): Promise<TrackingResult | null> {
  const { awb, shiprocketEmail, shiprocketPassword, delhiveryApiKey, shadowfaxApiToken } = opts;
  if (!awb) return null;

  // Routed by AWB prefix, the way the tracking script does it, then the others
  // tried as a fallback. Order matters: asking Shiprocket about a Delhivery
  // waybill gets "no shipment present against this tracking id", which looks
  // like a definite answer and stops the search before the carrier that
  // actually holds the parcel is ever asked. Verified: five 2606… waybills
  // Shiprocket disowned were all known to Delhivery.
  const sr = () => trackShiprocket(shiprocketEmail!, shiprocketPassword!, awb);
  const dl = () => trackDelhivery(delhiveryApiKey!, awb);
  const sf = () => trackShadowfax(shadowfaxApiToken!, awb);

  const avail: Record<string, (() => Promise<TrackingResult | null>) | null> = {
    shiprocket: shiprocketEmail && shiprocketPassword ? sr : null,
    delhivery: delhiveryApiKey ? dl : null,
    shadowfax: shadowfaxApiToken ? sf : null,
  };

  // The routed carrier first, the others after. Unlike the script, which stops
  // at its verdict, a miss here falls through: a mis-prefixed AWB is then still
  // found rather than written off on one carrier's denial.
  const first = detectCourier(awb);
  const order = [first, ...(["shiprocket", "delhivery", "shadowfax"] as const).filter((k) => k !== first)];

  const attempts = order.map((k) => avail[k]).filter(Boolean) as Array<
    () => Promise<TrackingResult | null>
  >;

  for (const attempt of attempts) {
    try {
      const result = await attempt();
      if (result) return result;
    } catch (e: any) {
      // A carrier being down or slow must not fail the whole reply — log and try
      // the next one, then fall back to handoff.
      console.error("[tracking] carrier lookup failed:", String(e?.message || e).slice(0, 200));
    }
  }
  return null;
}

/** Fixed-format context line handed to the LLM. Not sent to the shopper — the
 *  model rewrites it conversationally, in the shopper's language.
 *
 *  Includes today's IST date explicitly, because the LLM has no reliable notion
 *  of the current date and was compressing "as of 23 Jul" into "today" (wrong on
 *  the 24th). Giving it both the scan date AND today's date lets it say
 *  "yesterday"/"2 days ago" correctly, or just quote the date. */
export function trackingContextForLlm(r: TrackingResult): string {
  const today = new Date().toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const parts = [`AWB ${r.awb} (${r.carrier}) overall status: ${r.status}`];
  // The latest scan is the freshest truth and can differ from the rolled-up
  // status — surface it so the AI reflects reality, not a lagging summary.
  if (r.lastActivity && r.lastActivity.toLowerCase() !== r.status.toLowerCase()) {
    parts.push(`latest scan event: "${r.lastActivity}"`);
  }
  if (r.location) parts.push(`last scanned at ${r.location}`);
  if (r.lastUpdate) parts.push(`last courier scan was on ${r.lastUpdate} IST`);
  let out =
    parts.join(", ") +
    `. (Today's date is ${today}. Use the scan date exactly as given above — do ` +
    `NOT say "today" unless the scan date is actually today, and do not invent a ` +
    `newer time.)`;
  if (r.failedAttempt) {
    out +=
      " IMPORTANT: the latest scan is a FAILED delivery attempt (the courier " +
      "couldn't deliver — e.g. customer not available or address issue). Do NOT " +
      'say the parcel is "on its way" or "out for delivery soon". Tell the ' +
      "customer the delivery attempt failed and why, and that the courier will " +
      "usually reattempt - ask them to confirm their address/availability or " +
      "keep their phone reachable. Offer to connect them to the team if they need " +
      "to arrange redelivery.";
  }
  return out;
}
