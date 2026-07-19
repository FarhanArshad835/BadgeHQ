-- WhatsApp delivery for Back in Stock (Interakt or DoubleTick).
ALTER TABLE "BackInStockSubscription" ADD COLUMN IF NOT EXISTS "phone" TEXT NOT NULL DEFAULT '';

ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waProvider" TEXT NOT NULL DEFAULT 'interakt';
ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waApiKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waTemplateName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waLanguageCode" TEXT NOT NULL DEFAULT 'en';
ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waFromNumber" TEXT NOT NULL DEFAULT '';
