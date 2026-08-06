-- Monthly (delivered-basis) P&L: the correct 8-step method that replaces the
-- rolling placed-order view. Adds per-order delivery outcome, monthly-config
-- knobs on PnlApp, and the per-month input + computed-report tables.
--
-- Idempotent, matching every migration since 0008. Money is BIGINT (paise).

-- 1) Per-order delivery outcome (the delivered basis everything keys off).
ALTER TABLE "OrderFinancials" ADD COLUMN IF NOT EXISTS "deliveryStatus"   TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE "OrderFinancials" ADD COLUMN IF NOT EXISTS "deliveredAt"      TIMESTAMP(3);
ALTER TABLE "OrderFinancials" ADD COLUMN IF NOT EXISTS "deliverySyncedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "OrderFinancials_shop_deliveryStatus_idx" ON "OrderFinancials"("shop", "deliveryStatus");

-- 2) Monthly-P&L config knobs on PnlApp (fixed rates, editable in Settings).
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "opsPerPairMinor"   BIGINT  NOT NULL DEFAULT 2500;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstOutputRateBp"   INTEGER NOT NULL DEFAULT 487;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstInputRateNumer" INTEGER NOT NULL DEFAULT 18;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstInputRateDenom" INTEGER NOT NULL DEFAULT 118;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "maturityDays"      INTEGER NOT NULL DEFAULT 12;

-- 3) Per-month manual inputs (overhead, fees, optional overrides).
CREATE TABLE IF NOT EXISTS "PnlMonthlyInput" (
  "id"                      TEXT NOT NULL,
  "shop"                    TEXT NOT NULL,
  "month"                   TEXT NOT NULL,
  "overheadMinor"           BIGINT NOT NULL DEFAULT 0,
  "returnExchangeFeesMinor" BIGINT NOT NULL DEFAULT 0,
  "adSpendOverrideMinor"    BIGINT,
  "freightOverrideMinor"    BIGINT,
  "createdAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PnlMonthlyInput_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PnlMonthlyInput_shop_month_key" ON "PnlMonthlyInput"("shop", "month");

-- 4) Computed monthly-report cache (the full assembly for one month).
CREATE TABLE IF NOT EXISTS "PnlMonthlyReport" (
  "id"                       TEXT NOT NULL,
  "shop"                     TEXT NOT NULL,
  "month"                    TEXT NOT NULL,
  "grossSaleMinor"           BIGINT NOT NULL DEFAULT 0,
  "discountsMinor"           BIGINT NOT NULL DEFAULT 0,
  "netPlacedRevenueMinor"    BIGINT NOT NULL DEFAULT 0,
  "deliveredRevenueMinor"    BIGINT NOT NULL DEFAULT 0,
  "cancelledRtoRevenueMinor" BIGINT NOT NULL DEFAULT 0,
  "refundsMinor"             BIGINT NOT NULL DEFAULT 0,
  "netSaleMinor"             BIGINT NOT NULL DEFAULT 0,
  "placedOrders"             INTEGER NOT NULL DEFAULT 0,
  "deliveredOrders"          INTEGER NOT NULL DEFAULT 0,
  "rtoOrders"                INTEGER NOT NULL DEFAULT 0,
  "inTransitOrders"          INTEGER NOT NULL DEFAULT 0,
  "deliveredPairs"           INTEGER NOT NULL DEFAULT 0,
  "cogsMinor"                BIGINT,
  "cogsComplete"             BOOLEAN NOT NULL DEFAULT false,
  "freightMinor"             BIGINT,
  "freightSource"            TEXT NOT NULL DEFAULT '',
  "adSpendMinor"             BIGINT,
  "adSpendSource"            TEXT NOT NULL DEFAULT '',
  "opsMinor"                 BIGINT NOT NULL DEFAULT 0,
  "overheadMinor"            BIGINT NOT NULL DEFAULT 0,
  "gstOutputMinor"           BIGINT NOT NULL DEFAULT 0,
  "gstInputMinor"            BIGINT,
  "netGstMinor"              BIGINT,
  "returnExchangeFeesMinor"  BIGINT NOT NULL DEFAULT 0,
  "netPnlMinor"              BIGINT,
  "complete"                 BOOLEAN NOT NULL DEFAULT false,
  "matured"                  BOOLEAN NOT NULL DEFAULT false,
  "computedAt"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt"                TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PnlMonthlyReport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "PnlMonthlyReport_shop_month_key" ON "PnlMonthlyReport"("shop", "month");
CREATE INDEX IF NOT EXISTS "PnlMonthlyReport_shop_month_idx" ON "PnlMonthlyReport"("shop", "month");
