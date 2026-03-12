-- AlterTable: add new customization columns to StickyCart with safe defaults
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "textColor"    TEXT NOT NULL DEFAULT '#ffffff';
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "buttonStyle"  TEXT NOT NULL DEFAULT 'solid';
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "buttonRadius" TEXT NOT NULL DEFAULT '6';
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "showPrice"    BOOLEAN NOT NULL DEFAULT true;
