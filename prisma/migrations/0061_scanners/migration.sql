-- Warehouse scanners: dispatch, RTO received, customer return received.

-- Separate password for the scanners. Its cookie is scoped to /pnl-app/scan, so
-- warehouse staff holding it cannot reach the P&L.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "scanPasswordHash" TEXT NOT NULL DEFAULT '';

-- One physical scan. Append-only, and deliberately not a source of truth for
-- delivery status: the tracking sheet owns that column and the cron would
-- overwrite anything written here.
CREATE TABLE "ScanEvent" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "awb" TEXT NOT NULL,
    "orderName" TEXT NOT NULL DEFAULT '',
    "result" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "scannedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScanEvent_pkey" PRIMARY KEY ("id")
);

-- Makes duplicate rejection a database guarantee rather than a UI check: two
-- guns scanning the same packet cannot both record it.
CREATE UNIQUE INDEX "ScanEvent_shop_kind_awb_key" ON "ScanEvent"("shop", "kind", "awb");
CREATE INDEX "ScanEvent_shop_kind_scannedAt_idx" ON "ScanEvent"("shop", "kind", "scannedAt");

-- AWBs already handed to a courier, synced from the dispatch sheet. Scanning one
-- at dispatch means a packet is about to go out twice.
CREATE TABLE "DispatchedAwb" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "awb" TEXT NOT NULL,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DispatchedAwb_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DispatchedAwb_shop_awb_key" ON "DispatchedAwb"("shop", "awb");
CREATE INDEX "DispatchedAwb_shop_idx" ON "DispatchedAwb"("shop");

-- Source of the already-dispatched blocklist. Read on a button press only.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "dispatchSheetUrl" TEXT NOT NULL DEFAULT '';
