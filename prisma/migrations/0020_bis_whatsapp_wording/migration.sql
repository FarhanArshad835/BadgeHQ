-- The consent/success copy is merchant-editable, so shops that saved the old
-- email wording keep showing "We'll email you" even though the feature is now
-- WhatsApp-only (a saved value always beats the code default). Any copy still
-- mentioning email is now factually wrong — shoppers would be promised an
-- email they will never receive — so rewrite those rows, custom or not. Copy
-- that doesn't mention email is left untouched.
UPDATE "BackInStockSettings"
SET "consentText" = 'We''ll message you on WhatsApp when it''s back in stock.'
WHERE "consentText" LIKE '%email%';

UPDATE "BackInStockSettings"
SET "successText" = 'Done! We''ll WhatsApp you when it''s back in stock.'
WHERE "successText" LIKE '%email%';
