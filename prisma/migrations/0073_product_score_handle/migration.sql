-- The ranked order is applied in the browser, where a product card is
-- identified by the handle in its link - most themes expose no product id in
-- the grid markup. An order expressed only in GIDs therefore cannot be used
-- client-side, so the handle is stored with the score.
ALTER TABLE "ProductScore" ADD COLUMN IF NOT EXISTS "handle" TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS "ProductScore_shop_handle_idx" ON "ProductScore"("shop","handle");
