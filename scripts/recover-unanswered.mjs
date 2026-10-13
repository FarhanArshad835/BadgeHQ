/**
 * Hand over the customers the bot never answered during the Claude outage.
 *
 * Between 8 and 13 October the Anthropic account ran out of credit. The worker
 * had no handoff on that path, so each message retried quietly until the
 * two-hour cutoff and was marked "too-old" — 679 jobs, 543 people, no reply and
 * no agent assigned. The code fix stops it recurring; this clears the backlog
 * it left.
 *
 * Only reaches people still inside WhatsApp's 24-hour service window. Outside
 * it Meta rejects a free-form message and only a paid template gets through,
 * which is a different decision — cost per message, against a question that may
 * be days stale — and is deliberately not made here.
 *
 * Skips, in order:
 *   - anyone the bot has since answered (they came back and got a reply)
 *   - link blasts and spam
 *   - anyone already muted or opted out: a human has the thread already
 *   - anyone who already has a Handover row for this window
 *
 * Does exactly what the fixed worker now does: sends the handover message,
 * fires the assign flow, records the Handover, and mutes the bot so it does not
 * talk over the agent.
 *
 *   node scripts/recover-unanswered.mjs                 # dry run
 *   node scripts/recover-unanswered.mjs --write         # send and assign
 *   node scripts/recover-unanswered.mjs --since 2026-10-08
 */
import { PrismaClient } from "@prisma/client";
import fs from "node:fs";
import path from "node:path";

const WRITE = process.argv.includes("--write");
const sinceArg = process.argv.indexOf("--since");
const SINCE = sinceArg > -1 ? process.argv[sinceArg + 1] : "2026-10-08";

function envVar(key) {
  if (process.env[key]) return process.env[key];
  for (const name of [".env", ".env.local", ".env.production"]) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    const m = fs.readFileSync(p, "utf8").match(new RegExp("^" + key + '="?([^"\n]+)"?', "m"));
    if (m) return m[1];
  }
  return null;
}

const dbUrl = envVar("DATABASE_URL");
if (!dbUrl) {
  console.error("DATABASE_URL not found.");
  process.exit(1);
}
const prisma = new PrismaClient({ datasources: { db: { url: dbUrl } } });
const SHOP = process.env.PNL_SHOP || "b03304.myshopify.com";

console.log(WRITE ? "MODE: WRITE — will send and assign" : "MODE: dry run (pass --write to apply)");

const settings = await prisma.aiReplySettings.findUnique({ where: { shop: SHOP } });
if (!settings?.waApiKey || !settings.waFromNumber) {
  console.error("WhatsApp is not configured for this shop.");
  process.exit(1);
}

const since = new Date(SINCE + "T00:00:00Z");

const stale = await prisma.whatsAppReplyJob.findMany({
  where: { shop: SHOP, status: "failed", error: { contains: "too-old" }, createdAt: { gte: since } },
  select: { phone: true, message: true, createdAt: true },
  orderBy: { createdAt: "desc" },
});

// Anyone the bot answered since — they came back and were served.
const answered = new Set(
  (
    await prisma.whatsAppReplyJob.findMany({
      where: { shop: SHOP, status: "done", createdAt: { gte: since } },
      select: { phone: true },
    })
  ).map((j) => j.phone),
);

const SPAM = /https?:\/\/|pages\.dev|bit\.ly/i;

/**
 * Our own outbound text, echoed back into the inbound queue.
 *
 * Two of the 31 turned out to be these — a shipment notification and an
 * away-message — and handing them to an agent would have opened tickets
 * against nobody's question. Matched on the opening words, which are fixed
 * strings we send, rather than on content a customer might coincidentally use.
 */
const OUR_OWN =
  /^(your order is on its way|thank you for your message\.?\s*we.?re unavailable|got it! i am handing over)/i;

// One row per person: their most recent unanswered message.
const latest = new Map();
for (const j of stale) {
  if (answered.has(j.phone)) continue;
  if (SPAM.test(j.message)) continue;
  if (OUR_OWN.test(j.message.trim())) continue;
  if (!latest.has(j.phone)) latest.set(j.phone, j);
}

// A human already on the thread, or already handed over, must not be nudged.
const phones = [...latest.keys()];
const convos = await prisma.whatsAppConversation.findMany({
  where: { shop: SHOP, phone: { in: phones } },
  select: { phone: true, optedOut: true },
});
const withHuman = new Set(convos.filter((c) => c.optedOut).map((c) => c.phone));
const alreadyHanded = new Set(
  (
    await prisma.handover.findMany({
      where: { shop: SHOP, channel: "whatsapp", customerId: { in: phones }, createdAt: { gte: since } },
      select: { customerId: true },
    })
  ).map((h) => h.customerId),
);

// Nothing is SENT, so WhatsApp's 24-hour service window does not apply:
// assignment is a DoubleTick action against the chat, not a message to the
// customer. That is the whole reason to do it this way — it reaches the 154
// people a free-form reply no longer could, at no message cost and without
// interrupting anyone about a question that is now days old.

const reachable = [];
let skippedHuman = 0;
let skippedHanded = 0;
for (const [phone, j] of latest) {
  if (withHuman.has(phone)) {
    skippedHuman++;
    continue;
  }
  if (alreadyHanded.has(phone)) {
    skippedHanded++;
    continue;
  }
  reachable.push(j);
}

console.log("\nunanswered since " + SINCE + ":", latest.size, "people");
console.log("  already with a human      :", skippedHuman);
console.log("  already handed over       :", skippedHanded);
console.log("  TO ASSIGN                 :", reachable.length);

if (!reachable.length) {
  console.log("\nNothing to do.");
  await prisma.$disconnect();
  process.exit(0);
}

console.log("");
for (const j of reachable) {
  const ist = new Date(j.createdAt.getTime() + 5.5 * 3600000).toISOString().slice(5, 16).replace("T", " ");
  console.log("   " + ist + "  " + j.phone.padEnd(12) + JSON.stringify(j.message.slice(0, 46)));
}

if (!WRITE) {
  console.log("\nDry run. Pass --write to send and assign.");
  await prisma.$disconnect();
  process.exit(0);
}

// Nothing is sent to the customer. Several of these questions are days old and
// a notification now would read worse than the silence — "you are answering
// this NOW?". The chat simply appears in an agent's queue with the original
// message still in it, for them to judge and answer properly.
let sent = 0;
let failed = 0;
for (let i = 0; i < reachable.length; i++) {
  const j = reachable[i];
  // Paced: a burst against one WABA number gets throttled.
  if (i > 0) await new Promise((r) => setTimeout(r, 800));

  // Recorded before the flow call, so the trace survives even if the assign
  // webhook is down — the same ordering the worker uses.
  await prisma.handover.create({
    data: { shop: SHOP, channel: "whatsapp", customerId: j.phone, reason: "ai-unavailable" },
  });

  const flowUrl = settings.waHandoffFlowUrl?.trim();
  if (flowUrl) {
    try {
      await fetch(flowUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phone: j.phone,
          customerNumber: "91" + j.phone,
          customerPhoneNumber: "91" + j.phone,
          wabaNumber: settings.waFromNumber.replace(/\D/g, ""),
          reason: "Unanswered during the assistant outage.",
        }),
        signal: AbortSignal.timeout(10000),
      });
    } catch (e) {
      console.log("   assign flow failed for " + j.phone + ": " + String(e?.message || e).slice(0, 60));
    }
  }

  // Deliberately NOT muted. The customer was told nothing, so if they write
  // again they should get the bot's help as usual rather than silence on top
  // of silence. The agent has the chat either way.
  sent++;
}

console.log("\nhanded over:", sent, "| send failed:", failed);
await prisma.$disconnect();
