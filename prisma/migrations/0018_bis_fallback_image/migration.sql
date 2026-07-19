-- waFallbackImage was appended to 0017 after that migration had already been
-- applied, so Prisma skipped it ("No pending migrations to apply") and the
-- column was never created. Ship it as its own migration.
ALTER TABLE "BackInStockSettings" ADD COLUMN IF NOT EXISTS "waFallbackImage" TEXT NOT NULL DEFAULT '';
