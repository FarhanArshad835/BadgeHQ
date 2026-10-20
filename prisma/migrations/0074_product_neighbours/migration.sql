-- Affinity: lift products similar to the ones a shopper engaged with.
--
-- Similarity is pairwise, so a 1,065-product catalogue is 566,580
-- comparisons - too many to compute in a browser and too large to ship. The
-- nearest handful per product is precomputed on each engine run instead:
-- top-8 is about 55KB gzipped for the whole catalogue.
ALTER TABLE "ProductScore" ADD COLUMN IF NOT EXISTS "neighbours" TEXT NOT NULL DEFAULT '[]';
