-- Published-to-web CSV URL of the delivery-status sheet, so the app can fetch
-- delivery outcome directly (no Google auth, no manual upload). Idempotent.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "deliverySheetUrl"      TEXT NOT NULL DEFAULT '';
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "deliverySheetSyncedAt" TIMESTAMP(3);
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "deliverySheetStatus"   TEXT NOT NULL DEFAULT '';
