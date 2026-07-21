-- Give automatic handoff mutes an expiry.
--
-- When the bot escalates a complaint it sets optedOut so a human can work the
-- thread uninterrupted. That was permanent: only the shopper typing "start"
-- could clear it, which no real shopper knows to do. One complaint therefore
-- silenced the bot for that number forever, including for unrelated questions
-- later, and a merchant resolving the chat in DoubleTick did not clear it.
--
-- mutedUntil NULL keeps the old meaning (permanent — an explicit "stop"), so
-- deliberate opt-outs are unaffected.
--
-- Existing rows: clear automatic mutes older than a day. They were set by the
-- escalation path, and leaving them permanent is the bug being fixed.
ALTER TABLE "WhatsAppConversation" ADD COLUMN IF NOT EXISTS "mutedUntil" TIMESTAMP(3);
UPDATE "WhatsAppConversation"
   SET "optedOut" = false
 WHERE "optedOut" = true
   AND "updatedAt" < NOW() - INTERVAL '1 day';
