-- Flag ReturnHQ exchange-fee orders so the fee line can count the flat fee on
-- EVERY request (returns and exchanges), not just returns. Exchange fee orders
-- stay real sales, so only the fee portion is added - never the whole order.
ALTER TABLE "OrderFinancials" ADD COLUMN IF NOT EXISTS "isExchangeFee" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS "OrderFinancials_shop_isExchangeFee_idx"
    ON "OrderFinancials"("shop", "isExchangeFee");

-- The flat per-request fee, so it isn't hard-coded where it can't be changed.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "returnRequestFeeMinor" BIGINT NOT NULL DEFAULT 10000;
