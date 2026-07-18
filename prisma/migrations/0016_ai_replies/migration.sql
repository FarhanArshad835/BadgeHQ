CREATE TABLE IF NOT EXISTS "AiReplySettings" (
  "id"           TEXT NOT NULL PRIMARY KEY,
  "shop"         TEXT NOT NULL,
  "isEnabled"    BOOLEAN NOT NULL DEFAULT false,
  "apiKey"       TEXT NOT NULL DEFAULT '',
  "knowledge"    TEXT NOT NULL DEFAULT '',
  "botName"      TEXT NOT NULL DEFAULT 'Support',
  "greeting"     TEXT NOT NULL DEFAULT 'Hi! Ask me about shipping, returns or sizing.',
  "supportEmail" TEXT NOT NULL DEFAULT '',
  "supportUrl"   TEXT NOT NULL DEFAULT '',
  "accentColor"  TEXT NOT NULL DEFAULT '#111111',
  "position"     TEXT NOT NULL DEFAULT 'bottom-right',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "AiReplySettings_shop_key" ON "AiReplySettings"("shop");
