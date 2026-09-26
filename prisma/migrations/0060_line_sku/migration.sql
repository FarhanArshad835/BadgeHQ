-- Variant SKU on each order line: the merchant's own product code, and how
-- they actually identify stock. Blank on lines synced before this was
-- captured, so a re-sync is what fills it in for past months.
ALTER TABLE "OrderLineFinancials" ADD COLUMN IF NOT EXISTS "sku" TEXT NOT NULL DEFAULT '';
