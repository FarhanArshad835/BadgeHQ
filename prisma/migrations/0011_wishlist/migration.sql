CREATE TABLE IF NOT EXISTS "WishlistSettings" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "shop"             TEXT NOT NULL,
  "isEnabled"        BOOLEAN NOT NULL DEFAULT false,
  "showOnCards"      BOOLEAN NOT NULL DEFAULT true,
  "cardPosition"     TEXT NOT NULL DEFAULT 'top-right',
  "showOnProduct"    BOOLEAN NOT NULL DEFAULT true,
  "productPlacement" TEXT NOT NULL DEFAULT 'below-atc',
  "showHeader"       BOOLEAN NOT NULL DEFAULT true,
  "iconColor"        TEXT NOT NULL DEFAULT '#e74c3c',
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "WishlistSettings_shop_key" ON "WishlistSettings"("shop");

CREATE TABLE IF NOT EXISTS "Wishlist" (
  "id"         TEXT NOT NULL PRIMARY KEY,
  "shop"       TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "handles"    TEXT NOT NULL DEFAULT '[]',
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Wishlist_shop_customerId_key" ON "Wishlist"("shop", "customerId");
