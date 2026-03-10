-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TrustBadge" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Trust Badge',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "badgeIds" TEXT NOT NULL DEFAULT '[]',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TrustBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductBadge" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "text" TEXT NOT NULL DEFAULT 'Sale',
    "badgeType" TEXT NOT NULL DEFAULT 'text',
    "shape" TEXT NOT NULL DEFAULT 'rectangle',
    "badgeColor" TEXT NOT NULL DEFAULT '#e74c3c',
    "textColor" TEXT NOT NULL DEFAULT '#ffffff',
    "position" TEXT NOT NULL DEFAULT 'top-left',
    "targeting" TEXT NOT NULL DEFAULT '{"type":"all"}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "condition" TEXT NOT NULL DEFAULT '{"type":"none"}',
    "pages" TEXT NOT NULL DEFAULT '["all"]',
    "schedule" TEXT NOT NULL DEFAULT '{}',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "imageUrl" TEXT NOT NULL DEFAULT '',
    "fontSize" INTEGER NOT NULL DEFAULT 11,
    "opacity" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "gradient" TEXT NOT NULL DEFAULT '',
    "borderColor" TEXT NOT NULL DEFAULT '',
    "borderWidth" INTEGER NOT NULL DEFAULT 0,
    "customCSS" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductBadge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnnouncementBar" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "messages" TEXT NOT NULL DEFAULT '[{"text":"Welcome to our store!","emoji":""}]',
    "bgColor" TEXT NOT NULL DEFAULT '#000000',
    "textColor" TEXT NOT NULL DEFAULT '#ffffff',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showClose" BOOLEAN NOT NULL DEFAULT true,
    "pages" TEXT NOT NULL DEFAULT '["all"]',
    "schedule" TEXT NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnnouncementBar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FreeShippingBar" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "threshold" DOUBLE PRECISION NOT NULL DEFAULT 50.0,
    "messages" TEXT NOT NULL DEFAULT '{"below":"You''re {{amount}} away from free shipping!","reached":"Congratulations! You''ve earned free shipping!"}',
    "colors" TEXT NOT NULL DEFAULT '{"barBg":"#f0f0f0","progressBg":"#4caf50","text":"#333333"}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pages" TEXT NOT NULL DEFAULT '["cart","product"]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FreeShippingBar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StickyCart" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "buttonText" TEXT NOT NULL DEFAULT 'Add to Cart',
    "buttonColor" TEXT NOT NULL DEFAULT '#ffffff',
    "bgColor" TEXT NOT NULL DEFAULT '#000000',
    "showMobile" BOOLEAN NOT NULL DEFAULT true,
    "showDesktop" BOOLEAN NOT NULL DEFAULT true,
    "position" TEXT NOT NULL DEFAULT 'bottom',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StickyCart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CountdownTimer" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "style" TEXT NOT NULL DEFAULT 'full',
    "messages" TEXT NOT NULL DEFAULT '{"above":"Hurry! Sale ends in:","below":"Don''t miss out!"}',
    "colors" TEXT NOT NULL DEFAULT '{"bg":"#000000","text":"#ffffff","accent":"#e74c3c"}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "pages" TEXT NOT NULL DEFAULT '["product"]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CountdownTimer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppSettings" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" TEXT NOT NULL DEFAULT '{"fontFamily":"inherit","colorScheme":"light"}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSettings_pkey" PRIMARY KEY ("id")
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
