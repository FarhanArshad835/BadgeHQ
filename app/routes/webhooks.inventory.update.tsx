/**
 * inventory_levels/update webhook — the restock trigger for Back in Stock.
 *
 * Shopify pushes here whenever a variant's stock changes at any location. When
 * stock goes positive we fire the Flow custom trigger once per waiting
 * subscriber; the merchant's marketing automation turns that into a Shopify
 * Email. We never send email ourselves.
 *
 * Must return 2xx quickly — Shopify retries non-2xx.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import {
  fireRestockTrigger,
  resolveInventoryItem,
  toGid,
} from "../utils/back-in-stock.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  const available = Number((payload as any)?.available);
  const inventoryItemId = String((payload as any)?.inventory_item_id || "");

  // Only care about transitions INTO stock. Nothing to do otherwise.
  if (!inventoryItemId || !Number.isFinite(available) || available <= 0) {
    return new Response();
  }

  const settings = await prisma.backInStockSettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled) return new Response();

  try {
    const { admin } = await unauthenticated.admin(shop);

    const variant = await resolveInventoryItem(admin, inventoryItemId);
    if (!variant) return new Response();

    const waiting = await prisma.backInStockSubscription.findMany({
      where: { shop, variantId: variant.variantId, notifiedAt: null },
      take: 250,
    });
    if (!waiting.length) return new Response();

    const notified: string[] = [];
    for (const sub of waiting) {
      // No customer record means the shopper was never subscribed, so the
      // marketing automation can't reach them — leave the row unnotified so it
      // shows up in the admin list rather than being silently dropped.
      if (!sub.customerId) continue;
      const ok = await fireRestockTrigger(
        admin,
        shop,
        toGid("Customer", sub.customerId),
        variant,
      );
      if (ok) notified.push(sub.id);
    }

    if (notified.length) {
      await prisma.backInStockSubscription.updateMany({
        where: { id: { in: notified } },
        data: { notifiedAt: new Date() },
      });
    }
    console.log(
      `BadgeHQ: ${topic} ${shop} variant ${variant.variantId} -> notified ${notified.length}/${waiting.length}`,
    );
  } catch (e) {
    // Swallow: returning non-2xx would make Shopify retry the whole batch and
    // risk double-triggering the ones that already succeeded.
    console.error("BadgeHQ: inventory webhook failed", e);
  }

  return new Response();
};
