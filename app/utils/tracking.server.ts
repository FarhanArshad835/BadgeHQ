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
  /** Where it was last scanned, if the carrier gave a location. */
  location: string;
  /** Carrier's last-update timestamp, human phrasing (IST), if available. */
  lastUpdate: string;
  /** True once the carrier reports the parcel delivered. */
  delivered: boolean;
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
    signal: AbortSignal.timeout(10000),
  });
  const auth = await authRes.json().catch(() => ({}));
  if (!authRes.ok || !auth?.token) return null;

  const res = await fetch(
    `${SHIPROCKET_BASE_URL}/courier/track/awb/${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Bearer ${auth.token}` }, signal: AbortSignal.timeout(10000) },
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

  return {
    awb,
    carrier: "shiprocket",
    status: shipmentStatus,
    location: String(latest.location || "").trim(),
    lastUpdate: phraseIstTimestamp(String(latest.date || "")),
    delivered: isDelivered(shipmentStatus) || isDelivered(String(latest.activity || "")),
  };
}

/** Delhivery: GET /api/v1/packages/json/?waybill=. Mirrors ReturnHQ's
 *  getTrackingStatusBatch for a single AWB. */
async function trackDelhivery(apiKey: string, awb: string): Promise<TrackingResult | null> {
  const res = await fetch(
    `${DELHIVERY_API_URL}/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`,
    { headers: { Authorization: `Token ${apiKey}` }, signal: AbortSignal.timeout(10000) },
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  const shipment = (data?.ShipmentData || [])[0]?.Shipment;
  const status = String(shipment?.Status?.Status || "").trim();
  if (!shipment || !status) return null;

  return {
    awb,
    carrier: "delhivery",
    status,
    location: String(shipment.Status?.StatusLocation || "").trim(),
    lastUpdate: phraseIstTimestamp(String(shipment.Status?.StatusDateTime || "")),
    delivered: isDelivered(status),
  };
}

/**
 * Try to resolve a live tracking status for an AWB using whatever carrier
 * credentials the merchant has. Shiprocket is tried first (70% of parcels), then
 * Delhivery. A carrier that doesn't recognise the AWB (or isn't configured)
 * returns null and we fall through. On total failure returns null and the caller
 * degrades to the normal handoff — never a hard error to the shopper.
 */
export async function trackParcel(opts: {
  awb: string;
  shiprocketEmail?: string;
  shiprocketPassword?: string;
  delhiveryApiKey?: string;
}): Promise<TrackingResult | null> {
  const { awb, shiprocketEmail, shiprocketPassword, delhiveryApiKey } = opts;
  if (!awb) return null;

  const attempts: Array<() => Promise<TrackingResult | null>> = [];
  if (shiprocketEmail && shiprocketPassword) {
    attempts.push(() => trackShiprocket(shiprocketEmail, shiprocketPassword, awb));
  }
  if (delhiveryApiKey) {
    attempts.push(() => trackDelhivery(delhiveryApiKey, awb));
  }

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
 *  model rewrites it conversationally, in the shopper's language. */
export function trackingContextForLlm(r: TrackingResult): string {
  const parts = [`AWB ${r.awb} (${r.carrier}) current status: ${r.status}`];
  if (r.location) parts.push(`last scanned at ${r.location}`);
  if (r.lastUpdate) parts.push(`as of ${r.lastUpdate} IST`);
  return parts.join(", ") + ".";
}
