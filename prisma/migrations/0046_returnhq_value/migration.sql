-- ReturnHQ cache: ₹ value of returned / exchanged orders (funnel value column).
ALTER TABLE "ReturnHqCache" ADD COLUMN IF NOT EXISTS "returnsValueMinor"   BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "ReturnHqCache" ADD COLUMN IF NOT EXISTS "exchangesValueMinor" BIGINT NOT NULL DEFAULT 0;
