/**
 * Meta Conversions API — forwards wishlist adds as server-side `AddToWishlist`
 * events, so Facebook can retarget a shopper with the exact product they saved.
 *
 * Server-side (not the browser pixel) because it survives ad-blockers and iOS
 * tracking restrictions, and because the access token must never reach the
 * storefront.
 *
 * MATCHING, and its honest limits: Meta matches best on hashed email, but email
 * is Shopify Protected Customer Data Level 2 and this app holds Level 1 only
 * (request #106713 — see app/utils/order-actions.server.ts). So by default we
 * match on what we can legitimately see: Meta's own first-party cookies
 * (_fbp/_fbc), the client IP and user agent, and the Shopify customer id hashed
 * as external_id. That is a lower match rate than email, not a broken one.
 * When Level 2 is approved, set capiSendEmail and pass `email` — nothing else
 * changes.
 */
import crypto from "node:crypto";
import { GRAPH_VERSION } from "./meta-ads.server";

export type CapiResult =
  | { ok: true; eventsReceived: number }
  | { ok: false; reason: string; permanent?: boolean };

/**
 * SHA-256 of a normalised value, as Meta requires: trimmed and lower-cased, so
 * "  Foo@Bar.com " and "foo@bar.com" hash alike. Empty in, empty out — an empty
 * string must never be hashed, or every anonymous shopper shares one identity.
 */
function hashed(value: string | null | undefined): string | undefined {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return undefined;
  return crypto.createHash("sha256").update(v).digest("hex");
}

/** Drop undefined keys so we never send Meta a field with no value. */
function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== "") out[k] = v;
  }
  return out as Partial<T>;
}

export type WishlistCapiEvent = {
  datasetId: string;
  accessToken: string;
  /** Product handle — also the content_id Meta retargets on. */
  handle: string;
  productId?: string;
  value?: number;
  currency?: string;
  /** Shopify customer id, hashed to external_id. Absent for guests. */
  customerId?: string;
  /** Only when Protected Customer Data Level 2 is approved. */
  email?: string;
  /** Meta's first-party cookies, read from the storefront. */
  fbp?: string;
  fbc?: string;
  /** From the REQUEST, never the client — a spoofed IP poisons matching. */
  clientIp?: string;
  clientUserAgent?: string;
  /** Shared with the browser pixel so Meta can dedupe if the merchant runs both. */
  eventId: string;
  eventSourceUrl?: string;
  /** Routes the event to Events Manager > Test Events instead of live data. */
  testEventCode?: string;
};

/**
 * Send one AddToWishlist event. Returns a result rather than throwing: a Meta
 * outage must never break a shopper's wishlist.
 */
export async function sendWishlistEvent(ev: WishlistCapiEvent): Promise<CapiResult> {
  if (!ev.datasetId || !ev.accessToken) {
    return { ok: false, reason: "Add the Meta dataset id and access token in Settings.", permanent: true };
  }

  const userData = compact({
    em: ev.email ? hashed(ev.email) : undefined,
    external_id: hashed(ev.customerId),
    fbp: ev.fbp,
    fbc: ev.fbc,
    client_ip_address: ev.clientIp,
    client_user_agent: ev.clientUserAgent,
  });

  // Meta rejects an event it cannot attribute to anyone. Better to skip it than
  // to burn a retry on something that can never succeed.
  if (Object.keys(userData).length === 0) {
    return { ok: false, reason: "No identifiers available to match this shopper.", permanent: true };
  }

  const payload = {
    data: [
      {
        event_name: "AddToWishlist",
        event_time: Math.floor(Date.now() / 1000),
        action_source: "website",
        event_id: ev.eventId,
        event_source_url: ev.eventSourceUrl,
        user_data: userData,
        custom_data: compact({
          content_ids: [ev.productId || ev.handle],
          content_type: "product",
          content_name: ev.handle,
          value: ev.value,
          currency: ev.currency,
        }),
      },
    ],
    ...(ev.testEventCode ? { test_event_code: ev.testEventCode } : {}),
  };

  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(ev.datasetId)}/events?access_token=${encodeURIComponent(ev.accessToken)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({} as any));

    if (body?.error) {
      const msg = String(body.error.message || "Meta API error");
      // A bad token or dataset can't be fixed by retrying — the merchant must act.
      if (/access token|OAuth|expired|session|permission/i.test(msg)) {
        return {
          ok: false,
          permanent: true,
          reason: "The Meta access token is invalid, expired, or lacks permission. Generate a new one in Settings.",
        };
      }
      if (/unknown path|does not exist|Unsupported/i.test(msg)) {
        return { ok: false, permanent: true, reason: "That Meta dataset (pixel) id wasn't found. Check it in Settings." };
      }
      return { ok: false, reason: msg.slice(0, 160) };
    }
    if (!res.ok) {
      return { ok: false, reason: `Meta HTTP ${res.status}` };
    }
    return { ok: true, eventsReceived: Number(body?.events_received ?? 0) || 0 };
  } catch {
    // Network/timeout: worth retrying, so NOT permanent.
    return { ok: false, reason: "Couldn't reach the Meta API. It will be retried." };
  }
}
