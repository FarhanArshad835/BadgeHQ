-- AlterTable
ALTER TABLE "Session" ADD COLUMN "refreshToken" TEXT;
ALTER TABLE "Session" ADD COLUMN "refreshTokenExpires" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ProductBadge" (
    "id" TEXT NOT NULL PRIMARY KEY,
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
    "opacity" REAL NOT NULL DEFAULT 1.0,
    "rotation" INTEGER NOT NULL DEFAULT 0,
    "gradient" TEXT NOT NULL DEFAULT '',
    "borderColor" TEXT NOT NULL DEFAULT '',
    "borderWidth" INTEGER NOT NULL DEFAULT 0,
    "customCSS" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ProductBadge" ("badgeColor", "createdAt", "id", "isActive", "position", "shape", "shop", "targeting", "text", "textColor", "updatedAt") SELECT "badgeColor", "createdAt", "id", "isActive", "position", "shape", "shop", "targeting", "text", "textColor", "updatedAt" FROM "ProductBadge";
DROP TABLE "ProductBadge";
ALTER TABLE "new_ProductBadge" RENAME TO "ProductBadge";
CREATE INDEX "ProductBadge_shop_idx" ON "ProductBadge"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
