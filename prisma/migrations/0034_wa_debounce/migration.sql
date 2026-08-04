-- Configurable debounce for rapid message bursts.
--
-- How long the bot waits for a customer to finish sending a burst before
-- replying once to all of it. Shared by WhatsApp and Instagram. 0 disables
-- debouncing (reply to each message immediately).
--
-- Defaults to 6s (the previous hard-coded value), so behaviour is unchanged.
-- Idempotent, matching every migration since 0008.
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waDebounceSeconds" INTEGER NOT NULL DEFAULT 6;
