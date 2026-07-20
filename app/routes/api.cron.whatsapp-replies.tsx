/**
 * Cron sweep for inbound WhatsApp AI replies — /api/cron/whatsapp-replies
 *
 * Runs every minute (see vercel.json). Since the webhooks drain their own jobs
 * instantly via waitUntil(), this is the SAFETY NET, not the primary path: it
 * picks up whatever the instant path dropped — a crashed invocation, a
 * rate-limited retry, a stale claim. Most ticks find nothing and exit in
 * milliseconds.
 *
 * Guarded by CRON_SECRET because every run can spend the merchant's LLM quota.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { PURGE_AFTER_HOURS } from "../utils/whatsapp-ai.server";
import { processReplyJob } from "../utils/whatsapp-reply.server";

/** Bounded so one run can't exceed the function timeout. */
const BATCH = 10;
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

  // Same worker the webhooks' instant path runs — see whatsapp-reply.server.ts.
  for (const { id } of claimed) {
    const outcome = await processReplyJob(id);
    if (outcome === "sent") sent++;
    else if (outcome === "failed") failed++;
  }

  // Purge cold threads in the same pass — no second cron needed.
  const purged = await prisma.whatsAppConversation.deleteMany({
    where: { updatedAt: { lt: new Date(now.getTime() - PURGE_AFTER_HOURS * 3600_000) } },
  });

  return json({ ok: true, claimed: claimed.length, sent, failed, purged: purged.count });
};
