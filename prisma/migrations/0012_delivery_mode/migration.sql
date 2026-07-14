ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "deliveryMode" TEXT NOT NULL DEFAULT 'standard';
