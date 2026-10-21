-- "In Product Info Area" placement always rendered immediately above the
-- price: the insertion point was hardcoded. Merchants asked to choose, so the
-- position becomes a setting.
--
-- Defaults to above-price so existing info badges stay exactly where they are.
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "infoPosition" TEXT NOT NULL DEFAULT 'above-price';
