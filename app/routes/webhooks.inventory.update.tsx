/**
 * inventory_levels/update webhook — the restock trigger for Back in Stock.
 *
 * Shopify pushes here whenever a variant's stock changes at any location. When
 * stock goes positive we WhatsApp every waiting shopper via Interakt, using the
 * number they typed into the storefront form. That is first-party data, so
 * notifying reads no Shopify customer records and needs no Protected Customer
 * Data access.
 *
 * `notifiedAt` is set ONLY for shoppers Interakt accepted, so anyone we
 * couldn't reach is retried on the next restock instead of being lost.
 *
 * Mirroring shoppers into the customer list + firing the Flow trigger (for
 * merchants who built the marketing automation) is an optional BONUS, gated on
 * the shop actually granting write_customers. It never affects notifiedAt.
 *
 * Must return 2xx quickly — Shopify retries non-2xx.
 */
import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import {
  buildProductUrl,
  canDeliverWhatsApp,
  fireRestockTrigger,
  hasWriteCustomers,
  resolveInventoryItem,
  sendRestockWhatsApp,
  toGid,
  upsertSubscribedCustomer,
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

  // No way to deliver yet — leave everyone waiting so they're notified on the
  // next restock once the merchant finishes Interakt setup. Bail before
  // spending any Shopify API calls.
  if (!canDeliverWhatsApp(settings)) {
    console.log(`BadgeHQ: ${shop} restock but WhatsApp not configured — nobody notified`);
    return new Response();
  }

  try {
    const { admin } = await unauthenticated.admin(shop);

    const variant = await resolveInventoryItem(admin, inventoryItemId);
    if (!variant) return new Response();
    // Build the URL once for the whole batch.
    variant.productUrl = buildProductUrl(shop, variant);

    const waiting = await prisma.backInStockSubscription.findMany({
      where: { shop, variantId: variant.variantId, notifiedAt: null },
      take: 250,
    });
    if (!waiting.length) return new Response();

    // Checked once per batch, not per shopper.
    const canMirrorCustomers = await hasWriteCustomers(admin);

    const notified: string[] = [];
    let failures = 0;
    for (const sub of waiting) {
      // Delivery: WhatsApp. This alone decides whether they count as notified.
      const wa = await sendRestockWhatsApp({
        settings,
        phone: sub.phone,
        shop,
        variant,
      });
      if (wa.ok) notified.push(sub.id);
      else failures++;

      // Bonus, only if the shop granted write_customers: mirror them into the
      // customer list and fire the Flow trigger for the marketing automation.
      // Deliberately does NOT gate notifiedAt.
      if (canMirrorCustomers) {
        try {
          let customerId = sub.customerId;
          if (!customerId) {
            customerId = await upsertSubscribedCustomer(admin, sub.email);
            if (customerId) {
              await prisma.backInStockSubscription.update({
                where: { id: sub.id },
                data: { customerId },
              });
            }
          }
          if (customerId) {
            await fireRestockTrigger(admin, shop, toGid("Customer", customerId), variant);
          }
        } catch {
          // Bonus path only — never let it affect delivery accounting.
        }
      }
    }

    if (notified.length) {
      await prisma.backInStockSubscription.updateMany({
        where: { id: { in: notified } },
        data: { notifiedAt: new Date() },
      });
    }
    console.log(
      `BadgeHQ: ${topic} ${shop} variant ${variant.variantId} -> whatsapp ${notified.length}/${waiting.length} (${failures} not reached)`,
    );
  } catch (e) {
    // Swallow: returning non-2xx would make Shopify retry the whole batch and
    // risk double-notifying the ones that already succeeded.
    console.error("BadgeHQ: inventory webhook failed", e);
  }

  return new Response();
};
