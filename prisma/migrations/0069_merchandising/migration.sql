-- Collection merchandising: rank products by sales, reviews, newness and
-- stock, then write that order back to Shopify as Manual sort.
--
-- Smart collections accept a manual sort order (verified on this store:
-- "2 FOR 1299 Heels" has price rules AND sortOrder MANUAL), so Shopify keeps
-- deciding membership while this engine decides order.
--
-- ProductScore stores raw inputs unweighted so a weight change re-ranks
-- without re-reading Shopify, and so a merchant can see why a product ranks
-- where it does.

CREATE TABLE IF NOT EXISTS "MerchandiseSettings" (
  "id"               TEXT PRIMARY KEY,
  "shop"             TEXT NOT NULL,
  "isEnabled"        BOOLEAN NOT NULL DEFAULT false,
  "collectionIds"    TEXT NOT NULL DEFAULT '[]',
  "weightSales"      INTEGER NOT NULL DEFAULT 60,
  "weightReviews"    INTEGER NOT NULL DEFAULT 10,
  "weightNewArrival" INTEGER NOT NULL DEFAULT 15,
  "weightBehaviour"  INTEGER NOT NULL DEFAULT 15,
  "useSales"         BOOLEAN NOT NULL DEFAULT true,
  "useReviews"       BOOLEAN NOT NULL DEFAULT true,
  "useNewArrival"    BOOLEAN NOT NULL DEFAULT true,
  "useBehaviour"     BOOLEAN NOT NULL DEFAULT false,
  "newArrivalDays"   INTEGER NOT NULL DEFAULT 30,
  "salesWindowDays"  INTEGER NOT NULL DEFAULT 30,
  "sinkOutOfStock"   BOOLEAN NOT NULL DEFAULT true,
  "lastRunAt"        TIMESTAMP(3),
  "lastRunStatus"    TEXT NOT NULL DEFAULT '',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "MerchandiseSettings_shop_key" ON "MerchandiseSettings"("shop");

CREATE TABLE IF NOT EXISTS "ProductScore" (
  "id"             TEXT PRIMARY KEY,
  "shop"           TEXT NOT NULL,
  "productId"      TEXT NOT NULL,
  "unitsSold"      INTEGER NOT NULL DEFAULT 0,
  "reviewCount"    INTEGER NOT NULL DEFAULT 0,
  "publishedAt"    TIMESTAMP(3),
  "inStock"        BOOLEAN NOT NULL DEFAULT true,
  "behaviourScore" INTEGER NOT NULL DEFAULT 0,
  "score"          INTEGER NOT NULL DEFAULT 0,
  "updatedAt"      TIMESTAMP(3) NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "ProductScore_shop_productId_key" ON "ProductScore"("shop","productId");
CREATE INDEX IF NOT EXISTS "ProductScore_shop_score_idx" ON "ProductScore"("shop","score");
