-- P&L / profit dashboard — Phase 1 (revenue + COGS + actual shipping).
--
-- Money is stored in integer MINOR UNITS (paise) as BIGINT — never float — so
-- sums are exact. A NULL cost means "not known yet" (Pending / cost-per-item
-- missing), never zero and never an estimate.
--
-- Carrier credentials are reused from AiReplySettings/DeliverySettings; only
-- the Meta Ads creds (Phase 2) live on PnlSettings.
--
-- Idempotent, matching every migration since 0008.

CREATE TABLE IF NOT EXISTS "PnlSettings" (
  "id"              TEXT NOT NULL,
  "shop"            TEXT NOT NULL,
  "isEnabled"       BOOLEAN NOT NULL DEFAULT false,
  "metaEnabled"     BOOLEAN NOT NULL DEFAULT false,
  "metaAccessToken" TEXT NOT NULL DEFAULT '',
  "metaAdAccountId" TEXT NOT NULL DEFAULT '',
  "lastSyncAt"      TIMESTAMP(3),
  "lastSyncStatus"  TEXT NOT NULL DEFAULT '',
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PnlSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PnlSettings_shop_key" ON "PnlSettings"("shop");

CREATE TABLE IF NOT EXISTS "OrderFinancials" (
  "id"                TEXT NOT NULL,
  "shop"              TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "orderName"         TEXT NOT NULL DEFAULT '',
  "orderCreatedAt"    TIMESTAMP(3) NOT NULL,
  "currency"          TEXT NOT NULL DEFAULT 'INR',
  "grossRevenueMinor" BIGINT NOT NULL DEFAULT 0,
  "refundsMinor"      BIGINT NOT NULL DEFAULT 0,
  "discountsMinor"    BIGINT NOT NULL DEFAULT 0,
  "cogsMinor"         BIGINT,
  "cogsComplete"      BOOLEAN NOT NULL DEFAULT false,
  "shippingCostMinor" BIGINT,
  "shippingStatus"    TEXT NOT NULL DEFAULT 'pending',
  "rtoCostMinor"      BIGINT,
  "codChargeMinor"    BIGINT,
  "awb"               TEXT NOT NULL DEFAULT '',
  "carrier"           TEXT NOT NULL DEFAULT '',
  "financialStatus"   TEXT NOT NULL DEFAULT '',
  "fulfillmentStatus" TEXT NOT NULL DEFAULT '',
  "dataComplete"      BOOLEAN NOT NULL DEFAULT false,
  "revenueSyncedAt"   TIMESTAMP(3),
  "cogsSyncedAt"      TIMESTAMP(3),
  "shippingSyncedAt"  TIMESTAMP(3),
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OrderFinancials_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrderFinancials_shop_orderId_key" ON "OrderFinancials"("shop", "orderId");
CREATE INDEX IF NOT EXISTS "OrderFinancials_shop_orderCreatedAt_idx" ON "OrderFinancials"("shop", "orderCreatedAt");
CREATE INDEX IF NOT EXISTS "OrderFinancials_shop_shippingStatus_idx" ON "OrderFinancials"("shop", "shippingStatus");
CREATE INDEX IF NOT EXISTS "OrderFinancials_awb_idx" ON "OrderFinancials"("awb");

CREATE TABLE IF NOT EXISTS "OrderLineFinancials" (
  "id"               TEXT NOT NULL,
  "shop"             TEXT NOT NULL,
  "orderId"          TEXT NOT NULL,
  "orderCreatedAt"   TIMESTAMP(3) NOT NULL,
  "productId"        TEXT NOT NULL DEFAULT '',
  "variantId"        TEXT NOT NULL DEFAULT '',
  "productTitle"     TEXT NOT NULL DEFAULT '',
  "variantTitle"     TEXT NOT NULL DEFAULT '',
  "quantity"         INTEGER NOT NULL DEFAULT 0,
  "lineRevenueMinor" BIGINT NOT NULL DEFAULT 0,
  "lineCogsMinor"    BIGINT,
  "lineCogsComplete" BOOLEAN NOT NULL DEFAULT false,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OrderLineFinancials_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "OrderLineFinancials_shop_productId_orderCreatedAt_idx" ON "OrderLineFinancials"("shop", "productId", "orderCreatedAt");
CREATE INDEX IF NOT EXISTS "OrderLineFinancials_shop_orderId_idx" ON "OrderLineFinancials"("shop", "orderId");
