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
  // Bot vs team per day. Separate from `days` because this is a two-series
  // comparison, not a volume trend: what matters is the SHARE the bot carried,
  // and whether it is drifting.
  split: Array<{ day: string; bot: number; human: number }>;
  received: number;
  answered: number;
  failed: number;
  pending: number;
  skipped: number;
  shoppers: number;
  answerRate: number; // 0..100, of messages the bot could have answered
  waAnswered: number;
  igAnswered: number;
  // How the shoppers in this range split by who finished with them. Every
  // shopper is in exactly one, so the two sum to `shoppers`.
  handledByAi: number;
  handledByHuman: number;
  handedOver: number; // handovers in the range
  escalatedByBot: number; // the assistant decided it could not finish
  askedForHuman: number; // the shopper asked for a person
  unresolvedHandovers: number; // asked twice and never described an issue
  // Bot speed, from the message landing to the reply going out. Median rather
  // than mean: one 40s LLM timeout would drag a mean into fiction.
  medianReplySeconds: number;
  repliesUnderAMinute: number;
  // Messages the bot did not answer. Counted separately from handovers: a voice
  // note or a rate limit is not a customer a person took over.
  messagesToHuman: number;
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

  const [waJobs, igJobs, waSkips, igSkips, handovers] = await Promise.all([
    prisma.whatsAppReplyJob.findMany({
      where: { shop, createdAt: window },
      select: { createdAt: true, updatedAt: true, status: true, phone: true },
    }),
    prisma.socialReplyJob.findMany({
      where: { shop, createdAt: window },
      select: { createdAt: true, updatedAt: true, status: true, customerId: true },
    }),
    prisma.whatsAppSkip.findMany({
      where: { shop, createdAt: window },
      select: { reason: true },
    }),
    prisma.socialSkip.findMany({
      where: { shop, createdAt: window },
      select: { reason: true },
    }),
    // Real handover EVENTS, so the split respects the date range.
    //
    // The mute flags on the conversation row cannot do this job: they are
    // current state, and those rows are purged after 24 hours, so a handover
    // from last week has already disappeared. Comparing all-time mutes against
    // one week of shoppers was the bug that made this card unreadable.
    prisma.handover.findMany({
      where: { shop, createdAt: window },
      select: { channel: true, customerId: true, reason: true, createdAt: true },
    }),
  ]);

  const byDay = new Map<string, number>();
  // Handovers per day, so the split can be plotted rather than only totalled.
  const handoverByDay = new Map<string, number>();
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += DAY_MS) {
    const day = new Date(t).toISOString().slice(0, 10);
    byDay.set(day, 0);
    handoverByDay.set(day, 0);
  }

  const shoppers = new Set<string>();
  let answered = 0;
  let failed = 0;
  let pending = 0;
  let waAnswered = 0;
  let igAnswered = 0;

  // Seconds from the message arriving to the reply being sent, for done jobs.
  const latencies: number[] = [];

  const tally = (
    rows: Array<{ createdAt: Date; updatedAt: Date; status: string }>,
    onDone: () => void,
  ) => {
    for (const r of rows) {
      if (r.status === "done") {
        answered++;
        onDone();
        latencies.push((r.updatedAt.getTime() - r.createdAt.getTime()) / 1000);
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

  // A shopper was finished by the bot unless they were handed to a person. That
  // is the whole question this card exists to answer, so it is measured on the
  // handover event and nothing else.
  const handedToHuman = new Set(
    handovers.map((h) => `${h.channel === "whatsapp" ? "wa" : "ig"}:${h.customerId}`),
  );
  let handledByHuman = 0;
  for (const id of shoppers) {
    if (handedToHuman.has(id)) handledByHuman++;
  }

  for (const h of handovers) {
    const day = new Date(h.createdAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    if (handoverByDay.has(day)) handoverByDay.set(day, (handoverByDay.get(day) ?? 0) + 1);
  }

  const escalatedByBot = handovers.filter((h) => h.reason === "escalated").length;
  const askedForHuman = handovers.filter((h) => h.reason === "asked").length;

  latencies.sort((a, b) => a - b);
  const medianReplySeconds =
    latencies.length > 0 ? Math.round(latencies[Math.floor(latencies.length / 2)]) : 0;
  const repliesUnderAMinute = latencies.filter((l) => l <= 60).length;

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
    split: Array.from(byDay.entries()).map(([day, bot]) => ({
      day,
      bot,
      human: handoverByDay.get(day) ?? 0,
    })),
    received: waJobs.length + igJobs.length + skipped,
    answered,
    failed,
    pending,
    skipped,
    shoppers: shoppers.size,
    answerRate,
    waAnswered,
    igAnswered,
    handledByAi: shoppers.size - handledByHuman,
    handledByHuman,
    handedOver: handovers.length,
    escalatedByBot,
    askedForHuman,
    unresolvedHandovers: handovers.length - escalatedByBot - askedForHuman,
    medianReplySeconds,
    repliesUnderAMinute,
    // Everything the bot did not resolve is work that reached a person: the
    // failures, plus every message it deliberately handed over or skipped.
    messagesToHuman: failed + skipped,
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
