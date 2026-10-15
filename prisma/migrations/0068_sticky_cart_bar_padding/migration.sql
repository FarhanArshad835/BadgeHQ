-- The sticky bar's height was fixed at 10px of vertical padding, which reads as
-- cramped on a wide product page. The bar has no explicit height — it is sized
-- by its contents — so the padding is what a merchant actually needs to control.
-- Default reproduces the previous appearance exactly.
ALTER TABLE "StickyCart" ADD COLUMN IF NOT EXISTS "barPadding" TEXT NOT NULL DEFAULT '10';
