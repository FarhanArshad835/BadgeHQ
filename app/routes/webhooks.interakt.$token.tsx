/**
 * Interakt inbound webhook — POST /webhooks/interakt/:token
 *
 * The first NON-Shopify webhook in this app, so it cannot use
 * authenticate.webhook (that verifies Shopify's HMAC with the app secret).
 * Interakt signs with a per-merchant secret instead.
 *
 * Two hard constraints from Interakt shape everything here:
 *   1. Reply 200 within 3 SECONDS. Gemini takes up to 15s, so this route only
 *      records the message and a cron does the slow work.
 *   2. NO retries, and 5 failures in 10 minutes DISABLES the webhook silently.
 *
 * Hence the governing rule: return 200 for everything except a bad signature.
 * An unknown token, a disabled feature, an ignored event type, malformed JSON,
 * an internal crash — all log and return 200. A 404 or 500 here would spend one
 * of the five allowed failures and could take the integration down.
 *
 * The shop is identified ONLY by the token in the URL: Interakt's payload names
 * the customer's number but never which business number received it.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import {
  RATE_LIMIT_PER_HOUR,
  RATE_WINDOW_MS,
  checkOptOut,
  parseInboundMessage,
  verifyInteraktSignature,
} from "../utils/whatsapp-ai.server";
import { toIndianTenDigit } from "../utils/whatsapp.server";

/** 200 with no body — the "received, nothing to do" response. */
const ack = () => new Response(null, { status: 200 });

export const loader = async (_: LoaderFunctionArgs) =>
  new Response("Method not allowed", { status: 405 });

export const action = async ({ request, params }: ActionFunctionArgs) => {
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

  try {
    // MUST read the raw body before any JSON parse: the stream is single-use and
    // the HMAC is over these exact bytes. Re-serialising a parsed object would
    // not reproduce them.
    const raw = await request.text();

    const token = String(params.token || "");
    if (!token) return ack();

    const settings = await prisma.aiReplySettings.findFirst({
      where: { waWebhookToken: token },
    });
    // Unknown token: 200, not 404 — a 404 counts as a failure to Interakt.
    if (!settings) {
      console.warn("[interakt-webhook] unknown token");
      return ack();
    }

    // Verify before doing anything else with the payload. This is the ONLY
    // non-200 in the route.
    if (!verifyInteraktSignature(raw, request.headers.get("Interakt-Signature"), settings.waWebhookSecret)) {
      console.warn(`[interakt-webhook] bad signature for ${settings.shop}`);
      return new Response("Invalid signature", { status: 401 });
    }

    if (!settings.waReplyEnabled || !settings.isEnabled || !settings.apiKey) return ack();

    let payload: any = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      console.warn(`[interakt-webhook] non-JSON body for ${settings.shop}`);
      return ack();
    }

    // Returns null for every delivery-status echo of our own sends — this is the
    // loop guard as well as the filter.
    const inbound = parseInboundMessage(payload);
    if (!inbound) return ack();

    const shop = settings.shop;
    const phone = toIndianTenDigit(inbound.phone);
    if (!phone) {
      // Fail closed. Interakt sends are hard-coded to +91, so a foreign number
      // simply gets silence — log it distinctly or it's invisible.
      console.warn(`[interakt-webhook] non-indian-number ignored for ${shop}`);
      return ack();
    }

    const now = new Date();
    const convo = await prisma.whatsAppConversation.findUnique({
      where: { shop_phone: { shop, phone } },
    });

    // Handoff keywords. Handled inline (no AI, no job) so a shopper asking for a
    // person is never made to wait for the cron.
    const optOut = checkOptOut(inbound.text);
    if (optOut) {
      await prisma.whatsAppConversation.upsert({
        where: { shop_phone: { shop, phone } },
        create: { shop, phone, optedOut: optOut === "stop", lastInboundAt: now },
        update: { optedOut: optOut === "stop", lastInboundAt: now },
      });
      if (optOut === "stop") {
        // Acknowledge once, via a job so the send stays off this 3s path.
        await queueJob(shop, phone, "__handoff__", inbound.messageId);
      }
      return ack();
    }

    // Muted: a human is handling this thread in Interakt's inbox.
    if (convo?.optedOut) return ack();

    // Rate limit per shopper. Enforced HERE rather than in the cron so a flood
    // never even creates rows.
    const windowExpired = !convo || now.getTime() - convo.windowStart.getTime() > RATE_WINDOW_MS;
    const count = windowExpired ? 0 : convo.windowCount;
    if (count >= RATE_LIMIT_PER_HOUR) {
      console.warn(`[interakt-webhook] rate limited ${shop} ${phone.slice(-4)}`);
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

    await queueJob(shop, phone, inbound.text, inbound.messageId);
    return ack();
  } catch (e) {
    // Never surface a 500: it would count toward the 5-failure auto-disable.
    console.error("[interakt-webhook] failed", e);
    return ack();
  }
};

/**
 * Record the message for the cron. The unique (shop, providerMessageId) makes a
 * redelivered webhook a no-op — replying twice is worse than not replying.
 */
async function queueJob(shop: string, phone: string, message: string, providerMessageId: string) {
  try {
    await prisma.whatsAppReplyJob.create({
      data: { shop, phone, message, providerMessageId },
    });
  } catch (e: any) {
    if (e?.code === "P2002") return; // already queued — duplicate delivery
    throw e;
  }
}
