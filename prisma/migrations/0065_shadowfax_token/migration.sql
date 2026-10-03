-- Shadowfax books roughly a third of our parcels and was the one carrier the
-- app could not ask about, so its AWBs were recorded as "not in orders".
ALTER TABLE "PnlApp" ADD COLUMN "shadowfaxApiToken" TEXT NOT NULL DEFAULT '';
