-- Stocking cost computed from the delivered order lines (free product that still
-- costs us to supply), instead of a figure typed in each month.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "stockingMatch"         TEXT   NOT NULL DEFAULT '';
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "stockingUnitCostMinor" BIGINT NOT NULL DEFAULT 6000;
