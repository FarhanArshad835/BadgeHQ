/**
 * Instagram inbound webhook — /webhooks/instagram/:token
 *
 * The Meta twin of webhooks.doubletick.$token.tsx. Two differences Meta forces:
 *
 *   1. GET verification challenge. When you subscribe this URL in the Meta app
 *      dashboard, Meta fires a GET with ?hub.mode=subscribe&hub.verify_token=…&
 *      hub.challenge=… — we echo hub.challenge back as plain text ONLY if the
 *      verify token matches the shop's stored one. (WhatsApp had no such step.)
 *   2. POST deliveries are signed with X-Hub-Signature-256 (HMAC of the raw
 *      body, keyed with the Meta app secret), which we verify — unlike
 *      DoubleTick, which signed nothing.
 *
 * The shop is identified ONLY by the unguessable token in the URL. Same 200-for-
 * everything discipline as the WhatsApp routes: Meta disables a webhook after
 * repeated non-2xx, and a non-200 would also leak that a token is valid.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  parseInstagramInbound,
  verifyInstagramSignature,
} from "../utils/instagram.server";
import { checkOptOut } from "../utils/whatsapp-ai.server";
import {
  drainSocialJobSoon,
  isMutedSocial,
} from "../utils/instagram-reply.server";
import { RATE_LIMIT_PER_HOUR, RATE_WINDOW_MS } from "../utils/whatsapp-ai.server";

// The instant drain keeps running after the 200 (waitUntil) and includes a
// ~15s LLM call plus the send — give it headroom.
export const config = { maxDuration: 120 };

const IG_CHANNEL = "instagram";
const ack = () => new Response(null, { status: 200 });

/**
 * GET = Meta's one-time verification challenge when the webhook is subscribed.
 * Echo hub.challenge (plain text) iff the verify token matches this shop's.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode !== "subscribe" || !challenge) {
    return new Response("Method not allowed", { status: 405 });
  }

  const settings = await prisma.aiReplySettings.findFirst({
    where: { igWebhookToken: String(params.token || "") },
  });
  if (!settings || !settings.igVerifyToken || settings.igVerifyToken !== token) {
    console.warn("[instagram-webhook] verification failed");
    return new Response("Forbidden", { status: 403 });
  }
  // Meta expects the raw challenge string back, 200, text/plain.
  return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const token = String(params.token || "");
    if (!token) return ack();

    const settings = await prisma.aiReplySettings.findFirst({
      where: { igWebhookToken: token },
    });
    if (!settings) {
      console.warn("[instagram-webhook] unknown token");
      return ack();
    }

    // Read the RAW body once — needed for the signature check, which must run on
    // the exact bytes Meta hashed (a re-serialised object won't match).
    const raw = await request.text();
    const sig = request.headers.get("X-Hub-Signature-256");
    if (!verifyInstagramSignature(raw, sig, settings.igAppSecret)) {
      console.warn(`[instagram-webhook] bad signature for ${settings.shop}`);
      // 200, not 401: a non-2xx trains Meta to disable the webhook, and a forged
      // request shouldn't be able to do that. We simply don't act on it.
      return ack();
    }

    if (!settings.igEnabled || !settings.isEnabled || !settings.apiKey) return ack();
    if (!settings.igAccessToken) return ack();

    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.warn(`[instagram-webhook] non-JSON body for ${settings.shop}`);
      return ack();
    }

    // Null for our own echoes and non-text messages — the loop guard + text-only
    // rule live in the parser.
    const inbound = parseInstagramInbound(payload);
    if (!inbound) return ack();

    const shop = settings.shop;
    const customerId = inbound.customerId;
    const now = new Date();

    const convo = await prisma.socialConversation.findUnique({
      where: { shop_channel_customerId: { shop, channel: IG_CHANNEL, customerId } },
    });

    // Handoff / resume keywords, handled inline.
    const optOut = checkOptOut(inbound.text);
    if (optOut) {
      await prisma.socialConversation.upsert({
        where: { shop_channel_customerId: { shop, channel: IG_CHANNEL, customerId } },
        // Explicit stop/start is permanent — mutedUntil stays null.
        create: {
          shop,
          channel: IG_CHANNEL,
          customerId,
          optedOut: optOut === "stop",
          mutedUntil: null,
          lastInboundAt: now,
        },
        update: { optedOut: optOut === "stop", mutedUntil: null, lastInboundAt: now },
      });
      return ack();
    }

    if (isMutedSocial(convo)) {
      await noteSkip(shop, customerId, "muted", inbound.text);
      return ack();
    }

    // Per-customer rate limit, so a flood never creates rows.
    const windowExpired = !convo || now.getTime() - convo.windowStart.getTime() > RATE_WINDOW_MS;
    const count = windowExpired ? 0 : convo.windowCount;
    if (count >= RATE_LIMIT_PER_HOUR) {
      await noteSkip(shop, customerId, "rate-limited", inbound.text);
      return ack();
    }

    await prisma.socialConversation.upsert({
      where: { shop_channel_customerId: { shop, channel: IG_CHANNEL, customerId } },
      create: { shop, channel: IG_CHANNEL, customerId, windowCount: 1, windowStart: now, lastInboundAt: now },
      update: {
        windowCount: windowExpired ? 1 : { increment: 1 },
        ...(windowExpired ? { windowStart: now } : {}),
        lastInboundAt: now,
      },
    });

    const jobId = await queueJob(shop, customerId, inbound.text, inbound.messageId);
    if (jobId) drainSocialJobSoon(jobId);
    return ack();
  } catch (e) {
    console.error("[instagram-webhook] failed", e);
    return ack();
  }
};

/** Record a message the bot chose not to answer. Never throws. */
async function noteSkip(shop: string, customerId: string, reason: string, preview: string) {
  try {
    await prisma.socialSkip.create({
      data: { shop, channel: IG_CHANNEL, customerId, reason, preview: preview.slice(0, 120) },
    });
  } catch {
    /* diagnostics only */
  }
}

/** Queue the job; a redelivered webhook (same message id) is a no-op → null. */
async function queueJob(
  shop: string,
  customerId: string,
  message: string,
  providerMessageId: string,
): Promise<string | null> {
  try {
    const job = await prisma.socialReplyJob.create({
      data: { shop, channel: IG_CHANNEL, customerId, message, providerMessageId },
    });
    return job.id;
  } catch (e: any) {
    if (e?.code === "P2002") return null; // duplicate delivery
    throw e;
  }
}
