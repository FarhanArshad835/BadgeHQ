-- A global "hide the MRP" toggle could not target anything: it applied to
-- every card or none. Expressed as a badge property instead, the rule inherits
-- the targeting, conditions, pages and schedule a badge already has.
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "hideComparePrice" BOOLEAN NOT NULL DEFAULT false;
