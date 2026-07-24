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
 * How long an AUTOMATIC handoff mute lasts.
 *
 * When the bot escalates a complaint it mutes itself so a human can work the
 * thread without interruption. That mute used to be permanent, clearable only
 * by the shopper typing "start" — which no real shopper knows to do. So one
 * complaint silenced the bot for that number forever, including for unrelated
 * questions weeks later.
 *
 * 12 hours covers a working day: long enough that the team finishes the
 * conversation undisturbed, short enough that the next unrelated question gets
 * answered. An explicit "stop" from the shopper stays permanent.
 */
export const HANDOFF_MUTE_HOURS = 12;

/**
 * Messages that deserve a reply but not a model call.
 *
 * Measured on a real day's traffic: of 53 inbound messages, 21 were bare
 * greetings ("Hi", "Hlo", "Hii", "Okay thanks") or nudges ("Are u there",
 * "Reply please", "Merko urgent hai"). At ~2.3K tokens each those consumed
 * HALF the free daily quota and produced nothing a fixed string could not —
 * while genuine questions further down the queue got rate-limited into
 * silence.
 *
 * A greeting gets the merchant's configured greeting. A nudge means the bot
 * has already failed to answer, so it hands off rather than apologising again.
 */
// Conversation OPENERS — a menu in reply makes sense here.
const TRIVIAL_GREETING =
  /^(hi+|hey+|h[ie]l+o+|hii+|heyy+|hlo|namaste|good\s*(morning|evening|afternoon))[\s.!,👍🙏]*$/i;

// Acknowledgements — the conversation is ENDING, not starting. Observed live:
// a customer thanked the human agent handling her delivery and the bot replied
// with "Choose an option", re-opening a conversation that was closing. The
// right reply to thanks is nothing at all.
const ACK =
  /^(ok(ay)?(\s*thanks?)?|thanks?(\s*you)?(\s*so\s*much)?|thank\s*u|thanku|ty|tysm|k+|hmm+|yes|no|ji|acha|done|great|nice|perfect|cool|👍+|🙏+|❤+)[\s.!,👍🙏❤]*$/i;

const NUDGE =
  /^(are\s*u(you)?\s*there|reply\s*please|plz\s*rply|please\s*revert|call\s*me\s*pls|it'?s?\s*urgent|merko\s*urgent\s*hai|hello\?+|\?+|hlo\s*plz\s*rply)[\s.!?]*$/i;

export type CheapReply = "greeting" | "nudge" | "ack" | null;

/** Classify a message that can be answered without spending LLM tokens. */
export function cheapReplyKind(text: string): CheapReply {
  // Skin-tone modifiers and variation selectors break emoji matching — a
  // shopper's 👍🏻 is 👍 followed by U+1F3FB, which the character class never
  // sees as a plain 👍. Strip them before classifying.
  const t = String(text || "")
    .replace(/[\u{1F3FB}-\u{1F3FF}\u{FE0F}]/gu, "")
    .trim();
  if (!t || t.length > 40) return null; // anything longer carries real content
  if (ACK.test(t)) return "ack";
  if (TRIVIAL_GREETING.test(t)) return "greeting";
  if (NUDGE.test(t)) return "nudge";
  return null;
}

/**
 * Questions the bot CANNOT answer, matched in code rather than left to the
 * prompt.
 *
 * The prompt already tells the model to escalate delivery and refund problems
 * immediately, and it does not reliably obey: in one live thread a customer
 * asked "Where is my order", then "Where is my parcel", then "When it will
 * deliver", then "When??" — and the bot's reply was to ask for an order number
 * that the thread never contained. Four chances to hand off, taken none.
 *
 * These need live order status, tracking events or courier data, none of which
 * the bot can see. Answering is impossible; the only useful response is a fast
 * handoff, so the decision is made here where it cannot be talked out of.
 *
 * Deliberately narrow — matching a general question would silence the bot for
 * things it answers well. Only where/when-is-my-order phrasings and explicit
 * refund chasing.
 */
const ESCALATE_DELIVERY = [
  /\bwhere\s+(is|are)\s+(my|the)\s+(order|parcel|package|shipment|delivery|item)/i,
  /\bwhen\s+(will|is|it)\s*(it|my|the)?\s*(be\s+)?(deliver|arriv|com|reach|ship)/i,
  /\b(order|parcel|package|delivery)\s+(not|hasn'?t|haven'?t|didn'?t)\s+(received|arrived|delivered|come)/i,
  /\bnot\s+(yet\s+)?(received|delivered|arrived)\b/i,
  /\b(kab|kaha)\s+(tak|hai|aayega|milega)/i,
];

// Refund chases - the bot has no way to see refund status (no API for it), so
// these ALWAYS need a human, whether tracking is on or not.
const ESCALATE_REFUND = [
  /\brefund\s+(status|kab|not|hasn'?t|pending)/i,
  /\bwhere.{0,12}\brefund\b/i,
];

/**
 * True when a message needs a human because live order data is required.
 * Checked BEFORE the LLM call, so it costs no tokens and cannot be ignored.
 */
export function needsHumanNow(text: string, trackingEnabled = false): boolean {
  const t = String(text || "").trim();
  if (t.length > 300) return false; // long messages are usually narrative, not a status chase
  // Refund chases always need a human - there is no refund lookup.
  if (ESCALATE_REFUND.some((re) => re.test(t))) return true;
  // Delivery chases go to the AI + tracking path when tracking is on (the bot
  // can look the parcel up); only escalate them here when tracking is off.
  if (!trackingEnabled && ESCALATE_DELIVERY.some((re) => re.test(t))) return true;
  return false;
}

/**
 * Matches an order number or AWB wherever it appears — confirmation templates
 * ("Order Number: #205946", "#" optional but common), AWB references, bare
 * long digit runs, and Shopify order URLs. Used both to keep order-bearing
 * messages in the thread transcript and to catch the model asking for an
 * order reference the transcript already contains.
 */
export const ORDER_REF_RE =
  /(?:order\s*(?:number|no\.?|id)?\s*[:#\s]*#?\s*\d{5,}|awb\s*[:#]?\s*\d{8,}|\d{9,})/i;

/** True when the bot must stay silent for this conversation right now. */
export function isMuted(convo: { optedOut: boolean; mutedUntil?: Date | null } | null): boolean {
  if (!convo?.optedOut) return false;
  // null = permanent (explicit opt-out); a date = automatic, expires.
  if (!convo.mutedUntil) return true;
  return convo.mutedUntil.getTime() > Date.now();
}

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

  // Real deliveries carry NO status field at all — the docs' example shows
  // "status":"received" but three captured live payloads all lacked it, which
  // made a strict equality check reject every genuine message while synthetic
  // doc-shaped tests passed. MESSAGE_RECEIVED is customer-inbound by
  // definition (we subscribe to no other event), so absence is fine; only an
  // explicit non-"received" value — some status echo — is rejected.
  const status = payload.status;
  if (status != null && String(status).toLowerCase() !== "received") return null;

  const msg = payload.message;
  if (!msg) return null;

  // TEXT plus tap replies. A tapped quick-reply or list row arrives as
  // BUTTON / LIST_REPLY with the row's id in `id` (and its label in `text`) —
  // captured live 2026-07-22: {"type":"BUTTON","text":"Return/Exchange",
  // "payload":"Return/Exchange","id":"Return/Exchange"}. The id is what the
  // menu router matches on, so it wins over the label. Media types still
  // return null: silence cannot loop.
  const kind = String(msg.type ?? "").toUpperCase();
  let raw: unknown;
  if (kind === "TEXT") raw = msg.text;
  else if (kind === "BUTTON" || kind === "LIST_REPLY" || kind === "INTERACTIVE") {
    raw = msg.id ?? msg.payload ?? msg.title ?? msg.text;
  } else return null;

  const text = String(raw ?? "").trim().slice(0, MAX_MESSAGE_CHARS);
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
/** One agent from the DoubleTick team roster (GET /team). */
export type DoubleTickAgent = { name: string; phone: string; status: string };

/**
 * List the merchant's DoubleTick team members so the admin can pick which agent
 * receives handoff alerts. GET /team is the only agent endpoint that works —
 * DoubleTick has no API to assign a chat to an agent (probed ~50 paths, all
 * 404), so "pick an agent to ping" is the closest thing to routing it allows.
 * Read-only, best-effort: on any failure returns [] and the admin falls back to
 * typing a number by hand.
 */
export async function fetchDoubleTickTeam(apiKey: string): Promise<DoubleTickAgent[]> {
  if (!apiKey) return [];
  try {
    const res = await fetch("https://public.doubletick.io/team", {
      headers: { Authorization: apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const body = await res.json().catch(() => null);
    const rows: any[] = Array.isArray(body?.data) ? body.data : [];
    return rows
      .map((r) => ({
        name: String(r?.name || "").trim().replace(/\s+/g, " "),
        phone: String(r?.phone || "").replace(/\D/g, ""),
        status: String(r?.status || ""),
      }))
      .filter((a) => a.phone);
  } catch {
    return [];
  }
}

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

/**
 * Defaults for the fetched thread. Each is overridable per shop from the admin
 * — these are the dominant input cost after the knowledge base, and the right
 * value differs by shop: long troubleshooting threads need more history than
 * quick sizing questions, and merchants are on different LLM plans.
 *
 * Set for comprehension first. A single agent message in a dispute runs past
 * 160 chars on its own, so a tight per-line cap turns history into fragments
 * and the bot starts asking what the customer already answered.
 */
const THREAD_DEFAULT_RECENT = 20;
const THREAD_DEFAULT_OPENING = 4;
const THREAD_DEFAULT_LINE_CHARS = 400;
const THREAD_DEFAULT_TOTAL_CHARS = 4000;

/**
 * Fetch the customer's REAL WhatsApp thread from DoubleTick and format it as a
 * labelled transcript for the LLM — including human agent replies, the
 * button-menu bot, templates, everything. The bot's own stored turns miss all
 * of that, and a support thread's meaning usually lives in what the human
 * agent already said (see: a missing-item dispute where the agent had already
 * refused a refund the bot knew nothing about).
 *
 * Labels distinguish who spoke: API-sent messages carry "(Public API)" in
 * senderUser.name, manual inbox replies don't — so "Store team (human)" vs
 * "Store assistant". The LLM is told not to contradict the human.
 *
 * Bounded hard (newest ~30 messages, ~5k chars) because this is prompt input
 * on every reply. GET /chat-messages is free; the cost is merchant LLM tokens.
 * Returns null on any failure — callers fall back to the bot's own history.
 */
export async function fetchDoubleTickThread(opts: {
  apiKey: string;
  wabaNumber: string;
  /** International, digits only, e.g. "919354991605". */
  customerNumber: string;
  /** dtMessageId of the message being answered — excluded, it's sent as the user turn. */
  excludeMessageId?: string;
  /** Newest messages to include. */
  recent?: number;
  /** Messages from the START of the thread — a long thread's opening usually
   *  holds the order number and the original problem, which the newest
   *  messages no longer mention. 0 disables. */
  opening?: number;
  maxLineChars?: number;
  maxTotalChars?: number;
}): Promise<{ transcript: string; humanActiveAt: number | null } | null> {
  const waba = opts.wabaNumber.replace(/\D/g, "");
  const cust = opts.customerNumber.replace(/\D/g, "");
  if (!opts.apiKey || !waba || !cust) return null;

  // DD-MM-YYYY, last 3 days — bounds a chatty thread without losing the
  // context that matters. Omitting dates returns the ENTIRE history.
  const fmt = (d: Date) =>
    `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`;
  const now = Date.now();
  // 30 days, not 3. The order-confirmation and shipping templates carry the
  // order number and AWB, and they are sent when the order is PLACED — often
  // a week or more before the customer asks where it is. With a 3-day window
  // a shopper asking "when will it deliver" produced a bot that could not see
  // their order number anywhere and asked for it, while the confirmation sat
  // just outside the window. Fetching is free (DoubleTick charges nothing for
  // reads); only what we forward to the model costs tokens, and that is
  // capped separately below.
  const qs = new URLSearchParams({
    wabaNumber: waba,
    customerNumber: cust,
    startDate: fmt(new Date(now - 30 * 86400_000)),
    endDate: fmt(new Date(now + 86400_000)),
  });

  try {
    const res = await fetch(`https://public.doubletick.io/chat-messages?${qs}`, {
      headers: { Authorization: opts.apiKey, Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.error("[dt-thread] fetch failed", res.status);
      return null;
    }
    const data: any = await res.json();
    const msgs: any[] = Array.isArray(data?.messages) ? data.messages : [];
    if (!msgs.length) return null;

    const recent = Math.max(1, opts.recent ?? THREAD_DEFAULT_RECENT);
    const opening = Math.max(0, opts.opening ?? THREAD_DEFAULT_OPENING);
    const lineChars = Math.max(40, opts.maxLineChars ?? THREAD_DEFAULT_LINE_CHARS);
    const totalChars = Math.max(200, opts.maxTotalChars ?? THREAD_DEFAULT_TOTAL_CHARS);

    // Order is not guaranteed.
    msgs.sort((a, b) => (a?.messageTime ?? 0) - (b?.messageTime ?? 0));

    // Take the opening AND the newest messages. On a 60-message thread the
    // newest 20 alone lose the order number and the original problem, which is
    // exactly the context a late question depends on. `gapAfter` marks where
    // the middle was dropped so the model does not read it as continuous.
    let selected: any[];
    let gapAfter = -1;
    if (opening > 0 && msgs.length > recent + opening) {
      selected = msgs.slice(0, opening).concat(msgs.slice(-recent));
      gapAfter = opening - 1;
    } else {
      selected = msgs.slice(-recent);
    }

    // Order confirmations and shipping notices are the highest-value messages
    // in a support thread — they carry the order number and AWB — but they are
    // sent when the order is PLACED, so in a long thread they sit in the middle
    // that the opening+recent window drops. Observed live: a customer asked
    // where their order was, the confirmation was ten days back, and the bot
    // asked for an order number the thread did contain.
    //
    // Pull any message carrying an order number or AWB back in, newest first,
    // and place them with the opening block so they read as background.
    const ORDER_REF = ORDER_REF_RE;
    const chosen = new Set(selected);
    const orderRefs: any[] = [];
    for (let i = msgs.length - 1; i >= 0 && orderRefs.length < 3; i--) {
      const m = msgs[i];
      if (chosen.has(m)) continue;
      const mm = m?.message ?? {};
      let body = String(mm.text ?? "");
      if (!body) {
        try {
          body = String(mm.templateMessage.body.data[0].text ?? "");
        } catch {
          body = "";
        }
      }
      if (body && ORDER_REF.test(body)) orderRefs.push(m);
    }
    if (orderRefs.length) {
      orderRefs.reverse();
      const head = gapAfter >= 0 ? selected.slice(0, gapAfter + 1) : [];
      const tail = gapAfter >= 0 ? selected.slice(gapAfter + 1) : selected;
      selected = head.concat(orderRefs, tail);
      gapAfter = head.length + orderRefs.length - 1;
    }

    const lines: string[] = [];
    for (let idx = 0; idx < selected.length; idx++) {
      const m = selected[idx];
      if (opts.excludeMessageId && m?.id === opts.excludeMessageId) continue;

      const mm = m?.message ?? {};
      const type = String(mm.messageType ?? mm.type ?? "").toLowerCase();
      let text = "";
      if (type === "text") text = String(mm.text ?? "");
      else if (type === "button") text = `[tapped button: ${String(mm.text ?? "")}]`;
      else if (type === "template") {
        try {
          text = String(mm.templateMessage.body.data[0].text ?? "");
        } catch {
          text = "[template message]";
        }
      } else if (type) text = `[${type}]`;
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;

      const senderName = String(m?.senderUser?.name ?? "").trim();
      const label =
        m?.messageOriginType === "CUSTOMER"
          ? "Customer"
          : senderName && !senderName.includes("(Public API)")
          ? "Store team (human)"
          : "Store assistant";

      lines.push(`${label}: ${text.slice(0, lineChars)}`);
      if (idx === gapAfter) lines.push("[... earlier messages omitted ...]");
    }
    if (!lines.length) return null;

    // Enforce the budget from the END so the newest context always survives,
    // but reserve room for the opening lines first — they were selected
    // precisely because the recent messages cannot replace them.
    const openingLines = gapAfter >= 0 ? lines.slice(0, gapAfter + 2) : [];
    const openingCost = openingLines.reduce((n, l) => n + l.length + 1, 0);
    const budget = Math.max(200, totalChars - openingCost);

    let total = 0;
    const kept: string[] = [];
    for (let i = lines.length - 1; i >= openingLines.length; i--) {
      total += lines[i].length + 1;
      if (total > budget) break;
      kept.unshift(lines[i]);
    }

    // When a PERSON last wrote in this thread — scanned over the full message
    // set, not just the selected transcript, because the guard that uses this
    // ("stand down while an agent is working the thread") must see a human
    // reply even if selection dropped it. API sends carry "(Public API)" in
    // the sender name; manual inbox replies do not.
    let humanActiveAt: number | null = null;
    for (const m of msgs) {
      if (m?.messageOriginType !== "CUSTOMER") {
        const name = String(m?.senderUser?.name ?? "").trim();
        if (name && !name.includes("(Public API)")) {
          const ts = Number(m?.messageTime ?? 0);
          if (ts > (humanActiveAt ?? 0)) humanActiveAt = ts;
        }
      }
    }

    return { transcript: openingLines.concat(kept).join("\n"), humanActiveAt };
  } catch (e: any) {
    console.error("[dt-thread] threw", String(e?.message || e).slice(0, 150));
    return null;
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
