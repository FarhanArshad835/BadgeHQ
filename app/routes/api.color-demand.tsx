/**
 * Units sold per product COLOUR, so the storefront can rank colour cards.
 *
 *   GET /api/color-demand?shop=…&days=180
 *   { ok: true, demand: { "<handle>": { "Beige": 141, "Black": 38 } } }
 *
 * Colour cards split one product into one card per colour, and the grid then
 * has to decide which colour leads. Product-level sales cannot answer that:
 * every colour of a shoe shares them, so they all tie and the order falls back
 * to whatever Shopify listed first. Measured on Clogs, the colours of a single
 * shoe range from 141 units to 21 - a difference worth showing in the order.
 *
 * Colour is read from variantTitle, which Shopify writes as "Colour / Size".
 * Taking the part before the first slash is what makes this possible without
 * a variant-to-option lookup per line.
 *
 * Public and unauthenticated like /api/order, and for the same reason: a
 * storefront calls it. It returns nothing but how much of each already-public
 * colour has sold.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Sales move slowly at this grain, so an hour at the edge is plenty. */
const CACHE = { "Cache-Control": "public, max-age=600, s-maxage=3600" };

/** Long enough to be stable, short enough to still describe this season. */
const DEFAULT_DAYS = 180;

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

  const days = Math.min(
    365,
    Math.max(30, parseInt(String(url.searchParams.get("days") || ""), 10) || DEFAULT_DAYS),
  );

  // Grouped by handle rather than title: the storefront knows a card by the
  // handle in its link and has no reliable way back to the stored title.
  //
  // productId is a GID; the handle is not stored on the line, so the join is
  // through ProductScore, which the merchandising engine already keeps for
  // every product in the catalogue.
  const rows = await prisma.$queryRawUnsafe<
    Array<{ handle: string; color: string; units: number }>
  >(
    `SELECT s.handle AS handle,
            split_part(l."variantTitle", ' / ', 1) AS color,
            SUM(l.quantity)::int AS units
       FROM "OrderLineFinancials" l
       JOIN "ProductScore" s
         ON s.shop = l.shop AND s."productId" = l."productId"
      WHERE l.shop = $1
        AND l."variantTitle" <> ''
        AND s.handle <> ''
        AND l."orderCreatedAt" >= NOW() - ($2 || ' days')::interval
      GROUP BY 1, 2`,
    shop,
    String(days),
  );

  const demand: Record<string, Record<string, number>> = {};
  for (const r of rows) {
    const color = String(r.color || "").trim();
    if (!color) continue;
    // Lower-cased: the storefront reads the colour off the variant option and
    // the two casings do not always agree ("black" vs "Black" both occur in
    // this catalogue), which would otherwise split one colour into two.
    const key = color.toLowerCase();
    if (!demand[r.handle]) demand[r.handle] = {};
    demand[r.handle][key] = (demand[r.handle][key] || 0) + r.units;
  }

  return json({ ok: true, days, demand }, { headers: { ...CORS, ...CACHE } });
};
