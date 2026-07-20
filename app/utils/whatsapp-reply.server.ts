/**
 * The WhatsApp reply worker — shared by the webhook routes and the cron.
 *
 * Two callers, one code path:
 *   - The webhook drains its own just-queued job via waitUntil() so the shopper
 *     gets an answer in seconds instead of waiting for the next cron tick.
 *   - The cron sweeps anything the instant path missed (crashed invocation,
 *     rate-limited retry, stale claim), so worst case degrades to the old
 *     ~75s behaviour, never worse.
 *
 * Both go through the same atomic pending -> claimed gate, so an overlapping
 * cron tick and webhook drain can never double-message a shopper: whoever
 * updates the row first wins, the loser matches zero rows and stops.
 */
import { waitUntil } from "@vercel/functions";
import prisma from "../db.server";
import { buildSystemPrompt, callAi } from "./ai-replies.server";
import { sendWhatsAppText } from "./whatsapp.server";
import {
  HANDOFF_REPLY,
  appendTurns,
  fetchDoubleTickThread,
  loadTurns,
} from "./whatsapp-ai.server";

export const MAX_ATTEMPTS = 3;

export type JobResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

/**
 * Atomically claim one job. True means the caller now owns it and must call
 * processReplyJob; false means another worker (cron tick or a duplicate
 * delivery's drain) got there first — stop, don't double-reply.
 */
export async function claimReplyJob(id: string): Promise<boolean> {
  const claimed = await prisma.whatsAppReplyJob.updateMany({
    where: { id, status: "pending" },
    data: { status: "claimed", attempts: { increment: 1 } },
  });
  return claimed.count === 1;
}

/**
 * Run one CLAIMED job to completion and persist the outcome. Never throws —
 * this runs inside waitUntil() where an exception would vanish silently, so
 * every failure is written to the job row instead.
 *
 * Returns what happened so the cron can keep its sent/failed counters.
 */
export async function processReplyJob(id: string): Promise<"sent" | "failed" | "gone"> {
  try {
    const job = await prisma.whatsAppReplyJob.findUnique({ where: { id } });
    if (!job) return "gone";

    const result = await handleJob(job);

    if (result.ok) {
      await prisma.whatsAppReplyJob.update({
        where: { id },
        data: { status: "done", error: "" },
      });
      return "sent";
    }

    const giveUp = job.attempts >= MAX_ATTEMPTS || result.permanent;
    await prisma.whatsAppReplyJob.update({
      where: { id },
      data: {
        status: giveUp ? "failed" : "pending",
        error: result.error.slice(0, 300),
      },
    });
    return "failed";
  } catch (e) {
    console.error("[wa-reply] processReplyJob crashed", id, e);
    // Put the job back for the cron sweep rather than stranding it "claimed"
    // for the 5-minute stale window.
    try {
      await prisma.whatsAppReplyJob.updateMany({
        where: { id, status: "claimed" },
        data: { status: "pending", error: "worker-crashed" },
      });
    } catch {
      /* the stale-claim recovery will still pick it up */
    }
    return "failed";
  }
}

/**
 * The webhook's instant path: claim + process, as one fire-and-forget unit.
 * Total by construction — safe to hand straight to waitUntil().
 */
export async function drainJobNow(id: string): Promise<void> {
  if (await claimReplyJob(id)) {
    await processReplyJob(id);
  }
}

/**
 * Fire the instant drain WITHOUT delaying the webhook's response.
 *
 * waitUntil() tells Vercel to keep this invocation alive after the 200 goes
 * back to the provider — same function, so it costs zero extra invocations;
 * the LLM call that used to run in the cron simply runs here, a minute
 * earlier. Outside a Vercel request context (local dev, tests) waitUntil
 * throws, so fall back to letting the promise float — drainJobNow never
 * rejects, and the cron sweep still covers a process that exits too soon.
 */
export function drainJobSoon(id: string): void {
  const work = drainJobNow(id);
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

async function handleJob(job: {
  id: string;
  shop: string;
  phone: string;
  message: string;
  providerMessageId: string;
}): Promise<JobResult> {
  const settings = await prisma.aiReplySettings.findUnique({ where: { shop: job.shop } });
  if (!settings?.waReplyEnabled || !settings.isEnabled || !settings.apiKey) {
    // Merchant switched it off between queueing and now — drop, don't retry.
    return { ok: false, error: "feature-disabled", permanent: true };
  }
  if (!settings.waApiKey) {
    return { ok: false, error: "no-wa-key", permanent: true };
  }
  // DoubleTick refuses a send without a sender number; no amount of retrying
  // supplies one.
  if (settings.waProvider === "doubletick" && !settings.waFromNumber) {
    return { ok: false, error: "no-sender-number", permanent: true };
  }

  const send = (message: string, callbackData: string) =>
    sendWhatsAppText({
      provider: settings.waProvider,
      apiKey: settings.waApiKey,
      fromNumber: settings.waFromNumber,
      phone: job.phone,
      message,
      callbackData,
    });

  // The handoff acknowledgement is a fixed string — no AI, no quota spent.
  if (job.message === "__handoff__") {
    const wa = await send(HANDOFF_REPLY, "badgehq-ai-handoff");
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }

  const convo = await prisma.whatsAppConversation.findUnique({
    where: { shop_phone: { shop: job.shop, phone: job.phone } },
  });
  // Muted after the job was queued — a human has the thread now.
  if (convo?.optedOut) return { ok: false, error: "opted-out", permanent: true };

  // Daily ceiling, checked BEFORE the LLM call — the whole point is to not
  // spend the token that would break the budget. Free tiers cap tokens per
  // day, and one exhausted quota silences the bot for every customer until
  // UTC midnight, so refusing one reply is much cheaper than refusing all of
  // tomorrow morning's.
  if (settings.waDailyLimit > 0) {
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    const today = await prisma.whatsAppReplyJob.count({
      where: { shop: job.shop, status: "done", updatedAt: { gte: since } },
    });
    if (today >= settings.waDailyLimit) {
      console.warn(`[wa-reply] daily limit ${settings.waDailyLimit} reached for ${job.shop}`);
      return { ok: false, error: "daily-limit", permanent: true };
    }
  }

  // "whatsapp" swaps markdown links for bare URLs — WhatsApp renders no markdown.
  let system = buildSystemPrompt(settings, "whatsapp");
  let history = loadTurns(convo?.turns);

  // Give the LLM the REAL thread — human agent replies, the button-menu bot,
  // everything — not just its own memory. Without this it walked blind into
  // disputes a human was already handling and could contradict them. DoubleTick
  // only (Interakt exposes no thread API); on fetch failure the bot's own
  // stored turns remain as the fallback.
  if (settings.waProvider === "doubletick") {
    const thread = await fetchDoubleTickThread({
      apiKey: settings.waApiKey,
      wabaNumber: settings.waFromNumber,
      customerNumber: "91" + job.phone,
      excludeMessageId: job.providerMessageId,
    });
    if (thread) {
      system +=
        "\n\n=== RECENT WHATSAPP CONVERSATION (oldest first) ===\n" +
        thread +
        "\n=== END OF CONVERSATION ===\n" +
        "Rules for using the conversation above:\n" +
        "1. Continue this conversation naturally — do not repeat information already given.\n" +
        "2. Messages from \"Store team (human)\" are a human colleague. NEVER contradict or overrule what they said. If the customer asks for something the human already declined or is handling, refer back to that and suggest they continue with the team.\n" +
        "3. If the thread shows an ongoing dispute or order-specific problem, keep your reply brief and defer to the store team.";
      // The thread supersedes the bot's own partial memory — sending both
      // would duplicate content and spend tokens twice.
      history = [];
    }
  }

  const ai = await callAi({
    provider: settings.aiProvider,
    apiKey: settings.apiKey,
    system,
    history,
    message: job.message,
  });

  if (!ai.ok) {
    // bad-key / bad-model are configuration problems: retrying burns quota and
    // will fail identically every time. A rate limit is the opposite — it
    // clears on its own, so the job stays pending and the next tick retries.
    const permanent = ai.error === "bad-key" || ai.error === "bad-model";
    return { ok: false, error: `${settings.aiProvider}:${ai.error}`, permanent };
  }

  // The model ends its reply with [HANDOFF] when it decides a human must take
  // over (order-specific problem, frustrated customer). The token never
  // reaches the shopper; it mutes the bot for this thread below, exactly like
  // the customer typing "agent" — a human replies undisturbed, and "start"
  // resumes the bot. Learned from a live thread where the bot interrogated an
  // angry customer for six turns before escalating.
  const handoff = ai.text.includes("[HANDOFF]");
  const replyText =
    ai.text.replace(/\s*\[HANDOFF\]\s*/g, " ").replace(/\s+$/g, "").trim() ||
    "Our team will take it from here and reply to you shortly.";

  const wa = await send(replyText, handoff ? "badgehq-ai-handoff" : "badgehq-ai");

  if (!wa.ok) {
    // Outside the 24h service window a free-text send is refused by either
    // provider. Do NOT fall back to a template: those cost money and need
    // pre-approval.
    const permanent = wa.error.startsWith("outside-window") || wa.error === "invalid-phone";
    return { ok: false, error: `${settings.waProvider}:${wa.error}`, permanent };
  }

  // Record the exchange only once it actually reached the shopper.
  await prisma.whatsAppConversation.upsert({
    where: { shop_phone: { shop: job.shop, phone: job.phone } },
    create: {
      shop: job.shop,
      phone: job.phone,
      turns: appendTurns([], job.message, replyText),
      optedOut: handoff,
    },
    update: {
      turns: appendTurns(history, job.message, replyText),
      // One-way here: only the customer's "start" (or the merchant) unmutes.
      ...(handoff ? { optedOut: true } : {}),
    },
  });

  return { ok: true };
}
