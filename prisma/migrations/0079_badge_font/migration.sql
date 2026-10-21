-- Badges hardcoded font-weight 700 and set no font-family at all, so they
-- inherited the theme's font regardless of the app's own font setting.
-- Defaults preserve exactly that behaviour.
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "fontFamily" TEXT NOT NULL DEFAULT '';
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "fontWeight" INTEGER NOT NULL DEFAULT 700;
