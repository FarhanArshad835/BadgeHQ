/**
 * TEMPORARY test endpoint — proves the Shopify orderCreate write-back works
 * (currency USD, financialStatus PAID, US shipping address) WITHOUT a real
 * payment. Guarded by a secret so it can't be triggered publicly. DELETE after
 * verifying.
 *
 * Usage: GET /api/usd-checkout/test-order?secret=SBE_TEST&variant=43598164492347
 */
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { getUsdConfig } from "../utils/usd-checkout.server";

const SECRET = "SBE_TEST_9f3a"; // temporary

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const variant = url.searchParams.get("variant") || "43598164492347";
  const dry = url.searchParams.get("dry") === "1";

  const cfg = await getUsdConfig();
  if (!cfg.shopDomain || !cfg.shopifyAdminToken) {
    return json({ error: "Shopify not configured", shopDomain: cfg.shopDomain, hasToken: Boolean(cfg.shopifyAdminToken) });
  }

  const variantGid = variant.startsWith("gid://")
    ? variant
    : `gid://shopify/ProductVariant/${variant.replace(/\D/g, "")}`;

  const mutation = `
    mutation UsdOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name displayFinancialStatus shippingAddress { address1 city provinceCode zip countryCodeV2 } }
        userErrors { field message }
      }
    }`;

  const order = {
    lineItems: [{ variantId: variantGid, quantity: 1 }],
    financialStatus: "PAID",
    currency: "USD",
    email: "test-buyer@example.com",
    note: "TEST ORDER — USD write-back verification. Safe to delete.",
    tags: ["usd-checkout", "razorpay-international", "TEST-DELETE-ME"],
    shippingAddress: {
      firstName: "Test",
      lastName: "Buyer",
      address1: "1600 Amphitheatre Parkway",
      city: "Mountain View",
      provinceCode: "CA",
      zip: "94043",
      countryCode: "US",
      phone: "+14155551234",
    },
  };
  const variables = { order, options: { sendReceipt: false, sendFulfillmentReceipt: false } };

  if (dry) return json({ dry: true, wouldSend: variables });

  try {
    const res = await fetch(`https://${cfg.shopDomain}/admin/api/2025-01/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": cfg.shopifyAdminToken },
      body: JSON.stringify({ query: mutation, variables }),
    });
    const body = await res.json().catch(() => ({}));
    return json({
      httpStatus: res.status,
      userErrors: body?.data?.orderCreate?.userErrors ?? null,
      order: body?.data?.orderCreate?.order ?? null,
      topLevelErrors: body?.errors ?? null,
    });
  } catch (e: any) {
    return json({ error: String(e?.message || e) }, { status: 502 });
  }
};
