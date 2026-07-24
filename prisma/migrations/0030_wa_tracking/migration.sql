-- Live parcel tracking for the WhatsApp support bot.
--
-- When a shopper asks "where's my order?", the bot pulls the AWB from the
-- conversation (the merchant's flow bot already posts order number + AWB) and
-- asks the carrier for a live status, which it hands to the LLM to phrase.
--
-- Shiprocket (~70% of jmlooks parcels) needs panel email + password. The
-- Delhivery key is reused from DeliverySettings.apiToken (the storefront
-- delivery-estimate feature already stores it), so no Delhivery column here.
--
-- Defaults keep tracking off and creds empty, so existing shops are untouched.
-- Idempotent, matching every migration since 0008.
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waTrackingEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waShiprocketEmail" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waShiprocketPassword" TEXT NOT NULL DEFAULT '';
