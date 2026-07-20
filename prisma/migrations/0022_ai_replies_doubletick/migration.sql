-- Automated Replies over DoubleTick, alongside the existing Interakt path.
--
-- waProvider   picks the send/receive adapter. Defaults to "interakt" so every
--              shop already configured keeps working untouched.
-- waFromNumber DoubleTick's send API requires a `from` sender number; Interakt
--              infers it from the account.
-- waWebhookAuth DoubleTick signs nothing. At registration we hand it a bearer
--              token which it echoes back on every delivery, so this column is
--              what the webhook route compares instead of an HMAC.
--
-- Idempotent: re-running is a no-op, matching every migration since 0008.
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waProvider" TEXT NOT NULL DEFAULT 'interakt';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waFromNumber" TEXT NOT NULL DEFAULT '';
ALTER TABLE "AiReplySettings" ADD COLUMN IF NOT EXISTS "waWebhookAuth" TEXT NOT NULL DEFAULT '';
