-- When the courier says an RTO arrived back with us. Read from the tracking
-- sheet's Delivered Date column, which was previously discarded on import.
--
-- This is the clock a courier claim runs on. deliveredAt is null on every RTO
-- row, and deliverySyncedAt only records when our sync ran (7,243 orders share
-- one such day), so neither can date a return.
ALTER TABLE "OrderFinancials" ADD COLUMN IF NOT EXISTS "rtoReceivedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "OrderFinancials_shop_rtoReceivedAt_idx"
  ON "OrderFinancials"("shop", "rtoReceivedAt");
