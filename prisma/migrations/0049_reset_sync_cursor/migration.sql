-- The order sync now pages NEWEST-first (reverse: true). Any cursor saved by the
-- old ascending pass points into a different ordering, so resuming with it would
-- skip or repeat orders. Clear the resume state; the next run starts clean.
UPDATE "PnlApp"
   SET "syncCursor" = NULL,
       "syncWindowStart" = NULL,
       "syncWindowEnd" = NULL
 WHERE "syncCursor" IS NOT NULL;
