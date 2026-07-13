/**
 * Wishlist cross-device sync for logged-in customers, via the App Proxy:
 *   /apps/badgehq/wishlist-sync
 *
 * Shopify verifies the signature (authenticate.public.appProxy) and appends
 * logged_in_customer_id only when the shopper has a storefront session —
 * that id is the only identity we trust. Guests never hit this endpoint
 * (widget.js keeps them localStorage-only).
 *
 * GET  -> { handles: string[] }
 * POST handles=<json array> -> { ok: true }   (replaces the stored list)
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_HANDLES = 250;
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

async function resolveContext(request: Request) {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) {
    return { error: json({ error: "unauthorized" }, { status: 401, headers: NO_STORE }) };
  }
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id") || "";
  if (!/^\d+$/.test(customerId)) {
    return { error: json({ error: "not-logged-in" }, { status: 401, headers: NO_STORE }) };
  }
  const settings = await prisma.wishlistSettings.findUnique({
    where: { shop: session.shop },
  });
  if (!settings || !settings.isEnabled) {
    return { error: json({ enabled: false }, { status: 200, headers: NO_STORE }) };
  }
  return { shop: session.shop, customerId };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await resolveContext(request);
  if ("error" in ctx) return ctx.error;

  const row = await prisma.wishlist.findUnique({
    where: { shop_customerId: { shop: ctx.shop, customerId: ctx.customerId } },
  });
  let handles: string[] = [];
  try {
    handles = row ? JSON.parse(row.handles) : [];
  } catch {
    handles = [];
  }
  return json({ handles }, { headers: NO_STORE });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "method-not-allowed" }, { status: 405, headers: NO_STORE });
  }
  const ctx = await resolveContext(request);
  if ("error" in ctx) return ctx.error;

  const form = new URLSearchParams(await request.text());
  let handles: unknown;
  try {
    handles = JSON.parse(form.get("handles") || "[]");
  } catch {
    return json({ error: "bad-json" }, { status: 400, headers: NO_STORE });
  }
  if (!Array.isArray(handles)) {
    return json({ error: "bad-handles" }, { status: 400, headers: NO_STORE });
  }
  const clean = Array.from(
    new Set(
      handles
        .filter((h): h is string => typeof h === "string")
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0 && h.length <= 255 && HANDLE_RE.test(h)),
    ),
  ).slice(0, MAX_HANDLES);

  await prisma.wishlist.upsert({
    where: { shop_customerId: { shop: ctx.shop, customerId: ctx.customerId } },
    create: { shop: ctx.shop, customerId: ctx.customerId, handles: JSON.stringify(clean) },
    update: { handles: JSON.stringify(clean) },
  });
  return json({ ok: true, count: clean.length }, { headers: NO_STORE });
};
