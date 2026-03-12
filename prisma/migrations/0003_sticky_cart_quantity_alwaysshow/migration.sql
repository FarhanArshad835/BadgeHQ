-- AlterTable: add quantity selector and always-show options to StickyCart
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "showQuantity" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "alwaysShow"   BOOLEAN NOT NULL DEFAULT false;
