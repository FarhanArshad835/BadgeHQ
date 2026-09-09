-- "2 for Rs1299" style bundle offers. Promotional only: the discount itself is
-- a Shopify automatic discount the merchant already configured, and this table
-- only drives what the shopper is told about it.
CREATE TABLE "BundleOffer" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER NOT NULL DEFAULT 2,
    "scope" TEXT NOT NULL DEFAULT 'all',
    "collectionHandle" TEXT NOT NULL DEFAULT '',
    "productHandles" TEXT NOT NULL DEFAULT '[]',
    "messages" TEXT NOT NULL DEFAULT '{"below":"Add {{remaining}} more to unlock {{title}}","reached":"{{title}} unlocked!"}',
    "colors" TEXT NOT NULL DEFAULT '{"barBg":"#f0f0f0","progressBg":"#4caf50","text":"#333333"}',
    "showProgress" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "pages" TEXT NOT NULL DEFAULT '["cart","product"]',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BundleOffer_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "BundleOffer_shop_idx" ON "BundleOffer"("shop");
