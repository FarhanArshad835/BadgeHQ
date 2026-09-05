-- One row per conversation the bot handed to a person.
--
-- Conversation rows carry the mute flags but are purged after 24 hours, so a
-- handover older than a day left no trace anywhere. This records the event
-- itself, so "how many customers did the bot finish vs how many did we take
-- over" can be answered over a real reporting period.
CREATE TABLE "Handover" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'whatsapp',
    "customerId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Handover_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Handover_shop_createdAt_idx" ON "Handover"("shop", "createdAt");
