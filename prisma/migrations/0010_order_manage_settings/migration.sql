CREATE TABLE IF NOT EXISTS "OrderManageSettings" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "shop"             TEXT NOT NULL,
  "isEnabled"        BOOLEAN NOT NULL DEFAULT false,
  "allowCancel"      BOOLEAN NOT NULL DEFAULT true,
  "cancelScope"      TEXT NOT NULL DEFAULT 'unpaid',
  "allowAddressEdit" BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrderManageSettings_shop_key" ON "OrderManageSettings"("shop");
