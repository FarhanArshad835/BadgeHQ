-- Resumable-sync state for the standalone P&L app.
--
-- A store doing ~2000 orders/week can't sync in one serverless invocation, and
-- doing so also runs up Neon compute hours. The nightly cron now chunks the
-- backlog across runs: it records the Shopify page cursor it stopped at within a
-- window and resumes there next run. These columns hold that state.
--
-- Idempotent, matching every migration since 0008.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "syncCursor"      TEXT;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "syncWindowStart" TIMESTAMP(3);
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "syncWindowEnd"   TIMESTAMP(3);
