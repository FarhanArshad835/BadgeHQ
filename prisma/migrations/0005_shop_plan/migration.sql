CREATE TABLE IF NOT EXISTS "ShopPlan" (
  "id"        TEXT NOT NULL PRIMARY KEY,
  "shop"      TEXT NOT NULL,
  "plan"      TEXT NOT NULL DEFAULT 'free',
  "billingId" TEXT,
  "status"    TEXT NOT NULL DEFAULT 'active',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "ShopPlan_shop_key" ON "ShopPlan"("shop");
