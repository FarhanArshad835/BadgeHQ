-- USD checkout: per-attempt order record (cart snapshot + payment/Shopify status).
CREATE TABLE IF NOT EXISTS "UsdOrder" (
  "id"                TEXT NOT NULL,
  "razorpayOrderId"   TEXT NOT NULL,
  "razorpayPaymentId" TEXT,
  "amountUsdCents"    INTEGER NOT NULL,
  "inrToUsdRate"      DOUBLE PRECISION NOT NULL,
  "lineItemsJson"     TEXT NOT NULL DEFAULT '[]',
  "status"            TEXT NOT NULL DEFAULT 'created',
  "shopifyOrderId"    TEXT,
  "shopifyOrderName"  TEXT,
  "errorNote"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UsdOrder_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "UsdOrder_razorpayOrderId_key" ON "UsdOrder"("razorpayOrderId");
CREATE INDEX IF NOT EXISTS "UsdOrder_status_idx" ON "UsdOrder"("status");
