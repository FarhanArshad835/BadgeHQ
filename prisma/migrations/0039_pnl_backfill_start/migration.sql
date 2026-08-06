-- Fixed calendar-month backfill start for the P&L sync. The old sync used a
-- rolling 90-day window, which cut off the start of May (only pulled from May 8)
-- and drifted later every day. This anchors the backfill to a fixed month so
-- complete calendar months are always covered.
--
-- Idempotent.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "backfillStartMonth" TEXT NOT NULL DEFAULT '2026-04';

-- Reset the stale in-progress window (it was anchored at May 8) so the next sync
-- re-opens from the fixed April-1 start and picks up the orders it missed.
UPDATE "PnlApp" SET "syncCursor" = NULL, "syncWindowStart" = NULL, "syncWindowEnd" = NULL WHERE "id" = 'default';
