-- The storefront works in collection handles; the engine stores GIDs. The
-- public /api/order route is unauthenticated and so cannot resolve one to the
-- other, which is why the widget reordered every collection in the store.
-- Written by the engine on each run, which already holds admin access.
ALTER TABLE "MerchandiseSettings"
  ADD COLUMN IF NOT EXISTS "collectionHandles" TEXT NOT NULL DEFAULT '[]';
