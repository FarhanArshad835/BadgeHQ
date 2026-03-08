import type { ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";

/**
 * GDPR Mandatory Webhook: Customer Data Request
 *
 * When a customer requests their data from a store owner, Shopify sends this
 * webhook to your app so you can provide any customer data you may have stored.
 *
 * See: https://shopify.dev/docs/apps/webhooks/configuration/mandatory-webhooks#customers-data_request
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Implement your customer data request logic here.
  // You should return any customer data your app has stored.

  return new Response();
};
