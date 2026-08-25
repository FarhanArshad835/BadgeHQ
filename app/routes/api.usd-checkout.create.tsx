/**
 * Public endpoint the six-by-eleven storefront calls to start a USD checkout.
 * Body: { items: [{ variantId, quantity }] }  (the current cart)
 * Flow: look up each variant's INR base price from Shopify → compute USD (×markup
 * at the live rate) → create a Razorpay USD order → return { orderId, amount,
 * keyId } so the storefront opens Razorpay Checkout.
 *
 * Charges real USD via Razorpay International, OUTSIDE Shopify checkout. US only —
 * the storefront gates the button; this endpoint just prices + creates the order.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  getUsdConfig,
  getInrToUsdRate,
  cartUsdCents,
  createRazorpayUsdOrder,
  type UsdLineItem,
} from "../utils/usd-checkout.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  return json({ error: "POST only" }, { status: 405, headers: CORS });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (request.method !== "POST") return json({ error: "POST only" }, { status: 405, headers: CORS });

  const cfg = await getUsdConfig();
  if (!cfg.enabled) return json({ error: "USD checkout is off." }, { status: 400, headers: CORS });
  if (!cfg.razorpayKeyId || !cfg.razorpayKeySecret) {
    return json({ error: "Razorpay not configured." }, { status: 400, headers: CORS });
  }

  let payload: any;
  try {
    payload = await request.json();
  } catch {
    return json({ error: "Bad JSON." }, { status: 400, headers: CORS });
  }
  const rawItems: Array<{ variantId: string | number; quantity: number }> = Array.isArray(payload?.items)
    ? payload.items
    : [];
  if (!rawItems.length) return json({ error: "Empty cart." }, { status: 400, headers: CORS });

  // Resolve each variant's INR base price from Shopify (unit price, in paise).
  const variantGids = rawItems.map((i) => toVariantGid(i.variantId)).filter(Boolean);
  const priceByGid = await fetchVariantPricesPaise(cfg.shopDomain, cfg.shopifyAdminToken, variantGids);

  const items: UsdLineItem[] = [];
  for (const i of rawItems) {
    const gid = toVariantGid(i.variantId);
    const inrBasePaise = priceByGid.get(gid);
    if (inrBasePaise == null) continue; // variant not found/priced — skip
    items.push({ variantId: gid, quantity: Math.max(1, Number(i.quantity) || 1), inrBasePaise });
  }
  if (!items.length) return json({ error: "Could not price any items." }, { status: 400, headers: CORS });

  const rate = await getInrToUsdRate();
  if (!rate) return json({ error: "Exchange rate unavailable, try again." }, { status: 503, headers: CORS });

  const amountCents = cartUsdCents(items, cfg.markupBps, rate);
  if (amountCents < 50) return json({ error: "Amount too small." }, { status: 400, headers: CORS });

  const receipt = "sbe_usd_" + Math.round(rate * 1e6).toString(36) + "_" + amountCents;
  const order = await createRazorpayUsdOrder({
    keyId: cfg.razorpayKeyId,
    keySecret: cfg.razorpayKeySecret,
    amountCents,
    receipt,
    notes: { source: "six-by-eleven-usd-checkout", items: String(items.length) },
  });
  if (!order.ok) return json({ error: order.reason }, { status: 502, headers: CORS });

  return json(
    {
      ok: true,
      orderId: order.orderId,
      amount: order.amount, // USD cents
      amountUsd: (order.amount / 100).toFixed(2),
      currency: "USD",
      keyId: cfg.razorpayKeyId,
    },
    { headers: CORS },
  );
};

// ── helpers ──────────────────────────────────────────────────────────────────

function toVariantGid(v: string | number): string {
  const s = String(v || "").trim();
  if (!s) return "";
  if (s.startsWith("gid://")) return s;
  return `gid://shopify/ProductVariant/${s.replace(/\D/g, "")}`;
}

/** Fetch INR base unit prices (paise) for a set of variant gids via Admin GraphQL. */
async function fetchVariantPricesPaise(
  shop: string,
  token: string,
  gids: string[],
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  if (!shop || !token || !gids.length) return out;
  const url = `https://${shop}/admin/api/2025-01/graphql.json`;
  const query = `query($ids:[ID!]!){ nodes(ids:$ids){ ... on ProductVariant { id price } } }`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables: { ids: gids } }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    for (const n of body?.data?.nodes ?? []) {
      if (n?.id && n?.price != null) out.set(n.id, decimalToPaise(n.price));
    }
  } catch {
    // leave out empty — caller handles "could not price"
  }
  return out;
}

/** "1495.00" → 149500n paise, integer, no float drift. */
function decimalToPaise(amount: string): bigint {
  const s = String(amount ?? "").trim();
  const [w, f = ""] = s.split(".");
  const whole = w.replace(/\D/g, "") || "0";
  const frac = (f.replace(/\D/g, "") + "00").slice(0, 2);
  return BigInt(whole) * 100n + BigInt(frac);
}
