-- Which products belong to each badge-targeted collection, as handles.
--
-- A badge can be scoped to a collection, and the only way the storefront could
-- answer "is this product in that collection?" was to download the collection
-- and look. Measured on a real throttled load of this store: six such fetches,
-- 25.2MB of products.json decoded, the largest taking 95 seconds - all of it
-- discarded except the handles.
--
-- The engine already computes exactly this, hourly, through the Admin API
-- (badgeMembership), and then throws it away. Storing it lets /api/order hand
-- it to the storefront in about 9KB compressed.
ALTER TABLE "MerchandiseSettings"
  ADD COLUMN IF NOT EXISTS "badgeMembers" TEXT NOT NULL DEFAULT '{}';
