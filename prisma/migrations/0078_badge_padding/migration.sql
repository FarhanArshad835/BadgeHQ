-- Badge padding was hardcoded at 4px 8px. Defaults keep every existing badge
-- exactly the size it already is.
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "padTop"    INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "padRight"  INTEGER NOT NULL DEFAULT 8;
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "padBottom" INTEGER NOT NULL DEFAULT 4;
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "padLeft"   INTEGER NOT NULL DEFAULT 8;
