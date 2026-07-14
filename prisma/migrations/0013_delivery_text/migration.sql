ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "headingText" TEXT NOT NULL DEFAULT 'Estimate delivery date';
ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "deliverByText" TEXT NOT NULL DEFAULT 'Delivery by';
ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "freeDeliveryOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "freeDeliveryText" TEXT NOT NULL DEFAULT 'Free delivery';
ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "fasterNoteOn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DeliverySettings" ADD COLUMN IF NOT EXISTS "fasterNoteText" TEXT NOT NULL DEFAULT 'Faster delivery methods available at checkout';
