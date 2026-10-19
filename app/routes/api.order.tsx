/**
 * The ranked order for a collection, as handles.
 *
 *   GET /api/order?shop=…&collection=<handle>
 *   { ok: true, collection: "…", order: ["handle-a", "handle-b", …] }
 *
 * Ordering and rendering are separable, and this is the separation. A product
 * card is ~45KB of markup, so a theme can only paginate 24 at a time and the
 * storefront never holds more than a screenful. The ORDER is ~30 bytes per
 * product - about 11KB gzipped for a thousand-product collection, less than a
 * single product image - so the whole ranking can be shipped at once even
 * though the cards cannot.
 *
 * That lets the storefront know where every product belongs rather than only
 * the ones currently on screen: a shopper's wishlisted product sitting on page
 * 20 can be placed correctly without loading pages 2 through 19.
 *
 * Public and unauthenticated by necessity - a storefront calls it - so it
 * returns nothing but an ordering of handles that are already public.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Cached at the edge: the order only changes when the engine runs, hourly. */
const CACHE = { "Cache-Control": "public, max-age=300, s-maxage=3600" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "").trim().toLowerCase();
  const collection = String(url.searchParams.get("collection") || "").trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
    return json({ ok: false, error: "bad-shop" }, { status: 400, headers: CORS });
  }

  const settings = await prisma.merchandiseSettings.findUnique({
    where: { shop },
    select: { isEnabled: true, collectionIds: true },
  });
  if (!settings?.isEnabled) {
    return json({ ok: true, order: [] }, { headers: { ...CORS, ...CACHE } });
  }

  // Scores are per shop, not per collection: a product has one standing and
  // each collection is a subset of it. Ordering the whole catalogue once and
  // letting the storefront intersect it with what it is showing is both
  // cheaper and more useful than a list per collection.
  const rows = await prisma.productScore.findMany({
    where: { shop, handle: { not: "" } },
    orderBy: [{ inStock: "desc" }, { score: "desc" }],
    select: { handle: true },
  });

  return json(
    {
      ok: true,
      collection: collection || null,
      // Position in this array IS the rank. Sent as a bare array rather than
      // objects: at a thousand products the key names would cost more than the
      // data.
      order: rows.map((r) => r.handle),
    },
    { headers: { ...CORS, ...CACHE } },
  );
};
