ALTER TABLE "OrderManageSettings" ADD COLUMN IF NOT EXISTS "showOnPages" TEXT NOT NULL DEFAULT '["account"]';
