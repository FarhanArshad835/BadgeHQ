-- Record inbound messages the bot deliberately did not answer.
--
-- Every skip decision (muted thread, rate limit, non-Indian number, non-text
-- message, feature switched off) happens in the webhook, before a reply job
-- row exists — so none of them left any trace. A merchant asking "why did it
-- not reply to this customer" had nothing to look at, and the answer was only
-- reachable by reading Vercel logs.
--
-- Rows are pruned by the existing cron sweep, so this cannot grow unbounded.
CREATE TABLE IF NOT EXISTS "WhatsAppSkip" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "preview" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WhatsAppSkip_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "WhatsAppSkip_shop_createdAt_idx" ON "WhatsAppSkip"("shop", "createdAt");
