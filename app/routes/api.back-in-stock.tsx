/**
 * Public back-in-stock signup endpoint.
 * Called from the storefront (widget.js) when a shopper asks to be notified
 * about a sold-out variant:
 *   POST /api/back-in-stock  { shop, variantId, productId, email }
 *
 * Sending is Shopify-native (Flow trigger -> marketing automation -> Shopify
 * Email), and that path only reaches email-marketing subscribers — so signing
 * up also subscribes the shopper. The storefront form states this explicitly
 * before they submit.
 *
 * Responses:
 *   200 { ok: true }
 *   200 { enabled: false }        — feature off for this shop; widget stays quiet
 *   400 { error: "..." }          — bad input
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { isValidEmail, upsertSubscribedCustomer } from "../utils/back-in-stock.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const NO_STORE = { ...CORS_HEADERS, "Cache-Control": "no-store" };

// GET is only used for the CORS preflight some browsers send as GET.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json({ error: "Method not allowed" }, { status: 405, headers: NO_STORE });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: NO_STORE });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }

  const shop = String(body?.shop || "").trim();
  const variantId = String(body?.variantId || "").trim();
  const productId = String(body?.productId || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
    return json({ error: "bad-shop" }, { status: 400, headers: NO_STORE });
  }
  if (!/^\d+$/.test(variantId) || !/^\d+$/.test(productId)) {
    return json({ error: "bad-variant" }, { status: 400, headers: NO_STORE });
  }
  if (!isValidEmail(email)) {
    return json({ error: "bad-email" }, { status: 400, headers: NO_STORE });
  }

  const settings = await prisma.backInStockSettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled) {
    return json({ enabled: false }, { status: 200, headers: NO_STORE });
  }

  // Subscribe the shopper so the merchant's marketing automation can reach
  // them. Best-effort: if Shopify rejects it we still record the signup, and
  // the admin's subscriber list shows who couldn't be subscribed.
  let customerId: string | null = null;
  try {
    const { admin } = await unauthenticated.admin(shop);
    customerId = await upsertSubscribedCustomer(admin, email);
  } catch {
    customerId = null;
  }

  try {
    await prisma.backInStockSubscription.upsert({
      where: { shop_variantId_email: { shop, variantId, email } },
      create: { shop, variantId, productId, email, customerId },
      // Re-signup after a previous notification: clear notifiedAt so they're
      // told again next time it restocks.
      update: { productId, customerId, notifiedAt: null },
    });
  } catch {
    return json({ error: "save-failed" }, { status: 500, headers: NO_STORE });
  }

  return json({ ok: true }, { headers: NO_STORE });
};
