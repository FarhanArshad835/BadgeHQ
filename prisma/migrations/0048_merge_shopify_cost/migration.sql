-- One Shopify cost line instead of two: the merchant enters a single combined
-- figure. Fold any existing subscription amount into the billing column FIRST so
-- the cost isn't silently dropped from months already entered (that would
-- overstate profit for those months).
UPDATE "PnlMonthlyInput"
   SET "shopifyBillingMinor" = "shopifyBillingMinor" + "shopifySubscriptionMinor"
 WHERE "shopifySubscriptionMinor" <> 0;

ALTER TABLE "PnlMonthlyInput" DROP COLUMN IF EXISTS "shopifySubscriptionMinor";
