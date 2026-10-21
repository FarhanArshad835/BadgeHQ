-- hideComparePrice was a bare boolean: hide the MRP, with nothing to say what
-- should appear instead. A rule object carries the mode and its settings, so a
-- badge can also SHOW a struck price on the 103 products that have no
-- compare-at price of their own.
ALTER TABLE "ProductBadge" ADD COLUMN IF NOT EXISTS "priceRule" TEXT NOT NULL DEFAULT '{"mode":"hide","markupPct":0,"roundTo":0}';
