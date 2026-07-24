/**
 * Instagram DM transport for the AI reply bot (Meta Graph API, direct).
 *
 * The Instagram twin of whatsapp.server.ts + the DoubleTick webhook parse. The
 * AI brain (ai-replies.server.ts), the knowledge base, and the menu are shared;
 * only how a message arrives and how a reply is sent differs.
 *
 * Meta specifics handled here:
 *   - Inbound webhooks are signed with X-Hub-Signature-256 (HMAC-SHA256 of the
 *     RAW body, keyed with the app secret) — verified before we act.
 *   - The GET verification challenge Meta fires once when you subscribe the
 *     webhook: echo hub.challenge if hub.verify_token matches.
 *   - Replies go to POST /v21.0/me/messages with the Page access token; the
 *     recipient is the Instagram-scoped user id (IGSID), not a phone.
 *   - The 24-hour standard messaging window applies (like WhatsApp): a plain
 *     text reply is only allowed within 24h of the user's last message.
 */
import crypto from "node:crypto";

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;
const TIMEOUT_MS = 15000;
/** Instagram DM hard cap is 1000 chars; stay under it. */
const MAX_DM_CHARS = 1000;

export type InstagramInbound = {
  /** IGSID — the sender's Instagram-scoped user id. Our customer key. */
  customerId: string;
  text: string;
  /** Meta's message id (mid.…) — the idempotency key. */
  messageId: string;
};

export type SendResult = { ok: true } | { ok: false; error: string };

/**
 * Verify Meta's X-Hub-Signature-256 header against the RAW request body.
 * Header form: "sha256=" + hex HMAC-SHA256(body, appSecret). Fail closed — a
 * missing secret or header means we can't tell real traffic from forged, and
 * this endpoint spends the merchant's LLM quota and sends DMs as them.
 */
export function verifyInstagramSignature(
  rawBody: string,
  header: string | null | undefined,
  appSecret: string,
): boolean {
  if (!appSecret || !header) return false;
  const received = String(header).trim().replace(/^sha256=/i, "");
  if (!/^[0-9a-f]+$/i.test(received)) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(received.toLowerCase(), "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Parse the Instagram messaging webhook into the one inbound DM we care about.
 * Returns null for anything we must NOT reply to — our own echoes, non-text
 * messages (images, reactions, story replies), reads, deletes — so the loop
 * guard and the "text only" rule both live here.
 *
 * Meta's shape: { object:"instagram", entry:[{ messaging:[{ sender:{id}, recipient:{id}, message:{ mid, text, is_echo? } }] }] }
 * `is_echo: true` marks a message WE sent (Meta echoes them back) — the key
 * loop guard, same role as DoubleTick's status echoes.
 */
export function parseInstagramInbound(payload: any): InstagramInbound | null {
  if (!payload || payload.object !== "instagram") return null;
  const entry = Array.isArray(payload.entry) ? payload.entry[0] : null;
  const messaging = entry && Array.isArray(entry.messaging) ? entry.messaging[0] : null;
  const message = messaging?.message;
  if (!message) return null;

  // Our own send, echoed back — never reply to it (infinite loop otherwise).
  if (message.is_echo) return null;

  const customerId = String(messaging?.sender?.id || "").trim();
  const messageId = String(message.mid || "").trim();
  const text = typeof message.text === "string" ? message.text.trim() : "";

  // Text only. Images, reactions, story mentions, unsends carry no `text` — we
  // can't answer them, so they're skipped (the route logs a "not-text" skip).
  if (!customerId || !messageId || !text) return null;

  return { customerId, text, messageId };
}

/**
 * Send an Instagram DM via the Graph API. Recipient is the IGSID. Uses the
 * Page access token. Errors are mapped to the same rough taxonomy the admin
 * Test surface uses, so a merchant sees a real cause, not a raw Meta blob.
 */
export async function sendInstagramDM(opts: {
  pageId: string;
  accessToken: string;
  customerId: string;
  message: string;
}): Promise<SendResult> {
  if (!opts.accessToken) return { ok: false, error: "no-access-token" };
  if (!opts.customerId) return { ok: false, error: "no-recipient" };
  const message = String(opts.message ?? "").trim().slice(0, MAX_DM_CHARS);
  if (!message) return { ok: false, error: "empty-message" };

  // /me/messages resolves to the Page/IG account the token belongs to, so the
  // pageId isn't in the path — it's kept in settings to identify the account
  // and for future multi-page support.
  const url = `${GRAPH_BASE}/me/messages?access_token=${encodeURIComponent(opts.accessToken)}`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: opts.customerId },
        message: { text: message },
        // "RESPONSE" = replying inside the 24h window. Outside it Meta rejects
        // the send (code 10 / error subcode 2534022); we surface that as
        // "outside-window" so the worker treats it as permanent, not a retry.
        messaging_type: "RESPONSE",
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      // Log server-side only — the body can echo the token back.
      console.error("[instagram] send", res.status, detail.slice(0, 300));
      const outsideWindow =
        /outside.*allowed window|2534022|message sent outside/i.test(detail);
      const badToken =
        res.status === 401 ||
        /access token|OAuthException|code":?\s*190/i.test(detail);
      const error = outsideWindow
        ? "outside-window"
        : badToken
        ? "bad-token"
        : res.status === 429
        ? "rate-limited"
        : "upstream";
      return { ok: false, error };
    }
    return { ok: true };
  } catch (e: any) {
    console.error("[instagram] send threw:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}
