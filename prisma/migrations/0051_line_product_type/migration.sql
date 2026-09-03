-- Product type per line, so GST is charged at the line's own rate rather than
-- one blended rate across a catalogue that spans 5% and 18% categories.
ALTER TABLE "OrderLineFinancials" ADD COLUMN IF NOT EXISTS "productType" TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS "OrderLineFinancials_shop_productType_idx"
    ON "OrderLineFinancials"("shop", "productType");

-- The GST rates, editable rather than hard-coded. 500 = 5%, 1800 = 18%.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstHighRateBp"    INTEGER NOT NULL DEFAULT 1800;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstHighTypes"     TEXT    NOT NULL DEFAULT 'Bags';
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstStandardRateBp" INTEGER NOT NULL DEFAULT 500;

-- India's footwear slab: above Rs1,000 per pair the rate is 12%, not 5%.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstMidRateBp" INTEGER NOT NULL DEFAULT 1200;
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "gstFootwearThresholdMinor" BIGINT NOT NULL DEFAULT 100000;
