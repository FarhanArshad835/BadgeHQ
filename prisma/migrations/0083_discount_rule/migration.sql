-- Mirror of the shop's automatic discount rules, read from Shopify.
--
-- The badge on a collection card must quote the same saving the checkout will
-- actually give. Hardcoding the rules in JS was tried and went stale the day a
-- "200 OFF" discount was added: cards quoted Rs499 for a tee that really added
-- Rs399. Pricing each hypothetical cart through Shopify is exact but costs a
-- round trip per product, so a 48-card page is unusable.
--
-- Field names and units mirror the contract already proven on the cart page
-- (jm-cart-pricer.js) so ONE bestOff() can price a cart line and a collection
-- card identically. In particular: "kind" is amount|percent (not Shopify's
-- type names), "percent" is 0..1 rather than 0..100, and money is rupees as a
-- float because that is what the pricer compares against.
CREATE TABLE IF NOT EXISTS "DiscountRule" (
  "id"              TEXT PRIMARY KEY,
  "shop"            TEXT NOT NULL,
  -- Shopify's node id: a re-sync updates in place instead of churning rows.
  "nodeId"          TEXT NOT NULL,
  "title"           TEXT NOT NULL DEFAULT '',
  -- ACTIVE | SCHEDULED | EXPIRED. Non-active rules are kept so the admin can
  -- see why a badge is not showing; the serving query filters on this.
  "status"          TEXT NOT NULL DEFAULT '',
  "kind"            TEXT NOT NULL DEFAULT 'amount',
  "amount"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- 0..1, NOT 0..100.
  "percent"         DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Shopify's appliesOnEachItem: per qualifying item rather than per order.
  "perItem"         BOOLEAN NOT NULL DEFAULT false,
  "minQty"          INTEGER NOT NULL DEFAULT 0,
  "minSubtotal"     DOUBLE PRECISION NOT NULL DEFAULT 0,
  -- Scope, as the pricer's inScope() expects: allItems wins, else a product
  -- id list or a collection handle list, both JSON arrays.
  "allItems"        BOOLEAN NOT NULL DEFAULT false,
  "products"        TEXT NOT NULL DEFAULT '[]',
  "collections"     TEXT NOT NULL DEFAULT '[]',
  -- Rules that EXIST but cannot be priced honestly (Buy-X-get-Y, app
  -- functions). Recorded rather than dropped so a badge can stay silent on
  -- affected products instead of quoting a figure that ignores them.
  "unsupported"     BOOLEAN NOT NULL DEFAULT false,
  "unsupportedKind" TEXT NOT NULL DEFAULT '',
  "syncedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "DiscountRule_shop_nodeId_key"
  ON "DiscountRule"("shop", "nodeId");
CREATE INDEX IF NOT EXISTS "DiscountRule_shop_status_idx"
  ON "DiscountRule"("shop", "status");
