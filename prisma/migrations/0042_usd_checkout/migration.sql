-- "Pay in USD" checkout config (single row, id='default'). Razorpay International
-- charges USD outside Shopify checkout; on payment the order is written back to
-- Shopify. Secrets server-side only. Idempotent.
CREATE TABLE IF NOT EXISTS "UsdCheckout" (
  "id"                    TEXT NOT NULL DEFAULT 'default',
  "enabled"               BOOLEAN NOT NULL DEFAULT false,
  "razorpayKeyId"         TEXT NOT NULL DEFAULT '',
  "razorpayKeySecret"     TEXT NOT NULL DEFAULT '',
  "razorpayWebhookSecret" TEXT NOT NULL DEFAULT '',
  "shopDomain"            TEXT NOT NULL DEFAULT '',
  "shopifyAdminToken"     TEXT NOT NULL DEFAULT '',
  "markupBps"             INTEGER NOT NULL DEFAULT 40000,
  "inrToUsdRate"          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "rateFetchedAt"         TIMESTAMP(3),
  "createdAt"             TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"             TIMESTAMP(3) NOT NULL,
  CONSTRAINT "UsdCheckout_pkey" PRIMARY KEY ("id")
);
