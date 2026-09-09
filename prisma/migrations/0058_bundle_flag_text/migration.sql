-- The small notched label on the card's top border.
ALTER TABLE "BundleOffer" ADD COLUMN IF NOT EXISTS "flagText" TEXT NOT NULL DEFAULT 'Best Offer';
