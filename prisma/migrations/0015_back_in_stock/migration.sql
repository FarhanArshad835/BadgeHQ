CREATE TABLE IF NOT EXISTS "BackInStockSettings" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "shop"        TEXT NOT NULL,
  "isEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "placement"   TEXT NOT NULL DEFAULT 'below-atc',
  "buttonText"  TEXT NOT NULL DEFAULT 'Notify me when available',
  "headingText" TEXT NOT NULL DEFAULT 'Get notified when this is back',
  "consentText" TEXT NOT NULL DEFAULT 'We''ll email you when it''s back in stock. You''ll also receive our emails — unsubscribe anytime.',
  "successText" TEXT NOT NULL DEFAULT 'Done! We''ll email you when it''s back in stock.',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "BackInStockSettings_shop_key" ON "BackInStockSettings"("shop");

CREATE TABLE IF NOT EXISTS "BackInStockSubscription" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "shop"       TEXT NOT NULL,
  "variantId"  TEXT NOT NULL,
  "productId"  TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "customerId" TEXT,
  "notifiedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "BackInStockSubscription_shop_variantId_email_key"
  ON "BackInStockSubscription"("shop", "variantId", "email");
CREATE INDEX IF NOT EXISTS "BackInStockSubscription_shop_variantId_idx"
  ON "BackInStockSubscription"("shop", "variantId");
CREATE INDEX IF NOT EXISTS "BackInStockSubscription_shop_idx"
  ON "BackInStockSubscription"("shop");
