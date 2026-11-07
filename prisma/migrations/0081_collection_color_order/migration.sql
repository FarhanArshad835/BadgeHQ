-- The ordered colour-card list for a collection, computed by the engine.
--
-- The storefront currently splits whatever Shopify happens to send for the
-- page it is on, so every colour of those 24 products lands on screen however
-- weak it is, and the low-scoring ones are only pushed down when the next
-- batch arrives - 42 of 73 cards moved after one scroll. Ordering colours
-- across the WHOLE collection is only possible where the whole collection is
-- known, which is here.
CREATE TABLE IF NOT EXISTS "CollectionColorOrder" (
  "id"         TEXT PRIMARY KEY,
  "shop"       TEXT NOT NULL,
  "handle"     TEXT NOT NULL,
  -- [[productHandle, colour, imageUrl, variantId, soldOut], ...] in order.
  -- Stored as JSON because it is written whole and read whole, never queried.
  "cards"      TEXT NOT NULL DEFAULT '[]',
  "cardCount"  INTEGER NOT NULL DEFAULT 0,
  "builtAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "CollectionColorOrder_shop_handle_key"
  ON "CollectionColorOrder"("shop", "handle");
