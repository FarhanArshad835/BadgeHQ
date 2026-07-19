/**
 * Public back-in-stock signup endpoint.
 * Called from the storefront (widget.js) when a shopper asks to be notified
 * about a sold-out variant:
 *   POST /api/back-in-stock  { shop, variantId, productId, phone }
 *
 * Delivery is WhatsApp to the number the shopper types here — first-party data,
 * so this feature reads no Shopify customer records and needs no Protected
 * Customer Data access.
 *
 * Responses:
 *   200 { ok: true }
 *   200 { enabled: false }        — feature off for this shop; widget stays quiet
 *   400 { error: "..." }          — bad input
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { toIndianTenDigit } from "../utils/whatsapp.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const NO_STORE = { ...CORS_HEADERS, "Cache-Control": "no-store" };

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
  // Normalised to bare 10 digits; "" when missing or not a valid Indian mobile.
  const phone = toIndianTenDigit(body?.phone);

  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
    return json({ error: "bad-shop" }, { status: 400, headers: NO_STORE });
  }
  if (!/^\d+$/.test(variantId) || !/^\d+$/.test(productId)) {
    return json({ error: "bad-variant" }, { status: 400, headers: NO_STORE });
  }
  // The number IS the subscription — without it there is no way to notify.
  if (!phone) {
    return json({ error: "bad-phone" }, { status: 400, headers: NO_STORE });
  }

  const settings = await prisma.backInStockSettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled) {
    return json({ enabled: false }, { status: 200, headers: NO_STORE });
  }

  try {
    await prisma.backInStockSubscription.upsert({
      where: { shop_variantId_phone: { shop, variantId, phone } },
      create: { shop, variantId, productId, phone },
      // Re-signup after a previous notification: clear notifiedAt so they're
      // told again next time it restocks.
      update: { productId, notifiedAt: null },
    });
  } catch {
    return json({ error: "save-failed" }, { status: 500, headers: NO_STORE });
  }

  return json({ ok: true }, { headers: NO_STORE });
};
