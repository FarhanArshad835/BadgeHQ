-- AI replies over WhatsApp (Interakt inbound).
--
-- The storefront chat and the WhatsApp bot share one knowledge base and one
-- Gemini key, so the settings live alongside the existing AI reply fields.
-- Only the delivery path is new.

ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waReplyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waApiKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waWebhookSecret" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waWebhookToken" TEXT NOT NULL DEFAULT '';

-- Lookup index for the webhook route (shop is resolved by token alone).
CREATE INDEX IF NOT EXISTS "AiReplySettings_waWebhookToken_idx"
  ON "AiReplySettings"("waWebhookToken");

-- Uniqueness must be PARTIAL. Every shop that has not generated a token yet
-- shares the '' default, so a plain UNIQUE index would reject the second such
-- row and break saving AI settings for everyone.
CREATE UNIQUE INDEX IF NOT EXISTS "AiReplySettings_waWebhookToken_key"
  ON "AiReplySettings"("waWebhookToken") WHERE "waWebhookToken" <> '';

-- One rolling thread per shopper, purged once it goes cold.
CREATE TABLE IF NOT EXISTS "WhatsAppConversation" (
  "id"            TEXT NOT NULL,
  "shop"          TEXT NOT NULL,
  "phone"         TEXT NOT NULL,
  "turns"         TEXT NOT NULL DEFAULT '[]',
  "optedOut"      BOOLEAN NOT NULL DEFAULT false,
  "windowCount"   INTEGER NOT NULL DEFAULT 0,
  "windowStart"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsAppConversation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppConversation_shop_phone_key"
  ON "WhatsAppConversation"("shop", "phone");
CREATE INDEX IF NOT EXISTS "WhatsAppConversation_updatedAt_idx"
  ON "WhatsAppConversation"("updatedAt");

-- Inbound message queue. Interakt requires a 200 within 3s and never retries,
-- so the webhook durably records the message and the cron does the slow work.
CREATE TABLE IF NOT EXISTS "WhatsAppReplyJob" (
  "id"                TEXT NOT NULL,
  "shop"              TEXT NOT NULL,
  "phone"             TEXT NOT NULL,
  "message"           TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "error"             TEXT NOT NULL DEFAULT '',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WhatsAppReplyJob_pkey" PRIMARY KEY ("id")
);

-- Interakt can redeliver a webhook; replying twice to one message is worse than
-- not replying, so the provider's message id is the idempotency key.
CREATE UNIQUE INDEX IF NOT EXISTS "WhatsAppReplyJob_shop_providerMessageId_key"
  ON "WhatsAppReplyJob"("shop", "providerMessageId");
CREATE INDEX IF NOT EXISTS "WhatsAppReplyJob_status_createdAt_idx"
  ON "WhatsAppReplyJob"("status", "createdAt");
