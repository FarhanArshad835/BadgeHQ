-- The collection's display name, so the admin shows what was picked rather
-- than echoing a handle back at the merchant.
--
-- Separate from 0055 because that migration had already been recorded as
-- applied by the time this column was added: an edit to an applied migration
-- is never re-run, so the column was missing in production while the deployed
-- code selected it. IF NOT EXISTS keeps this safe on any database that did get
-- the edited 0055.
ALTER TABLE "BundleOffer" ADD COLUMN IF NOT EXISTS "collectionTitle" TEXT NOT NULL DEFAULT '';
