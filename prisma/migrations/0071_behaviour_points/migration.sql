-- Make the per-action behaviour points editable.
--
-- What a shopper action signifies is a merchant judgement, not a constant: on
-- a store where wishlisting is casual it should count for less than on one
-- where it predicts a purchase. Defaults reproduce the previous hardcoded
-- values exactly, so no existing ranking changes.
ALTER TABLE "MerchandiseSettings"
  ADD COLUMN IF NOT EXISTS "behCartPoints"        INTEGER NOT NULL DEFAULT 12,
  ADD COLUMN IF NOT EXISTS "behCartCap"           INTEGER NOT NULL DEFAULT 24,
  ADD COLUMN IF NOT EXISTS "behCartRemovePenalty" INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS "behWishPoints"        INTEGER NOT NULL DEFAULT 10,
  ADD COLUMN IF NOT EXISTS "behWishCap"           INTEGER NOT NULL DEFAULT 20,
  ADD COLUMN IF NOT EXISTS "behWishRemovePenalty" INTEGER NOT NULL DEFAULT 9,
  ADD COLUMN IF NOT EXISTS "behDwellPoints"       INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "behViewPoints"        INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "behViewCap"           INTEGER NOT NULL DEFAULT 4;
