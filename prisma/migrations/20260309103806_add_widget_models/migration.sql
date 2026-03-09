-- CreateTable
CREATE TABLE "TrustBadge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Trust Badges',
    "badges" TEXT NOT NULL DEFAULT '[]',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "position" TEXT NOT NULL DEFAULT 'after-add-to-cart',
    "pages" TEXT NOT NULL DEFAULT '["product"]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ProductBadge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT 'Sale',
    "shape" TEXT NOT NULL DEFAULT 'rectangle',
    "badgeColor" TEXT NOT NULL DEFAULT '#e74c3c',
    "textColor" TEXT NOT NULL DEFAULT '#ffffff',
    "position" TEXT NOT NULL DEFAULT 'top-left',
    "targeting" TEXT NOT NULL DEFAULT '{"type":"all"}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AnnouncementBar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "messages" TEXT NOT NULL DEFAULT '[{"text":"Welcome to our store!","emoji":""}]',
    "bgColor" TEXT NOT NULL DEFAULT '#000000',
    "textColor" TEXT NOT NULL DEFAULT '#ffffff',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showClose" BOOLEAN NOT NULL DEFAULT true,
    "pages" TEXT NOT NULL DEFAULT '["all"]',
    "schedule" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "FreeShippingBar" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "threshold" REAL NOT NULL DEFAULT 50.0,
    "messages" TEXT NOT NULL DEFAULT '{"below":"You''re {{amount}} away from free shipping!","reached":"Congratulations! You''ve earned free shipping!"}',
    "colors" TEXT NOT NULL DEFAULT '{"barBg":"#f0f0f0","progressBg":"#4caf50","text":"#333333"}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pages" TEXT NOT NULL DEFAULT '["cart","product"]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "StickyCart" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "buttonText" TEXT NOT NULL DEFAULT 'Add to Cart',
    "buttonColor" TEXT NOT NULL DEFAULT '#ffffff',
    "bgColor" TEXT NOT NULL DEFAULT '#000000',
    "showMobile" BOOLEAN NOT NULL DEFAULT true,
    "showDesktop" BOOLEAN NOT NULL DEFAULT true,
    "position" TEXT NOT NULL DEFAULT 'bottom',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "CountdownTimer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "endDate" DATETIME NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'full',
    "messages" TEXT NOT NULL DEFAULT '{"above":"Hurry! Sale ends in:","below":"Don''t miss out!"}',
    "colors" TEXT NOT NULL DEFAULT '{"bg":"#000000","text":"#ffffff","accent":"#e74c3c"}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pages" TEXT NOT NULL DEFAULT '["product"]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" TEXT NOT NULL DEFAULT '{"fontFamily":"inherit","colorScheme":"light"}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "TrustBadge_shop_idx" ON "TrustBadge"("shop");

-- CreateIndex
CREATE INDEX "ProductBadge_shop_idx" ON "ProductBadge"("shop");

-- CreateIndex
CREATE INDEX "AnnouncementBar_shop_idx" ON "AnnouncementBar"("shop");

-- CreateIndex
CREATE INDEX "FreeShippingBar_shop_idx" ON "FreeShippingBar"("shop");

-- CreateIndex
CREATE INDEX "StickyCart_shop_idx" ON "StickyCart"("shop");

-- CreateIndex
CREATE INDEX "CountdownTimer_shop_idx" ON "CountdownTimer"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "AppSettings_shop_key" ON "AppSettings"("shop");
