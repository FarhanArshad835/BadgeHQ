-- Cached ReturnHQ counts per month (returns + exchanges), mapped to the ORDER's
-- month. Refreshed by the P&L cron twice daily; the dashboard reads this instead
-- of querying ReturnHQ live on every load. Idempotent.
CREATE TABLE IF NOT EXISTS "ReturnHqCache" (
  "id"        TEXT NOT NULL,
  "shop"      TEXT NOT NULL,
  "month"     TEXT NOT NULL,
  "returns"   INTEGER NOT NULL DEFAULT 0,
  "exchanges" INTEGER NOT NULL DEFAULT 0,
  "syncedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ReturnHqCache_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "ReturnHqCache_shop_month_key" ON "ReturnHqCache"("shop", "month");
