/**
 * Public back-in-stock signup endpoint.
 * Called from the storefront (widget.js) when a shopper asks to be notified
 * about a sold-out variant:
 *   POST /api/back-in-stock  { shop, variantId, productId, email, phone }
 *
 * Delivery is WhatsApp (Interakt) to the number the shopper types here —
 * first-party data, so nothing about notifying them reads Shopify customer
 * records. Mirroring them into the customer list is an optional bonus, gated
 * on the shop having granted write_customers.
 *
 * Responses:
 *   200 { ok: true, reachable, subscribed }
 *   200 { enabled: false }        — feature off for this shop; widget stays quiet
 *   400 { error: "..." }          — bad input
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { isValidEmail, upsertSubscribedCustomer } from "../utils/back-in-stock.server";
import { toIndianTenDigit } from "../utils/whatsapp.server";

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
  // Normalised to bare 10 digits; "" when missing or not a valid Indian mobile.
  // Deliberately NOT rejected server-side: an older cached widget sends no
  // phone, and recording the signup beats erroring (the row shows as
  // unreachable in the admin list).
  const phone = toIndianTenDigit(body?.phone);

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

  // OPTIONAL bonus: mirror the shopper into Shopify's customer list so the
  // merchant's marketing automation can also reach them. Runs ONLY when this
  // shop granted write_customers — a shop without it makes zero customer API
  // calls. Delivery is WhatsApp and never depends on this.
  //
  // The granted scopes are read from the stored session rather than a live
  // GraphQL call: this is the shopper's request path, so latency matters.
  let customerId: string | null = null;
  try {
    const session = await prisma.session.findFirst({
      where: { shop },
      orderBy: { expires: "desc" },
    });
    if ((session?.scope || "").includes("write_customers")) {
      const { admin } = await unauthenticated.admin(shop);
      customerId = await upsertSubscribedCustomer(admin, email);
    }
  } catch {
    customerId = null; // never block the signup on the bonus path
  }

  try {
    await prisma.backInStockSubscription.upsert({
      where: { shop_variantId_email: { shop, variantId, email } },
      create: { shop, variantId, productId, email, phone, customerId },
      // Re-signup after a previous notification: clear notifiedAt so they're
      // told again next time it restocks. Only overwrite the phone when a new
      // one was supplied, so an old widget can't blank a good number.
      update: { productId, customerId, notifiedAt: null, ...(phone ? { phone } : {}) },
    });
  } catch {
    return json({ error: "save-failed" }, { status: 500, headers: NO_STORE });
  }

  // `reachable` = we have a WhatsApp number (the real delivery signal).
  // `subscribed` = the optional Shopify-customer mirror succeeded.
  return json(
    { ok: true, reachable: Boolean(phone), subscribed: Boolean(customerId) },
    { headers: NO_STORE },
  );
};
