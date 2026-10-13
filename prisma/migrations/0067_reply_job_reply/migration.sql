-- The activity table showed what a shopper asked but not what they were told,
-- so a complaint could not be checked without opening WhatsApp. The reply was
-- never stored: the job row holds only the inbound message, and the
-- conversation's turns are purged after 24 hours.
ALTER TABLE "WhatsAppReplyJob" ADD COLUMN IF NOT EXISTS "reply" TEXT NOT NULL DEFAULT '';
