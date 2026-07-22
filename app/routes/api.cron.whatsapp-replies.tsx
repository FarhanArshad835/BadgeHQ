/**
 * Hourly maintenance sweep for WhatsApp AI replies — /api/cron/whatsapp-replies
 *
 * HOURLY, deliberately. This ran every minute and was the app's single biggest
 * infrastructure cost: 43,200 invocations and ~345,000 database queries a
 * month, almost all finding nothing — and a query every few seconds kept the
 * Neon endpoint permanently awake, defeating its auto-suspend.
 *
 * It could drop to hourly because it is not the delivery path. New messages
 * are answered in-invocation by the webhooks (waitUntil), and retries ride on
 * inbound traffic: every webhook piggybacks a drain of the oldest pending jobs
 * (drainPendingBacklog), so a busy shop clears its backlog within minutes —
 * precisely when traffic exists — and an idle shop spends nothing.
 *
 * What remains here is what genuinely needs a clock: reviving throttled jobs
 * during quiet spells, stale-claim recovery as a backstop, and retention
 * purges. Guarded by CRON_SECRET because a run can spend the merchant's quota.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { PURGE_AFTER_HOURS } from "../utils/whatsapp-ai.server";
import { processReplyJob } from "../utils/whatsapp-reply.server";

/** Bounded so one run can't exceed the function timeout. */
const BATCH = 8; // paced 4s apart below — keep BATCH * 4s under maxDuration
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

  // Revive messages dropped by throttling. Before rate limits stopped counting
  // as attempts, a burst could mark a customer failed within three minutes and
  // the cron never looks at "failed" again — so those people got permanent
  // silence for a limit that cleared a minute later. Recent ones are worth one
  // more try; older than an hour, a reply would arrive too late to be useful.
  await prisma.whatsAppReplyJob.updateMany({
    where: {
      status: "failed",
      error: { contains: "rate-limited" },
      updatedAt: { gt: new Date(now.getTime() - 3600_000) },
    },
    data: { status: "pending", attempts: 0 },
  });

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

  // Same worker the webhooks' instant path runs — see whatsapp-reply.server.ts.
  //
  // Spaced, not fired together. Groq's free tier allows ~12K tokens a minute,
  // which at ~2.3K a reply is about five; a batch of ten sent at once put every
  // one of them over the limit. A short gap between calls keeps a burst inside
  // the window instead of failing the whole batch.
  for (let i = 0; i < claimed.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 4000));
    const outcome = await processReplyJob(claimed[i].id);
    if (outcome === "sent") sent++;
    else if (outcome === "failed") failed++;
  }

  // Purge cold threads in the same pass — no second cron needed.
  const purged = await prisma.whatsAppConversation.deleteMany({
    where: { updatedAt: { lt: new Date(now.getTime() - PURGE_AFTER_HOURS * 3600_000) } },
  });

  // Sweep rows left by the temporary payload-capture route (2026-07-20 payload
  // diagnosis) — they held raw webhook bodies with real customer messages.
  // A no-op once empty; kept until the general job-table purge lands.
  await prisma.whatsAppReplyJob.deleteMany({ where: { shop: "__dt_capture__" } });

  // Finished jobs are kept 30 days for the activity view, then dropped — this
  // table previously grew without bound, which on Neon is paid storage that
  // never shrinks. Pending/claimed rows are never touched here.
  await prisma.whatsAppReplyJob.deleteMany({
    where: {
      status: { in: ["done", "failed"] },
      updatedAt: { lt: new Date(now.getTime() - 30 * 24 * 3600_000) },
    },
  });

  // Skip records are diagnostics for the admin's activity view, not history —
  // 7 days is long enough to answer "why didn't it reply to her on Tuesday"
  // and short enough that the table cannot grow without bound.
  await prisma.whatsAppSkip.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - 7 * 24 * 3600_000) } },
  });

  return json({ ok: true, claimed: claimed.length, sent, failed, purged: purged.count });
};
