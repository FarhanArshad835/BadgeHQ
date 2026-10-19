-- Behaviour counters for collection ranking.
--
-- One row per product per day, incremented in place. NOT an event log: at
-- ~100k visitors/day a row per event is ~12M rows/month, which keeps Neon
-- compute awake continuously and grows without bound. Counters hold the table
-- at roughly (products x retained days).
CREATE TABLE IF NOT EXISTS "ProductBehaviour" (
  "id"          TEXT PRIMARY KEY,
  "shop"        TEXT NOT NULL,
  "productId"   TEXT NOT NULL,
  "day"         TIMESTAMP(3) NOT NULL,
  "views"       INTEGER NOT NULL DEFAULT 0,
  "dwell30"     INTEGER NOT NULL DEFAULT 0,
  "cartAdds"    INTEGER NOT NULL DEFAULT 0,
  "cartRemoves" INTEGER NOT NULL DEFAULT 0,
  "wishAdds"    INTEGER NOT NULL DEFAULT 0,
  "wishRemoves" INTEGER NOT NULL DEFAULT 0,
  "updatedAt"   TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductBehaviour_shop_productId_day_key"
  ON "ProductBehaviour"("shop","productId","day");
CREATE INDEX IF NOT EXISTS "ProductBehaviour_shop_day_idx"
  ON "ProductBehaviour"("shop","day");
