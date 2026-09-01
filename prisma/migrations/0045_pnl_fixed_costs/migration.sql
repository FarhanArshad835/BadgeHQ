-- Monthly P&L statement: itemized fixed-cost lines + stocking (real billed
-- figures entered per month; they sum into the fixed-cost total).
ALTER TABLE "PnlMonthlyInput" ADD COLUMN IF NOT EXISTS "shopifySubscriptionMinor" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "PnlMonthlyInput" ADD COLUMN IF NOT EXISTS "shopifyBillingMinor"       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "PnlMonthlyInput" ADD COLUMN IF NOT EXISTS "doubleclickFeeMinor"       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "PnlMonthlyInput" ADD COLUMN IF NOT EXISTS "doubleclickSubMinor"       BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "PnlMonthlyInput" ADD COLUMN IF NOT EXISTS "stockingMinor"             BIGINT NOT NULL DEFAULT 0;
