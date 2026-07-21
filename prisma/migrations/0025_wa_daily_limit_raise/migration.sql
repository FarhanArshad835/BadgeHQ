-- Raise the daily AI-reply ceiling from 150 to 2000.
--
-- 150 was set counting REPLIES as though a conversation were a single reply.
-- Real support threads run 8-20 replies, so 150 capped a shop at roughly 19
-- conversations and then went silent mid-thread — worse for a shopper than
-- never having replied at all.
--
-- Cost is not linear in replies either: the conversation history sent with
-- each reply grows as the thread does, so a 20-reply thread costs ~43K tokens
-- rather than 20x a single reply.
--
-- 2000 replies is roughly 250 conversations a day: headroom over normal volume
-- while still stopping a runaway loop from draining the merchant's quota.
--
-- The UPDATE only moves shops still on the old default; anything a merchant
-- deliberately set is left alone. Idempotent, matching every migration since 0008.
ALTER TABLE "AiReplySettings" ALTER COLUMN "waDailyLimit" SET DEFAULT 2000;
UPDATE "AiReplySettings" SET "waDailyLimit" = 2000 WHERE "waDailyLimit" = 150;
