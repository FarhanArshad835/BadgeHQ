/**
 * The Instagram DM reply worker.
 *
 * The Instagram twin of whatsapp-reply.server.ts, sharing the same AI brain
 * (buildSystemPrompt + callAi), greeting/ack classifier, and menu — but with a
 * much simpler flow, because Instagram has none of the WhatsApp-only machinery:
 *
 *   - No live tracking. Instagram DMs don't carry the order-number/AWB that the
 *     merchant's WhatsApp flow bot posts, so a delivery question is answered
 *     with a redirect to WhatsApp instead of a courier lookup.
 *   - No DoubleTick thread fetch or Bot Studio flow assignment (those are
 *     WhatsApp-provider features). A handoff just mutes the bot.
 *   - Identity is the IGSID, not a phone — so it uses the SocialConversation /
 *     SocialReplyJob tables, keyed by (shop, channel, customerId).
 *
 * Same instant-reply design as WhatsApp: the webhook queues a job and drains it
 * in the same invocation via waitUntil, so a DM is answered in seconds.
 */
import { waitUntil } from "@vercel/functions";
import prisma from "../db.server";
import { buildSystemPrompt, callAi } from "./ai-replies.server";
import {
  cheapReplyKind,
  needsHumanNow,
  loadTurns,
  appendTurns,
} from "./whatsapp-ai.server";
import { MENU_REPLIES, matchMenuIntent } from "./whatsapp-menu.server";
import { sendInstagramDM } from "./instagram.server";

export const IG_MAX_ATTEMPTS = 3;
export const IG_STALE_REPLY_MS = 2 * 60 * 60 * 1000;
const IG_CHANNEL = "instagram";

/** How long an automatic handoff mute lasts — mirrors WhatsApp's 12h. */
const IG_HANDOFF_MUTE_HOURS = 12;

// Instagram can't look up live order status (no AWB in the DM), so delivery and
// refund chasing get a redirect to WhatsApp, where the bot CAN track. Kept as a
// canned reply — no LLM tokens, and it's the honest answer.
const IG_TRACK_REDIRECT =
  "For live order tracking, please message us on WhatsApp with your order number - " +
  "we can pull up your parcel's status there. Our team will also help you here shortly if you prefer.";

export type IgJobResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

/** Atomically claim one job — mirrors claimReplyJob. */
export async function claimSocialJob(id: string): Promise<boolean> {
  const claimed = await prisma.socialReplyJob.updateMany({
    where: { id, status: "pending" },
    data: { status: "claimed", attempts: { increment: 1 } },
  });
  return claimed.count === 1;
}

/** Run one claimed Instagram job to completion. Never throws. */
export async function processSocialJob(id: string): Promise<"sent" | "failed" | "gone"> {
  try {
    const job = await prisma.socialReplyJob.findUnique({ where: { id } });
    if (!job) return "gone";

    const result = await handleSocialJob(job);

    if (result.ok) {
      await prisma.socialReplyJob.update({ where: { id }, data: { status: "done", error: "" } });
      return "sent";
    }

    // Rate limit / quota → back to pending with the attempt refunded, same as
    // WhatsApp: it means we never got to try, not that the try failed.
    const throttled =
      result.error.endsWith(":rate-limited") || result.error.endsWith(":quota-exhausted");
    if (throttled) {
      await prisma.socialReplyJob.update({
        where: { id },
        data: { status: "pending", attempts: Math.max(0, job.attempts - 1), error: result.error.slice(0, 300) },
      });
      return "failed";
    }

    const giveUp = job.attempts >= IG_MAX_ATTEMPTS || result.permanent;
    await prisma.socialReplyJob.update({
      where: { id },
      data: { status: giveUp ? "failed" : "pending", error: result.error.slice(0, 300) },
    });
    return "failed";
  } catch (e) {
    console.error("[ig-reply] processSocialJob crashed", id, e);
    try {
      await prisma.socialReplyJob.updateMany({
        where: { id, status: "claimed" },
        data: { status: "pending", error: "worker-crashed" },
      });
    } catch {
      /* stale-claim recovery covers it */
    }
    return "failed";
  }
}

/** Claim + process as one unit; safe for waitUntil. */
export async function drainSocialJobNow(id: string): Promise<void> {
  if (await claimSocialJob(id)) {
    await processSocialJob(id);
  }
}

/** Fire the instant drain without delaying the webhook's response. */
export function drainSocialJobSoon(id: string): void {
  const work = drainSocialJobNow(id);
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/**
 * The Instagram decision flow. Ordering mirrors the WhatsApp worker's cheap
 * checks, minus everything Instagram can't do.
 */
async function handleSocialJob(job: {
  id: string;
  shop: string;
  channel: string;
  customerId: string;
  message: string;
  createdAt: Date;
}): Promise<IgJobResult> {
  const settings = await prisma.aiReplySettings.findUnique({ where: { shop: job.shop } });
  if (!settings?.igEnabled || !settings.isEnabled || !settings.apiKey) {
    return { ok: false, error: "feature-disabled", permanent: true };
  }
  if (!settings.igAccessToken) return { ok: false, error: "no-access-token", permanent: true };

  const send = (message: string) =>
    sendInstagramDM({
      pageId: settings.igPageId,
      accessToken: settings.igAccessToken,
      customerId: job.customerId,
      message: normalizeDashes(message),
    });

  const convo = await prisma.socialConversation.findUnique({
    where: {
      shop_channel_customerId: { shop: job.shop, channel: IG_CHANNEL, customerId: job.customerId },
    },
  });
  if (isMutedSocial(convo)) return { ok: false, error: "opted-out", permanent: true };

  // Too old to be worth sending.
  if (Date.now() - job.createdAt.getTime() > IG_STALE_REPLY_MS) {
    return { ok: false, error: "too-old", permanent: true };
  }

  // Daily ceiling (reuses the WhatsApp per-shop cap; 0 = unlimited). Counts
  // today's done Instagram jobs, IST day boundary like WhatsApp.
  if (settings.waDailyLimit > 0) {
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    nowIst.setUTCHours(0, 0, 0, 0);
    const since = new Date(nowIst.getTime() - IST_OFFSET_MS);
    const today = await prisma.socialReplyJob.count({
      where: { shop: job.shop, channel: IG_CHANNEL, status: "done", updatedAt: { gte: since } },
    });
    if (today >= settings.waDailyLimit) {
      return { ok: false, error: "daily-limit", permanent: true };
    }
  }

  // Greetings / acks / nudges without a model call.
  const cheap = cheapReplyKind(job.message);
  if (cheap === "ack") return { ok: true }; // silence closes a conversation
  if (cheap === "greeting") {
    const wa = await send(settings.greeting || "Hi! How can I help you today?");
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }
  if (cheap === "nudge") {
    // A nudge carries no issue to identify — ask what they need, stay live so
    // their reply reaches the AI. Don't hand off blind.
    const wa = await send("I'm here! Tell me what you need and I'll help you right away.");
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }

  // Canned menu answers the merchant already wrote (return policy, sizing, etc.)
  // — zero LLM tokens. "human" and "track" are handled specially below.
  const intent = matchMenuIntent(job.message);
  if (intent === "human") {
    // Identify the issue before escalating: ask what they need and let the AI
    // attempt it, rather than handing off the moment they tap "Talk to Us".
    const wa = await send(
      "I can help right here - tell me what you need (your order number and " +
        "what's wrong), and I'll sort it out. If you need a teammate, I'll bring one in.",
    );
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }
  if (intent === "track") {
    // No live tracking on Instagram — redirect to WhatsApp.
    const wa = await send(IG_TRACK_REDIRECT);
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }
  if (intent) {
    const wa = await send(MENU_REPLIES[intent]);
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }

  // Delivery / refund chasing. Instagram has no live tracking, but we still let
  // the AI attempt it (explain the process/timelines from the knowledge base)
  // rather than escalate blind — and tell it to point the customer to WhatsApp
  // for a specific live status it can't provide here.
  const looksLikeStatusChase = needsHumanNow(job.message, false);

  // Everything else: the AI, with the merchant's knowledge base. "whatsapp"
  // formatting (bare URLs, no markdown) suits Instagram DMs too.
  const history = loadTurns(convo?.turns);
  let system = buildSystemPrompt(settings, "whatsapp", job.message);
  if (looksLikeStatusChase) {
    system +=
      "\n\nNOTE: the customer is asking about a specific order/refund/pickup " +
      "status, and you have NO live tracking here. Do NOT pretend to check it. " +
      "Help from the knowledge base (explain the process and timelines) and, for " +
      "a specific live status, tell them to message on WhatsApp with their order " +
      "number. Only end with [HANDOFF] if they clearly need a human.";
  }
  const ai = await callAi({
    provider: settings.aiProvider,
    apiKey: settings.apiKey,
    model: settings.aiModel,
    system,
    history,
    message: job.message,
  });

  if (!ai.ok) {
    const permanent = ai.error === "bad-key" || ai.error === "bad-model";
    return { ok: false, error: `${settings.aiProvider}:${ai.error}`, permanent };
  }

  const handoff = ai.text.includes("[HANDOFF]");
  const replyText =
    ai.text.replace(/\s*\[HANDOFF\]\s*/g, " ").replace(/\s+$/g, "").trim() ||
    "Our team will take it from here and reply to you shortly.";

  const wa = await send(replyText);
  if (!wa.ok) {
    const permanent = wa.error === "outside-window" || wa.error === "bad-token";
    return { ok: false, error: `instagram:${wa.error}`, permanent };
  }

  await prisma.socialConversation.upsert({
    where: {
      shop_channel_customerId: { shop: job.shop, channel: IG_CHANNEL, customerId: job.customerId },
    },
    create: {
      shop: job.shop,
      channel: IG_CHANNEL,
      customerId: job.customerId,
      turns: appendTurns([], job.message, replyText),
      optedOut: handoff,
      mutedUntil: handoff ? new Date(Date.now() + IG_HANDOFF_MUTE_HOURS * 3600_000) : null,
    },
    update: {
      turns: appendTurns(history, job.message, replyText),
      ...(handoff
        ? { optedOut: true, mutedUntil: new Date(Date.now() + IG_HANDOFF_MUTE_HOURS * 3600_000) }
        : {}),
    },
  });
  return { ok: true };
}

/** True when the bot must stay silent for this customer right now. Mirrors isMuted. */
export function isMutedSocial(
  convo: { optedOut: boolean; mutedUntil?: Date | null } | null,
): boolean {
  if (!convo?.optedOut) return false;
  if (!convo.mutedUntil) return true; // permanent (explicit stop)
  return convo.mutedUntil.getTime() > Date.now();
}

/** Em/en dashes → plain hyphen, same as the WhatsApp path. */
function normalizeDashes(text: string): string {
  return String(text ?? "").replace(/\s*[—–]\s*/g, " - ");
}
