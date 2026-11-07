/**
 * The ordered colour-card list for one collection.
 *
 *   GET /api/color-order?shop=…&collection=<handle>
 *   { ok: true, builtAt: 1770…, cards: [[handle, colour, image, variantId, soldOut], …] }
 *
 * The storefront can only order the colours on the page it has. Shopify sends
 * 24 products, the split turns them into ~73 cards, and a colour that belongs
 * on page 5 sits on page 1 until the next batch pushes it down — measured at
 * 42 of 73 cards moving after a single scroll.
 *
 * This list is built from the whole collection by the hourly engine, so the
 * storefront no longer has to decide anything: it renders the list in order.
 *
 * Positional arrays rather than objects: at ~2,800 cards the key names cost
 * more than the data they label.
 *
 * Public and unauthenticated like the other storefront routes, and for the
 * same reason — it returns an ordering of products that are already public.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Rebuilt hourly by the engine, so an hour at the edge is the natural TTL. */
const CACHE = { "Cache-Control": "public, max-age=300, s-maxage=3600" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS });
  }

  const url = new URL(request.url);
  const shop = String(url.searchParams.get("shop") || "")
    .trim()
    .toLowerCase();
  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
    return json({ ok: false, error: "bad-shop" }, { status: 400, headers: CORS });
  }

  const collection = String(url.searchParams.get("collection") || "")
    .trim()
    .toLowerCase();
  if (!collection) {
    return json({ ok: false, error: "no-collection" }, { status: 400, headers: CORS });
  }

  const row = await prisma.collectionColorOrder.findUnique({
    where: { shop_handle: { shop, handle: collection } },
    select: { cards: true, builtAt: true },
  });

  // No row means the engine has not built this collection — it is not managed,
  // or has not run since this shipped. An empty list is the honest answer: the
  // storefront then splits what it has, exactly as it did before.
  if (!row) {
    return json({ ok: true, builtAt: 0, cards: [] }, { headers: { ...CORS, ...CACHE } });
  }

  let all: unknown = [];
  try {
    all = JSON.parse(row.cards);
  } catch {
    all = [];
  }
  const cards = Array.isArray(all) ? all : [];

  // Served a page at a time.
  //
  // The whole 2,941-card list is 80KB brotli on this collection, and 46KB
  // of that is image paths: 2,889 of them are unique Shopify hashes, so
  // they do not compress and no amount of prefix-stripping helps - both
  // that and a handle index were measured at 79KB, against 80KB for the
  // plain list.
  //
  // A shopper reads 24 cards at a time, so sending 2,941 to render 24 is
  // the real waste. One page is a couple of KB, and the next is fetched
  // while they scroll.
  const offset = Math.max(0, parseInt(String(url.searchParams.get("offset") || "0"), 10) || 0);
  const limit = Math.min(240, Math.max(1, parseInt(String(url.searchParams.get("limit") || "48"), 10) || 48));

  return json(
    {
      ok: true,
      builtAt: row.builtAt.getTime(),
      total: cards.length,
      offset,
      cards: cards.slice(offset, offset + limit),
    },
    { headers: { ...CORS, ...CACHE } },
  );
};
