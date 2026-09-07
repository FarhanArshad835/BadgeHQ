-- Earliest month the P&L dashboard displays. Separate from backfillStartMonth
-- so a month can be hidden from reporting without stopping its sync or
-- deleting its orders. Blank means show every month that has data.
--
-- Defaults to 2026-05, which hides April: its shipping ran Rs239 per delivered
-- order against Rs112 in June, and its return/exchange fees came to Rs17,400
-- against Rs1.4-1.7 lakh every other month, so including it distorted every
-- comparison. The April orders are untouched and still syncing; clearing this
-- setting brings the month straight back.
ALTER TABLE "PnlApp" ADD COLUMN "reportStartMonth" TEXT NOT NULL DEFAULT '2026-05';
