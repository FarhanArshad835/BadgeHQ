-- Instagram DM support for the AI reply bot (Meta Graph API, direct).
--
-- Same AI brain and knowledge base as WhatsApp; a separate transport and a
-- channel-agnostic identity model (customers keyed by an opaque platform id,
-- not a phone). The WhatsApp tables are untouched — Instagram is additive so
-- the live WhatsApp bot carries no risk.
--
-- Idempotent, matching every migration since 0008.

-- Instagram settings on the existing AI-replies row.
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "igEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "igPageId" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "igAccessToken" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "igAppSecret" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "igWebhookToken" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "igVerifyToken" TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS "AiReplySettings_igWebhookToken_idx" ON "AiReplySettings"("igWebhookToken");

-- Channel-agnostic conversation, keyed by (shop, channel, customerId).
CREATE TABLE IF NOT EXISTS "SocialConversation" (
  "id"            TEXT NOT NULL,
  "shop"          TEXT NOT NULL,
  "channel"       TEXT NOT NULL,
  "customerId"    TEXT NOT NULL,
  "turns"         TEXT NOT NULL DEFAULT '[]',
  "optedOut"      BOOLEAN NOT NULL DEFAULT false,
  "mutedUntil"    TIMESTAMP(3),
  "windowCount"   INTEGER NOT NULL DEFAULT 0,
  "windowStart"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastInboundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialConversation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SocialConversation_shop_channel_customerId_key"
  ON "SocialConversation"("shop", "channel", "customerId");
CREATE INDEX IF NOT EXISTS "SocialConversation_updatedAt_idx" ON "SocialConversation"("updatedAt");

-- Inbound social DM awaiting a reply.
CREATE TABLE IF NOT EXISTS "SocialReplyJob" (
  "id"                TEXT NOT NULL,
  "shop"              TEXT NOT NULL,
  "channel"           TEXT NOT NULL,
  "customerId"        TEXT NOT NULL,
  "message"           TEXT NOT NULL,
  "providerMessageId" TEXT NOT NULL,
  "status"            TEXT NOT NULL DEFAULT 'pending',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "error"             TEXT NOT NULL DEFAULT '',
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SocialReplyJob_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "SocialReplyJob_shop_channel_providerMessageId_key"
  ON "SocialReplyJob"("shop", "channel", "providerMessageId");
CREATE INDEX IF NOT EXISTS "SocialReplyJob_status_createdAt_idx" ON "SocialReplyJob"("status", "createdAt");

-- Skips, for "why didn't it reply" visibility.
CREATE TABLE IF NOT EXISTS "SocialSkip" (
  "id"         TEXT NOT NULL,
  "shop"       TEXT NOT NULL,
  "channel"    TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "reason"     TEXT NOT NULL,
  "preview"    TEXT NOT NULL DEFAULT '',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SocialSkip_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "SocialSkip_shop_createdAt_idx" ON "SocialSkip"("shop", "createdAt");
