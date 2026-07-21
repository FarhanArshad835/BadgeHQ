/**
 * DoubleTick inbound webhook — POST /webhooks/doubletick/:token
 *
 * The DoubleTick twin of webhooks.interakt.$token.tsx. Same job, same 3-second
 * budget (Gemini takes up to 15s, so this route only records the message and the
 * cron does the slow work), but two things differ:
 *
 *   1. DoubleTick signs nothing, and despite documenting an `authorization`
 *      option it discards it — deliveries carry no Authorization header at all.
 *      So the unguessable URL token is the only credential, and there is no raw
 *      body to read for an HMAC.
 *   2. Its payload is flat and marks direction with `status: "received"` rather
 *      than an event type.
 *
 * The Interakt route returns 200 for everything because Interakt disables a
 * webhook after 5 failures in 10 minutes. DoubleTick publishes no such rule, but
 * the same shape is kept deliberately: a 500 here would leak that the token is
 * valid, and silence is the right response to traffic we can't act on anyway.
 *
 * The shop is identified ONLY by the token in the URL — the payload's `to` names
 * the business number, but merchants can move numbers between accounts.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  RATE_LIMIT_PER_HOUR,
  RATE_WINDOW_MS,
  checkOptOut,
  isMuted,
  parseDoubleTickInbound,
  verifyDoubleTickAuth,
} from "../utils/whatsapp-ai.server";
import { toIndianTenDigit } from "../utils/whatsapp.server";
import { drainJobSoon } from "../utils/whatsapp-reply.server";

// The instant drain keeps running AFTER the 200 goes back (waitUntil), and it
// includes an LLM call of up to 15s plus the send — give it headroom.
export const config = { maxDuration: 60 };

const ack = () => new Response(null, { status: 200 });

export const loader = async (_: LoaderFunctionArgs) =>
  new Response("Method not allowed", { status: 405 });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    const token = String(params.token || "");
    if (!token) return ack();

    const settings = await prisma.aiReplySettings.findFirst({
      where: { waWebhookToken: token },
    });
    if (!settings) {
      console.warn("[doubletick-webhook] unknown token");
      return ack();
    }

    // Authentication is the URL token alone: findFirst above already proved a
    // 24-byte random path segment matched this shop.
    //
    // DoubleTick's register API accepts an `authorization: {type:"BEARER"}`
    // block and then silently DISCARDS it — the stored webhook record has no
    // such field, and deliveries arrive with no Authorization header. Verified
    // against a live account. So requiring a bearer token 401'd every genuine
    // message. When they send one we check it, but its absence can't be fatal.
    //
    // This makes the URL the sole secret. It is never displayed for DoubleTick
    // and travels only over TLS, but it does mean anyone who obtains it could
    // feed us messages — which is why parseDoubleTickInbound stays strict and
    // the per-shopper rate limit is enforced below.
    const authHeader = request.headers.get("Authorization");
    if (authHeader && settings.waWebhookAuth) {
      if (!verifyDoubleTickAuth(authHeader, settings.waWebhookAuth)) {
        console.warn(`[doubletick-webhook] bad auth for ${settings.shop}`);
        return new Response("Invalid authorization", { status: 401 });
      }
    }

    // Guard against a shop that switched providers but left this URL registered
    // in DoubleTick — otherwise we'd reply using Interakt credentials.
    if (settings.waProvider !== "doubletick") return ack();
    if (!settings.waReplyEnabled || !settings.isEnabled || !settings.apiKey) return ack();

    let payload: any = null;
    try {
      payload = await request.json();
    } catch {
      console.warn(`[doubletick-webhook] non-JSON body for ${settings.shop}`);
      return ack();
    }

    // Null for every status echo of our own sends — the loop guard.
    const inbound = parseDoubleTickInbound(payload);
    if (!inbound) return ack();

    const shop = settings.shop;
    const phone = toIndianTenDigit(inbound.phone);
    if (!phone) {
      // Fail closed: sends are hard-coded to +91, so a foreign number gets
      // silence. Log it distinctly or it's invisible.
      console.warn(`[doubletick-webhook] non-indian-number ignored for ${shop}`);
      return ack();
    }

    const now = new Date();
    const convo = await prisma.whatsAppConversation.findUnique({
      where: { shop_phone: { shop, phone } },
    });

    // Handoff keywords, handled inline so a shopper asking for a person never
    // waits on the cron.
    const optOut = checkOptOut(inbound.text);
    if (optOut) {
      await prisma.whatsAppConversation.upsert({
        where: { shop_phone: { shop, phone } },
        // An explicit stop/start is PERMANENT — mutedUntil stays null, which is
        // what distinguishes it from the bot muting itself after a handoff.
        create: { shop, phone, optedOut: optOut === "stop", mutedUntil: null, lastInboundAt: now },
        update: { optedOut: optOut === "stop", mutedUntil: null, lastInboundAt: now },
      });
      if (optOut === "stop") {
        const jobId = await queueJob(shop, phone, "__handoff__", inbound.messageId);
        if (jobId) drainJobSoon(jobId);
      }
      return ack();
    }

    // Muted: a human has this thread in DoubleTick's inbox.
    if (isMuted(convo)) return ack();

    // Rate limit per shopper, enforced here so a flood never creates rows.
    const windowExpired = !convo || now.getTime() - convo.windowStart.getTime() > RATE_WINDOW_MS;
    const count = windowExpired ? 0 : convo.windowCount;
    if (count >= RATE_LIMIT_PER_HOUR) {
      console.warn(`[doubletick-webhook] rate limited ${shop} ${phone.slice(-4)}`);
      return ack();
    }

    await prisma.whatsAppConversation.upsert({
      where: { shop_phone: { shop, phone } },
      create: { shop, phone, windowCount: 1, windowStart: now, lastInboundAt: now },
      update: {
        windowCount: windowExpired ? 1 : { increment: 1 },
        ...(windowExpired ? { windowStart: now } : {}),
        lastInboundAt: now,
      },
    });

    const jobId = await queueJob(shop, phone, inbound.text, inbound.messageId);
    // Reply NOW, in this same invocation, after the 200 below goes out — the
    // cron sweep only handles what this drops. Null = duplicate delivery,
    // already queued (and probably already answered): nothing to do.
    if (jobId) drainJobSoon(jobId);
    return ack();
  } catch (e) {
    console.error("[doubletick-webhook] failed", e);
    return ack();
  }
};

/**
 * Record the message and return the job id for the instant drain. The unique
 * (shop, providerMessageId) makes a redelivered webhook a no-op — replying
 * twice is worse than not replying — and that case returns null.
 */
async function queueJob(
  shop: string,
  phone: string,
  message: string,
  providerMessageId: string,
): Promise<string | null> {
  try {
    const job = await prisma.whatsAppReplyJob.create({
      data: { shop, phone, message, providerMessageId },
    });
    return job.id;
  } catch (e: any) {
    if (e?.code === "P2002") return null; // already queued — duplicate delivery
    throw e;
  }
}
