-- Back in Stock is WhatsApp-only: the shopper's phone number is their identity.
-- Email (and the Shopify customer mirror it fed) is removed entirely.

-- Rows without a WhatsApp number can never be notified, so drop them rather
-- than leave dead entries inflating the "waiting" count.
DELETE FROM "BackInStockSubscription" WHERE "phone" IS NULL OR "phone" = '';

-- Collapse any duplicates that the old (shop, variantId, email) key allowed —
-- the same number could appear twice for a variant under two emails. Keep the
-- earliest signup.
DELETE FROM "BackInStockSubscription" a
USING "BackInStockSubscription" b
WHERE a."shop" = b."shop"
  AND a."variantId" = b."variantId"
  AND a."phone" = b."phone"
  AND a."createdAt" > b."createdAt";

DROP INDEX IF EXISTS "BackInStockSubscription_shop_variantId_email_key";

ALTER TABLE "BackInStockSubscription" DROP COLUMN IF EXISTS "email";
ALTER TABLE "BackInStockSubscription" DROP COLUMN IF EXISTS "customerId";

CREATE UNIQUE INDEX IF NOT EXISTS "BackInStockSubscription_shop_variantId_phone_key"
  ON "BackInStockSubscription"("shop", "variantId", "phone");
