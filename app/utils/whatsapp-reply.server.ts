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
import { sendDoubleTickList, sendWhatsAppText } from "./whatsapp.server";
import {
  HANDOFF_MUTE_HOURS,
  HANDOFF_REPLY,
  cheapReplyKind,
  appendTurns,
  fetchDoubleTickThread,
  isMuted,
  loadTurns,
} from "./whatsapp-ai.server";
import {
  HANDOVER_REPLY,
  MENU_BODY,
  MENU_BUTTON,
  MENU_REPLIES,
  MENU_ROWS,
  OFF_HOURS_REPLY,
  isBusinessHoursIST,
  matchMenuIntent,
} from "./whatsapp-menu.server";

export const MAX_ATTEMPTS = 3;

/**
 * Past this age a queued reply is dropped instead of sent.
 *
 * Throttled jobs retry every minute until the limit clears, which for a daily
 * quota means midnight. Without this, a question asked at 2pm was answered at
 * 00:00 — long after a human had handled it or the customer had given up. Two
 * hours is roughly how long a support answer stays useful.
 */
export const STALE_REPLY_MS = 2 * 60 * 60 * 1000;

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

    // A rate limit is not a failed attempt — it means we never got to try.
    // Counting it burned all three retries inside three minutes against a
    // per-minute window a burst keeps saturated, and the message was then
    // dropped forever (the cron only ever picks up "pending"). Observed live:
    // 13 of 15 customers silently lost, including "It's urgent" and "Call me
    // pls". Rate-limited jobs go back to pending with the attempt refunded.
    const throttled =
      result.error.endsWith(":rate-limited") || result.error.endsWith(":quota-exhausted");
    if (throttled) {
      await prisma.whatsAppReplyJob.update({
        where: { id },
        data: {
          status: "pending",
          attempts: Math.max(0, job.attempts - 1),
          error: result.error.slice(0, 300),
        },
      });
      return "failed";
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
  // After answering this message, opportunistically drain a little of the
  // pending backlog. This is what replaced the every-minute cron: retries now
  // ride on inbound traffic, so a busy shop clears its rate-limited queue
  // within minutes (exactly when messages are flowing) and an idle shop costs
  // nothing at all. The cron still sweeps hourly as the backstop.
  //
  // Skipped when this message's own reply was throttled: the quota is plainly
  // gone, so piggybacked attempts would each spend an 8s thread fetch just to
  // hear the same 429. During quota exhaustion — the busiest hours — that
  // multiplied held-open wall time by ~5x for zero delivered replies.
  const work = drainJobNow(id).then(async () => {
    const own = await prisma.whatsAppReplyJob.findUnique({
      where: { id },
      select: { error: true },
    });
    const throttled =
      own?.error?.includes("rate-limited") || own?.error?.includes("quota-exhausted");
    if (!throttled) await drainPendingBacklog(2);
  });
  try {
    waitUntil(work);
  } catch {
    void work;
  }
}

/**
 * Drain up to `max` of the oldest pending jobs, paced apart so this burst and
 * the reply that preceded it stay inside the LLM's per-minute token window.
 *
 * Total by construction — runs inside waitUntil where a throw would vanish.
 * Also recovers stale claims first: with the cron now hourly, a crashed
 * invocation would otherwise strand its job as "claimed" for up to an hour,
 * and this makes the next inbound message rescue it instead.
 */
export async function drainPendingBacklog(max: number): Promise<void> {
  try {
    await prisma.whatsAppReplyJob.updateMany({
      where: { status: "claimed", updatedAt: { lt: new Date(Date.now() - 5 * 60_000) } },
      data: { status: "pending" },
    });

    for (let i = 0; i < max; i++) {
      const next = await prisma.whatsAppReplyJob.findFirst({
        // The backoff filter is what stops a stuck job being hammered: without
        // it, the OLDEST pending job was re-picked by every inbound webhook,
        // failing the same way each time. Three minutes between attempts on
        // any one job caps the waste while a per-minute limit still clears.
        where: { status: "pending", updatedAt: { lt: new Date(Date.now() - 3 * 60_000) } },
        orderBy: { createdAt: "asc" },
        select: { id: true },
      });
      if (!next) return;

      // Space the calls out; the webhook's own reply just spent tokens.
      await new Promise((r) => setTimeout(r, 4000));
      if (await claimReplyJob(next.id)) {
        await processReplyJob(next.id);
      }
    }
  } catch (e) {
    console.error("[wa-reply] backlog drain failed", e);
  }
}

/**
 * True when the last non-customer line in the transcript came from a person
 * rather than from us. Cheap string work on text already fetched — no extra
 * API call, no tokens.
 */
function humanRepliedLast(thread: string): boolean {
  const lines = thread.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].startsWith("Customer:")) return false;
    if (lines[i].startsWith("Store team (human):")) return true;
    // "Store assistant:" is us — keep looking further back.
  }
  return false;
}

async function handleJob(job: {
  id: string;
  shop: string;
  phone: string;
  message: string;
  providerMessageId: string;
  createdAt: Date;
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
  if (isMuted(convo)) return { ok: false, error: "opted-out", permanent: true };

  // Too old to be worth sending. A message throttled all afternoon would
  // otherwise go out when the quota resets at midnight, answering a question
  // from hours earlier — by which time the customer has been helped, given up,
  // or forgotten asking. Silence beats a reply that arrives out of time.
  const ageMs = Date.now() - job.createdAt.getTime();
  if (ageMs > STALE_REPLY_MS) {
    return { ok: false, error: "too-old", permanent: true };
  }

  // Daily ceiling, checked BEFORE the LLM call — the whole point is to not
  // spend the token that would break the budget. Free tiers cap tokens per
  // day, and one exhausted quota silences the bot for every customer until
  // UTC midnight, so refusing one reply is much cheaper than refusing all of
  // tomorrow morning's.
  if (settings.waDailyLimit > 0) {
    // Day boundary in IST, not UTC. UTC midnight is 05:30 IST, so a UTC day
    // splits an Indian working day in half: the cap would reset mid-morning
    // and the previous evening's replies would count against it. Every shop
    // using this is +91-only (see toIndianTenDigit), so IST is the right
    // boundary rather than a per-shop setting.
    const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
    const nowIst = new Date(Date.now() + IST_OFFSET_MS);
    nowIst.setUTCHours(0, 0, 0, 0);
    const since = new Date(nowIst.getTime() - IST_OFFSET_MS);
    const today = await prisma.whatsAppReplyJob.count({
      where: { shop: job.shop, status: "done", updatedAt: { gte: since } },
    });
    if (today >= settings.waDailyLimit) {
      console.warn(`[wa-reply] daily limit ${settings.waDailyLimit} reached for ${job.shop}`);
      return { ok: false, error: "daily-limit", permanent: true };
    }
  }

  // Answer greetings and nudges without a model call. On a real day these were
  // 21 of 53 inbound messages and consumed half the free daily quota, while
  // genuine questions behind them were rate-limited into silence. A greeting
  // always gets the same words anyway, and a nudge ("are u there", "reply
  // please") means the bot already failed — asking a model to apologise again
  // helps nobody.
  const cheap = cheapReplyKind(job.message);
  if (cheap === "greeting") {
    // On DoubleTick a greeting opens the tappable support menu — the
    // replacement for the merchant's flow bot, which used to fire this menu on
    // every message. Interakt has no list endpoint here, so it keeps the plain
    // greeting.
    if (settings.waProvider === "doubletick") {
      const wa = await sendDoubleTickList({
        apiKey: settings.waApiKey,
        phone: job.phone,
        fromNumber: settings.waFromNumber,
        body: MENU_BODY,
        buttonLabel: MENU_BUTTON,
        rows: MENU_ROWS,
      });
      return wa.ok ? { ok: true } : { ok: false, error: wa.error };
    }
    const wa = await send(
      settings.greeting || "Hi! How can I help you today?",
      "badgehq-ai-greeting",
    );
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }
  if (cheap === "nudge") {
    // Hand off rather than reply: the customer is chasing an answer they did
    // not get, so a person should pick this up.
    const wa = await send(HANDOFF_REPLY, "badgehq-ai-nudge");
    if (wa.ok) {
      await prisma.whatsAppConversation.upsert({
        where: { shop_phone: { shop: job.shop, phone: job.phone } },
        create: {
          shop: job.shop,
          phone: job.phone,
          optedOut: true,
          mutedUntil: new Date(Date.now() + HANDOFF_MUTE_HOURS * 3600_000),
        },
        update: {
          optedOut: true,
          mutedUntil: new Date(Date.now() + HANDOFF_MUTE_HOURS * 3600_000),
        },
      });
      return { ok: true };
    }
    return { ok: false, error: wa.error };
  }

  // The deterministic menu: button taps and short typed questions that the
  // merchant's canned answers already cover. Zero LLM tokens, instant, and it
  // is what lets the flow bot in DoubleTick be switched off without losing the
  // button experience. Longer messages fall through to the AI, which sees the
  // whole thread.
  const intent = matchMenuIntent(job.message);
  if (intent === "human") {
    // The flow's "Talk to Us" branch: hours-aware, then the team owns the
    // thread — mute the bot exactly as a handoff does.
    const wa = await send(
      isBusinessHoursIST() ? HANDOVER_REPLY : OFF_HOURS_REPLY,
      "badgehq-menu-human",
    );
    if (wa.ok) {
      await prisma.whatsAppConversation.upsert({
        where: { shop_phone: { shop: job.shop, phone: job.phone } },
        create: {
          shop: job.shop,
          phone: job.phone,
          optedOut: true,
          mutedUntil: new Date(Date.now() + HANDOFF_MUTE_HOURS * 3600_000),
        },
        update: {
          optedOut: true,
          mutedUntil: new Date(Date.now() + HANDOFF_MUTE_HOURS * 3600_000),
        },
      });
      return { ok: true };
    }
    return { ok: false, error: wa.error };
  }
  if (intent) {
    const wa = await send(MENU_REPLIES[intent], `badgehq-menu-${intent}`);
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }

  // "whatsapp" swaps markdown links for bare URLs — WhatsApp renders no markdown.
  let system = buildSystemPrompt(settings, "whatsapp", job.message);
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
      recent: settings.waThreadRecent,
      opening: settings.waThreadOpening,
      maxLineChars: settings.waThreadLineChars,
      maxTotalChars: settings.waThreadTotalChars,
    });
    // A human replying in the provider inbox is the clearest signal the bot is
    // not needed — but nothing marks the thread as handled, so a queued reply
    // would still arrive later and answer what the team already resolved.
    // The thread text labels human messages distinctly (see
    // fetchDoubleTickThread), so a human line after the customer's last one
    // means: stand down.
    if (thread && humanRepliedLast(thread)) {
      return { ok: false, error: "human-replied", permanent: true };
    }

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
    // will fail identically every time.
    //
    // Rate limits are the opposite — they clear on their own, so the job goes
    // back to pending. But MAX_ATTEMPTS is 3 and the cron runs every minute,
    // so a PER-DAY quota burned all three retries within three minutes and the
    // message was dropped as failed, hours before the quota would reset. Reset
    // the attempt counter for those so the job survives until the quota does.
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
      mutedUntil: handoff ? new Date(Date.now() + HANDOFF_MUTE_HOURS * 3600_000) : null,
    },
    update: {
      turns: appendTurns(history, job.message, replyText),
      // Automatic mute EXPIRES — an explicit "stop" from the shopper does not
      // (that path leaves mutedUntil null). Permanent was wrong: no shopper
      // knows to type "start", so one complaint silenced the bot for that
      // number forever, including for unrelated questions later.
      ...(handoff
        ? { optedOut: true, mutedUntil: new Date(Date.now() + HANDOFF_MUTE_HOURS * 3600_000) }
        : {}),
    },
  });

  return { ok: true };
}
