/**
 * Automated Replies analytics.
 *
 * Two channels (WhatsApp and Instagram DMs) with parallel-but-separate tables,
 * unioned here so the merchant sees one inbox rather than two half-pictures.
 *
 * The headline is NOT "messages received": it is the answer rate, and the reasons
 * behind the messages the bot stayed silent on. A skip is more interesting than a
 * success, because a skip is where the feature disappointed a real shopper.
 */
import prisma from "../db.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** The skip reasons the webhooks record, in words a merchant can act on. */
const SKIP_LABELS: Record<string, string> = {
  muted: "Handed to a human",
  "rate-limited": "Hit the reply limit",
  "non-indian": "Not an Indian number",
  "not-text": "Image, voice or sticker",
  "feature-off": "Replies were switched off",
};
export function skipLabel(reason: string): string {
  return SKIP_LABELS[reason] ?? reason;
}

export type AiReplyStats = {
  days: Array<{ day: string; adds: number }>; // "adds" = replies sent, to match DailyTrend
  received: number;
  answered: number;
  failed: number;
  pending: number;
  skipped: number;
  shoppers: number;
  answerRate: number; // 0..100, of messages the bot could have answered
  waAnswered: number;
  igAnswered: number;
  handedOver: number; // conversations currently muted or opted out
  topSkips: Array<{ reason: string; count: number }>;
};

export async function aiReplyStats(
  shop: string,
  fromDay: string,
  toDay: string,
): Promise<AiReplyStats> {
  const since = new Date(Date.parse(`${fromDay}T00:00:00Z`) - IST_OFFSET_MS);
  const until = new Date(Date.parse(`${toDay}T00:00:00Z`) - IST_OFFSET_MS + DAY_MS);
  const window = { gte: since, lt: until };

  const [waJobs, igJobs, waSkips, igSkips, waMuted, igMuted] = await Promise.all([
    prisma.whatsAppReplyJob.findMany({
      where: { shop, createdAt: window },
      select: { createdAt: true, status: true, phone: true },
    }),
    prisma.socialReplyJob.findMany({
      where: { shop, createdAt: window },
      select: { createdAt: true, status: true, customerId: true },
    }),
    prisma.whatsAppSkip.findMany({
      where: { shop, createdAt: window },
      select: { reason: true },
    }),
    prisma.socialSkip.findMany({
      where: { shop, createdAt: window },
      select: { reason: true },
    }),
    // Handovers are a CURRENT state, not a windowed one: a shopper still waiting
    // on a human is who the merchant needs to see, whenever they were muted.
    prisma.whatsAppConversation.count({
      where: { shop, OR: [{ optedOut: true }, { mutedUntil: { gt: new Date() } }] },
    }),
    prisma.socialConversation.count({
      where: { shop, OR: [{ optedOut: true }, { mutedUntil: { gt: new Date() } }] },
    }),
  ]);

  const byDay = new Map<string, number>();
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += DAY_MS) {
    byDay.set(new Date(t).toISOString().slice(0, 10), 0);
  }

  const shoppers = new Set<string>();
  let answered = 0;
  let failed = 0;
  let pending = 0;
  let waAnswered = 0;
  let igAnswered = 0;

  const tally = (
    rows: Array<{ createdAt: Date; status: string }>,
    onDone: () => void,
  ) => {
    for (const r of rows) {
      if (r.status === "done") {
        answered++;
        onDone();
        const day = new Date(r.createdAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
        if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
      } else if (r.status === "failed") {
        failed++;
      } else {
        // pending or claimed: still in the queue, not yet a success or failure.
        pending++;
      }
    }
  };

  for (const j of waJobs) shoppers.add(`wa:${j.phone}`);
  for (const j of igJobs) shoppers.add(`ig:${j.customerId}`);
  tally(waJobs, () => waAnswered++);
  tally(igJobs, () => igAnswered++);

  const skipCounts = new Map<string, number>();
  for (const s of [...waSkips, ...igSkips]) {
    skipCounts.set(s.reason, (skipCounts.get(s.reason) ?? 0) + 1);
  }
  const skipped = waSkips.length + igSkips.length;

  // Rate is measured against messages that reached the queue at all. Skips are
  // excluded on purpose: the bot declining to answer a voice note is not a
  // failure to answer, and folding those in would make the rate meaningless.
  const attempted = answered + failed;
  const answerRate = attempted > 0 ? Math.round((answered / attempted) * 1000) / 10 : 0;

  return {
    days: Array.from(byDay.entries()).map(([day, adds]) => ({ day, adds })),
    received: waJobs.length + igJobs.length + skipped,
    answered,
    failed,
    pending,
    skipped,
    shoppers: shoppers.size,
    answerRate,
    waAnswered,
    igAnswered,
    handedOver: waMuted + igMuted,
    topSkips: Array.from(skipCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count })),
  };
}

export type AiReplyActivityRow = {
  id: string;
  when: Date;
  channel: string;
  who: string;
  message: string;
  status: string;
  error: string;
};

/**
 * The unified feed: replies and skips from both channels, newest first.
 *
 * Skips are shown alongside successes rather than on a separate tab, because
 * "which of my customers got no answer" is the question this page exists for.
 */
export async function recentAiReplyActivity(shop: string, limit = 50): Promise<AiReplyActivityRow[]> {
  const [waJobs, igJobs, waSkips, igSkips] = await Promise.all([
    prisma.whatsAppReplyJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true, phone: true, message: true, status: true, error: true },
    }),
    prisma.socialReplyJob.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true, customerId: true, message: true, status: true, error: true, channel: true },
    }),
    prisma.whatsAppSkip.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true, phone: true, reason: true, preview: true },
    }),
    prisma.socialSkip.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: { id: true, createdAt: true, customerId: true, reason: true, preview: true, channel: true },
    }),
  ]);

  const rows: AiReplyActivityRow[] = [
    ...waJobs.map((j) => ({
      id: `waj:${j.id}`,
      when: j.createdAt,
      channel: "WhatsApp",
      who: j.phone,
      message: j.message,
      status: j.status,
      error: j.error,
    })),
    ...igJobs.map((j) => ({
      id: `igj:${j.id}`,
      when: j.createdAt,
      channel: j.channel === "instagram" ? "Instagram" : j.channel,
      who: j.customerId,
      message: j.message,
      status: j.status,
      error: j.error,
    })),
    ...waSkips.map((s) => ({
      id: `was:${s.id}`,
      when: s.createdAt,
      channel: "WhatsApp",
      who: s.phone,
      message: s.preview,
      status: "skipped",
      error: s.reason,
    })),
    ...igSkips.map((s) => ({
      id: `igs:${s.id}`,
      when: s.createdAt,
      channel: s.channel === "instagram" ? "Instagram" : s.channel,
      who: s.customerId,
      message: s.preview,
      status: "skipped",
      error: s.reason,
    })),
  ];

  return rows.sort((a, b) => b.when.getTime() - a.when.getTime()).slice(0, limit);
}
