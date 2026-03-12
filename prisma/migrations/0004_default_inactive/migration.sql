-- Change default isActive/isEnabled to false for all feature models
ALTER TABLE "TrustBadge"      ALTER COLUMN "isEnabled" SET DEFAULT false;
ALTER TABLE "ProductBadge"    ALTER COLUMN "isActive"  SET DEFAULT false;
ALTER TABLE "AnnouncementBar" ALTER COLUMN "isActive"  SET DEFAULT false;
ALTER TABLE "FreeShippingBar" ALTER COLUMN "isActive"  SET DEFAULT false;
ALTER TABLE "StickyCart"      ALTER COLUMN "isActive"  SET DEFAULT false;
ALTER TABLE "CountdownTimer"  ALTER COLUMN "isActive"  SET DEFAULT false;
