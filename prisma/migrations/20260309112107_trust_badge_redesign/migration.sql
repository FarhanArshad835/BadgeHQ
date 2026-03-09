/*
  Warnings:

  - You are about to drop the column `badges` on the `TrustBadge` table. All the data in the column will be lost.
  - You are about to drop the column `isActive` on the `TrustBadge` table. All the data in the column will be lost.
  - You are about to drop the column `pages` on the `TrustBadge` table. All the data in the column will be lost.
  - You are about to drop the column `position` on the `TrustBadge` table. All the data in the column will be lost.
  - You are about to drop the column `title` on the `TrustBadge` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_TrustBadge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Trust Badge',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "badgeIds" TEXT NOT NULL DEFAULT '[]',
    "settings" TEXT NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_TrustBadge" ("createdAt", "id", "settings", "shop", "updatedAt") SELECT "createdAt", "id", "settings", "shop", "updatedAt" FROM "TrustBadge";
DROP TABLE "TrustBadge";
ALTER TABLE "new_TrustBadge" RENAME TO "TrustBadge";
CREATE INDEX "TrustBadge_shop_idx" ON "TrustBadge"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
