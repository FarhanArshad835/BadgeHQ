-- Make the WhatsApp thread-context limits configurable per shop.
--
-- These were hardcoded, but they are the dominant input cost after the
-- knowledge base and the right value is shop-specific: a store with long
-- troubleshooting threads needs more history than one answering quick sizing
-- questions, and the token budget differs with each merchant's LLM plan.
--
-- waThreadOpening is new behaviour, not just a knob: with only the newest N
-- messages, a 60-message thread lost its opening entirely — which is where the
-- order number and the original problem usually are. Keeping a few from the
-- start plus the recent ones covers both ends for roughly the same tokens.
--
-- Defaults match the previously hardcoded values, so nothing changes for
-- existing shops until they choose otherwise. Idempotent, per house style.
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waThreadRecent" INTEGER NOT NULL DEFAULT 20;
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waThreadOpening" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waThreadLineChars" INTEGER NOT NULL DEFAULT 400;
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waThreadTotalChars" INTEGER NOT NULL DEFAULT 4000;
