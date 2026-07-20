/**
 * Channel logic for AI replies over WhatsApp (Interakt inbound).
 *
 * Splits cleanly from the AI engine: ai-replies.server.ts knows nothing about
 * WhatsApp, and this file knows nothing about Gemini. It handles verifying that
 * a webhook really came from Interakt, deciding which payloads deserve a reply,
 * and the conversation bookkeeping.
 *
 * Everything here is written so the webhook route can stay fast and total —
 * Interakt allows only 3 seconds and disables the integration after 5 failures
 * in 10 minutes, so nothing in this path may throw or block.
 */
import crypto from "node:crypto";
import { MAX_MESSAGE_CHARS, trimHistory, type ChatTurn } from "./ai-replies.server";

/** Replies allowed per shopper per hour — protects the merchant's Gemini quota. */
export const RATE_LIMIT_PER_HOUR = 20;
export const RATE_WINDOW_MS = 60 * 60 * 1000;
/** Conversations are purged this long after the last message. */
export const PURGE_AFTER_HOURS = 24;

/**
 * Verify Interakt's `Interakt-Signature` header: "sha256=" + hex HMAC-SHA256 of
 * the RAW request body, keyed with the merchant's secret.
 *
 * Must be given the raw body string, not a re-serialised object — JSON.stringify
 * of a parsed payload will not reproduce the original bytes.
 */
export function verifyInteraktSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string,
): boolean {
  // No secret configured means we cannot tell real traffic from forged, and this
  // endpoint spends the merchant's Gemini quota and sends messages as them.
  // Fail closed.
  if (!secret || !header) return false;

  const received = String(header).trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]+$/i.test(received)) return false;

  const expected = crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");

  const a = Buffer.from(received.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  // timingSafeEqual throws on length mismatch, so check first.
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** URL-safe opaque token for the per-shop webhook path. */
export function generateWebhookToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export type InboundMessage = {
  phone: string; // raw, as Interakt sent it — normalised at send time
  text: string;
  messageId: string;
  customerName: string;
};

/**
 * Pull a repliable customer message out of a webhook payload, or return null.
 *
 * Returning null is the normal case, not an error: the same URL receives every
 * delivery-status event too. Crucially this is also the loop guard — our own
 * outbound messages come back as `message_api_*`, and replying to those would
 * make the bot talk to itself forever.
 */
export function parseInboundMessage(payload: any): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;

  // Only genuine inbound customer messages. Excludes every message_api_* and
  // message_campaign_* echo of our own sends.
  if (payload.type !== "message_received") return null;

  const msg = payload?.data?.message;
  const customer = payload?.data?.customer;
  if (!msg || !customer) return null;

  // Defence in depth: an inbound-shaped event that isn't from the customer.
  if (msg.chat_message_type !== "CustomerMessage") return null;
  if (msg.is_template_message === true) return null;

  // Images/audio/documents carry media_url and no usable text. Stay silent
  // rather than replying "I can only read text" — silence cannot loop.
  if (msg.message_content_type !== "Text") return null;

  const text = String(msg.message ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  const phone = String(customer.channel_phone_number ?? "").trim();
  const messageId = String(msg.id ?? "").trim();
  if (!text || !phone || !messageId) return null;

  return {
    phone,
    text,
    messageId,
    customerName: String(customer?.traits?.name ?? "").trim(),
  };
}

/**
 * Pull a repliable customer message out of a DoubleTick webhook payload.
 *
 * DoubleTick's payload is flat where Interakt's is nested, and it distinguishes
 * inbound from outbound by `status: "received"` rather than an event type. That
 * check is the loop guard: our own sends come back as "sent"/"delivered"/"read",
 * and replying to those would make the bot talk to itself.
 *
 * `from` is the customer (international format, no +); `to` is the business
 * number. Non-text messages carry a media url and no usable text — return null
 * and stay silent, exactly as the Interakt parser does.
 */
export function parseDoubleTickInbound(payload: any): InboundMessage | null {
  if (!payload || typeof payload !== "object") return null;

  if (String(payload.status ?? "").toLowerCase() !== "received") return null;

  const msg = payload.message;
  if (!msg || String(msg.type ?? "").toUpperCase() !== "TEXT") return null;

  const text = String(msg.text ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
  const phone = String(payload.from ?? "").trim();
  // dtMessageId is DoubleTick's own UUID; messageId is Meta's. Prefer the
  // former — it is present on every event and is what their dashboard shows.
  const messageId = String(payload.dtMessageId ?? payload.messageId ?? "").trim();
  if (!text || !phone || !messageId) return null;

  return {
    phone,
    text,
    messageId,
    customerName: String(payload?.contact?.name ?? "").trim(),
  };
}

/**
 * Verify a DoubleTick webhook.
 *
 * DoubleTick signs nothing — there is no HMAC to check. What it does offer is an
 * `authorization` block at registration whose value it echoes on every delivery,
 * so we generate a token per shop and compare that. Weaker than Interakt's HMAC
 * (a token replays; a body signature does not), but it is the strongest thing
 * the provider supports, and the opaque per-shop URL token gates it further.
 *
 * Fails closed when no token is stored, matching verifyInteraktSignature.
 */
export function verifyDoubleTickAuth(header: string | null | undefined, expected: string): boolean {
  if (!expected || !header) return false;

  const received = String(header).trim().replace(/^Bearer\s+/i, "");
  const a = Buffer.from(received, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Register our webhook with DoubleTick so the merchant doesn't have to paste
 * anything into their dashboard.
 *
 * Only MESSAGE_RECEIVED is requested — status updates would be pure noise here,
 * and every one we ignore still costs a request. retryOnTimeout is left off: the
 * route queues and returns immediately, so a timeout means something is broken
 * badly enough that a retry would duplicate the reply rather than fix it.
 */
export async function registerDoubleTickWebhook(opts: {
  apiKey: string;
  url: string;
  authToken: string;
  fromNumber: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!opts.apiKey) return { ok: false, error: "no-api-key" };
  if (!opts.url || !opts.authToken) return { ok: false, error: "no-webhook-url" };

  const waba = opts.fromNumber.replace(/\D/g, "");

  try {
    const res = await fetch("https://public.doubletick.io/v2/webhook/register", {
      method: "POST",
      headers: {
        Authorization: opts.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        name: "BadgeHQ Automated Replies",
        url: opts.url,
        method: "POST",
        bodyFormat: "JSON",
        retryOnTimeout: false,
        // Echoed back to us on every delivery — this is what we verify.
        authorization: { type: "BEARER", payload: opts.authToken },
        webhookEvents: ["MESSAGE_RECEIVED"],
        ...(waba ? { wabaNumbers: [waba] } : {}),
      }),
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "auth-failed (check the DoubleTick API key)" };
      }
      let body: any = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* non-JSON error page */
      }
      return {
        ok: false,
        error: String(body?.message || body?.error || text || `http-${res.status}`).slice(0, 300),
      };
    }
    return { ok: true };
  } catch (e: any) {
    return {
      ok: false,
      error: e?.name === "TimeoutError" ? "timeout" : String(e?.message || e).slice(0, 200),
    };
  }
}

const STOP_WORDS = new Set([
  "stop",
  "unsubscribe",
  "human",
  "agent",
  "support",
  "representative",
  "talk to human",
  "talk to a human",
  "real person",
]);
const START_WORDS = new Set(["start", "bot", "resume"]);

/**
 * Detect a handoff request. Matched on the WHOLE message, not a substring —
 * "can I stop my order" must not mute the bot.
 */
export function checkOptOut(text: string): "stop" | "start" | null {
  const t = String(text ?? "")
    .toLowerCase()
    .replace(/[.!?,]+$/g, "")
    .trim();
  if (STOP_WORDS.has(t)) return "stop";
  if (START_WORDS.has(t)) return "start";
  return null;
}

export const HANDOFF_REPLY =
  "Thanks — a member of our team will reply here shortly. Send \"start\" if you'd like the assistant back.";

/** Parse a stored turns column; never throws on corrupt JSON. */
export function loadTurns(raw: unknown): ChatTurn[] {
  try {
    return trimHistory(JSON.parse(String(raw ?? "[]")));
  } catch {
    return [];
  }
}

/** Append a turn pair and re-cap, so the column can never grow unbounded. */
export function appendTurns(existing: ChatTurn[], userText: string, modelText: string): string {
  const next = trimHistory([
    ...existing,
    { role: "user", text: userText },
    { role: "model", text: modelText },
  ]);
  return JSON.stringify(next);
}
