-- Outstanding password-reset token for the standalone P&L tool. Stored as a
-- hash so a database read cannot itself reset the password, and cleared on use
-- so a link that leaks after the fact is inert.
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "resetTokenHash" TEXT NOT NULL DEFAULT '';
ALTER TABLE "PnlApp" ADD COLUMN IF NOT EXISTS "resetTokenExpires" TIMESTAMP(3);
