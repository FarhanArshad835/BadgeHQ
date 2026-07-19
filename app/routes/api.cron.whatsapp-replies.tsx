/**
 * Cron drain for inbound WhatsApp AI replies — /api/cron/whatsapp-replies
 *
 * Runs every minute (see vercel.json). The webhook can only spend 3 seconds, so
 * the slow half of the work lives here: load the thread, ask Gemini, send the
 * answer back over WhatsApp.
 *
 * Guarded by CRON_SECRET because every run spends the merchant's Gemini quota.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { buildSystemPrompt, callGemini } from "../utils/ai-replies.server";
import { sendInteraktText } from "../utils/whatsapp.server";
import {
  HANDOFF_REPLY,
  PURGE_AFTER_HOURS,
  appendTurns,
  loadTurns,
} from "../utils/whatsapp-ai.server";

/** Bounded so one run can't exceed the function timeout. */
const BATCH = 10;
const MAX_ATTEMPTS = 3;
/** A row claimed longer ago than this is assumed abandoned and retried. */
const STALE_CLAIM_MS = 5 * 60 * 1000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("Authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  // Recover rows abandoned by a run that died mid-flight.
  await prisma.whatsAppReplyJob.updateMany({
    where: { status: "claimed", updatedAt: { lt: staleBefore } },
    data: { status: "pending" },
  });

  const candidates = await prisma.whatsAppReplyJob.findMany({
    where: { status: "pending" },
    orderBy: { createdAt: "asc" },
    take: BATCH,
    select: { id: true },
  });

  let claimed: typeof candidates = [];
  if (candidates.length) {
    const ids = candidates.map((c) => c.id);
    // Atomic claim. Cron runs can overlap, and two runs sending the same reply
    // would double-message the shopper. The `status: "pending"` predicate means
    // a loser updates zero rows rather than stealing the job. A conditional
    // updateMany (not a transaction) is deliberate: the DB is behind PgBouncer.
    await prisma.whatsAppReplyJob.updateMany({
      where: { id: { in: ids }, status: "pending" },
      data: { status: "claimed", attempts: { increment: 1 } },
    });
    claimed = await prisma.whatsAppReplyJob.findMany({
      where: { id: { in: ids }, status: "claimed" },
      select: { id: true },
    });
  }

  let sent = 0;
  let failed = 0;

  for (const { id } of claimed) {
    const job = await prisma.whatsAppReplyJob.findUnique({ where: { id } });
    if (!job) continue;

    const result = await handleJob(job);

    if (result.ok) {
      await prisma.whatsAppReplyJob.update({
        where: { id },
        data: { status: "done", error: "" },
      });
      sent++;
    } else {
      const giveUp = job.attempts >= MAX_ATTEMPTS || result.permanent;
      await prisma.whatsAppReplyJob.update({
        where: { id },
        data: {
          status: giveUp ? "failed" : "pending",
          error: result.error.slice(0, 300),
        },
      });
      failed++;
    }
  }

  // Purge cold threads in the same pass — no second cron needed.
  const purged = await prisma.whatsAppConversation.deleteMany({
    where: { updatedAt: { lt: new Date(now.getTime() - PURGE_AFTER_HOURS * 3600_000) } },
  });

  return json({ ok: true, claimed: claimed.length, sent, failed, purged: purged.count });
};

type JobResult = { ok: true } | { ok: false; error: string; permanent?: boolean };

async function handleJob(job: {
  id: string;
  shop: string;
  phone: string;
  message: string;
}): Promise<JobResult> {
  const settings = await prisma.aiReplySettings.findUnique({ where: { shop: job.shop } });
  if (!settings?.waReplyEnabled || !settings.isEnabled || !settings.apiKey) {
    // Merchant switched it off between queueing and now — drop, don't retry.
    return { ok: false, error: "feature-disabled", permanent: true };
  }
  if (!settings.waApiKey) {
    return { ok: false, error: "no-interakt-key", permanent: true };
  }

  // The handoff acknowledgement is a fixed string — no AI, no quota spent.
  if (job.message === "__handoff__") {
    const wa = await sendInteraktText({
      apiKey: settings.waApiKey,
      phone: job.phone,
      message: HANDOFF_REPLY,
      callbackData: "badgehq-ai-handoff",
    });
    return wa.ok ? { ok: true } : { ok: false, error: wa.error };
  }

  const convo = await prisma.whatsAppConversation.findUnique({
    where: { shop_phone: { shop: job.shop, phone: job.phone } },
  });
  // Muted after the job was queued — a human has the thread now.
  if (convo?.optedOut) return { ok: false, error: "opted-out", permanent: true };

  const history = loadTurns(convo?.turns);

  const ai = await callGemini({
    apiKey: settings.apiKey,
    // "whatsapp" swaps markdown links for bare URLs — WhatsApp renders no markdown.
    system: buildSystemPrompt(settings, "whatsapp"),
    history,
    message: job.message,
  });

  if (!ai.ok) {
    // bad-key / bad-model are configuration problems: retrying burns quota and
    // will fail identically every time.
    const permanent = ai.error === "bad-key" || ai.error === "bad-model";
    return { ok: false, error: `gemini:${ai.error}`, permanent };
  }

  const wa = await sendInteraktText({
    apiKey: settings.waApiKey,
    phone: job.phone,
    message: ai.text,
    callbackData: "badgehq-ai",
  });

  if (!wa.ok) {
    // Outside the 24h service window a free-text send is refused. Do NOT fall
    // back to a template: those cost money and need pre-approval.
    const permanent = wa.error.startsWith("outside-window") || wa.error === "invalid-phone";
    return { ok: false, error: `interakt:${wa.error}`, permanent };
  }

  // Record the exchange only once it actually reached the shopper.
  await prisma.whatsAppConversation.upsert({
    where: { shop_phone: { shop: job.shop, phone: job.phone } },
    create: {
      shop: job.shop,
      phone: job.phone,
      turns: appendTurns([], job.message, ai.text),
    },
    update: { turns: appendTurns(history, job.message, ai.text) },
  });

  return { ok: true };
}
