-- Label for the link to the qualifying products. Blank falls back to a
-- sensible default, because collections are often named after the promotion
-- ("2 FOR 1299"), which would make the button repeat the heading above it.
ALTER TABLE "BundleOffer" ADD COLUMN IF NOT EXISTS "ctaText" TEXT NOT NULL DEFAULT '';
