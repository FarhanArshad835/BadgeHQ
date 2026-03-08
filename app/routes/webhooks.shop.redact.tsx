import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR Mandatory Webhook: Shop Redact
 *
 * 48 hours after a store uninstalls your app, Shopify sends this webhook
 * so you can erase any data you have stored for that store.
 *
 * See: https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#shop-redact
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Implement your shop data deletion logic here.
  // You must delete all data your app has stored for the given shop.

  return new Response();
};
