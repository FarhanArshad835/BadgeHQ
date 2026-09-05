-- Wishlist -> Meta Conversions API, plus the event history the CSV export needs.

-- Per-shop CAPI credentials. The dataset id is public (it ships to the pixel);
-- the access token is server-side only.
ALTER TABLE "WishlistSettings" ADD COLUMN IF NOT EXISTS "capiEnabled"     BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "WishlistSettings" ADD COLUMN IF NOT EXISTS "capiDatasetId"   TEXT    NOT NULL DEFAULT '';
ALTER TABLE "WishlistSettings" ADD COLUMN IF NOT EXISTS "capiAccessToken" TEXT    NOT NULL DEFAULT '';
-- Off until Shopify approves Protected Customer Data Level 2 (request #106713).
ALTER TABLE "WishlistSettings" ADD COLUMN IF NOT EXISTS "capiSendEmail"   BOOLEAN NOT NULL DEFAULT false;

-- Event history. The Wishlist row is a destructive upsert of current state, so
-- it cannot say WHEN something was saved or whether Meta received it.
CREATE TABLE IF NOT EXISTS "WishlistEvent" (
  "id"         TEXT NOT NULL,
  "shop"       TEXT NOT NULL,
  "customerId" TEXT NOT NULL DEFAULT '',
  "handle"     TEXT NOT NULL,
  "productId"  TEXT NOT NULL DEFAULT '',
  "action"     TEXT NOT NULL DEFAULT 'add',
  "metaStatus" TEXT NOT NULL DEFAULT 'pending',
  "metaError"  TEXT NOT NULL DEFAULT '',
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WishlistEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "WishlistEvent_shop_createdAt_idx"  ON "WishlistEvent"("shop", "createdAt");
CREATE INDEX IF NOT EXISTS "WishlistEvent_shop_metaStatus_idx" ON "WishlistEvent"("shop", "metaStatus");
