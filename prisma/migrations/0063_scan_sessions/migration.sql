-- A named batch a scan belongs to: a trolley, a shift, a pallet.
-- Defaults to '' so every existing row stays valid and the scanners keep
-- working for anyone who never names one.
ALTER TABLE "ScanEvent" ADD COLUMN "session" TEXT NOT NULL DEFAULT '';

-- Reopening a session lists its scans newest-first.
CREATE INDEX "ScanEvent_shop_session_scannedAt_idx"
  ON "ScanEvent"("shop", "session", "scannedAt");
