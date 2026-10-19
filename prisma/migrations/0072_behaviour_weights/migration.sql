-- Give each shopper action its own weight, alongside sales and reviews rather
-- than hidden beneath a single combined "behaviour" figure.
--
-- They measure genuinely different things: an add to cart is near-purchase
-- intent, a view is barely a signal at all. A merchant should be able to say
-- that directly instead of tuning a points-per-action number nested inside one
-- shared slider.
--
-- Defaults sum to 16, close to the old combined default of 15, and all four
-- start disabled so no existing ranking changes until a merchant opts in.
ALTER TABLE "MerchandiseSettings"
  ADD COLUMN IF NOT EXISTS "weightCart"  INTEGER NOT NULL DEFAULT 8,
  ADD COLUMN IF NOT EXISTS "weightWish"  INTEGER NOT NULL DEFAULT 5,
  ADD COLUMN IF NOT EXISTS "weightDwell" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS "weightViews" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "useCart"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "useWish"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "useDwell"    BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "useViews"    BOOLEAN NOT NULL DEFAULT false;

-- A shop already using behaviour keeps it: carry its toggle onto the four new
-- ones so the signal does not silently switch off on deploy.
UPDATE "MerchandiseSettings"
   SET "useCart" = true, "useWish" = true, "useDwell" = true, "useViews" = true
 WHERE "useBehaviour" = true;
