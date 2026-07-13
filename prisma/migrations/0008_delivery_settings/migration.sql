CREATE TABLE IF NOT EXISTS "DeliverySettings" (
  "id"          TEXT NOT NULL PRIMARY KEY,
  "shop"        TEXT NOT NULL,
  "isEnabled"   BOOLEAN NOT NULL DEFAULT false,
  "apiToken"    TEXT NOT NULL DEFAULT '',
  "originPin"   TEXT NOT NULL DEFAULT '',
  "bufferDays"  INTEGER NOT NULL DEFAULT 1,
  "environment" TEXT NOT NULL DEFAULT 'staging',
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "DeliverySettings_shop_key" ON "DeliverySettings"("shop");
