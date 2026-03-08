import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR Mandatory Webhook: Customer Redact
 *
 * When a store owner requests deletion of a customer's data, Shopify sends
 * this webhook so your app can erase any stored customer data.
 *
 * See: https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-redact
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Implement your customer data deletion logic here.
  // You must delete all customer data your app has stored for the given customer.

  return new Response();
};
