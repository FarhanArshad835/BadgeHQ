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
