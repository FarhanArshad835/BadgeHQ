-- A courier claim raised on a parcel that never arrived.
-- Keyed by AWB: a claim is an argument about one waybill, and the same order
-- can carry two parcels. Separate from OrderFinancials, which is rebuilt from
-- Shopify on every sync and would lose this.
CREATE TABLE "ParcelClaim" (
  "id"        TEXT NOT NULL,
  "shop"      TEXT NOT NULL,
  "awb"       TEXT NOT NULL,
  "kind"      TEXT NOT NULL,
  "status"    TEXT NOT NULL DEFAULT 'raised',
  "note"      TEXT NOT NULL DEFAULT '',
  "raisedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ParcelClaim_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ParcelClaim_shop_awb_key" ON "ParcelClaim"("shop", "awb");
CREATE INDEX "ParcelClaim_shop_kind_status_idx" ON "ParcelClaim"("shop", "kind", "status");
