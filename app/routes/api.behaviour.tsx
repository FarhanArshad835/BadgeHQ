/**
 * Storefront behaviour beacon.
 *
 * Receives ONE batched payload per session, sent via navigator.sendBeacon when
 * the page is hidden. At ~100k visitors/day a request per event would be ~12M
 * requests and ~12M rows a month; batching in the browser and counting in
 * aggregate rows here keeps both to a fraction of that.
 *
 *   POST /api/behaviour
 *   { shop, events: [{ p: "<numeric product id>", v?, d?, ca?, cr?, wa?, wr? }] }
 *
 * Returns 204 with no body, always and as fast as possible. A beacon has no
 * one to report to: the shopper has already left the page, and sendBeacon
 * ignores the response. Anything that could make this slow or throw has to be
 * caught rather than surfaced.
 *
 * Counts are clamped per session. The endpoint is public and unauthenticated -
 * it has to be, since it is called from a storefront - so the damage any one
 * caller can do to a ranking must be bounded by construction.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/** Beyond this many products in one payload, the rest is ignored: a real
 *  session does not touch 60 products, and accepting an unbounded list is how
 *  one request turns into a long-running write. */
const MAX_PRODUCTS = 60;

/** Per-session ceilings. One visitor cannot stuff the counters. */
const CAP = { v: 10, d: 5, ca: 5, cr: 5, wa: 3, wr: 3 };

const NO_CONTENT = () => new Response(null, { status: 204, headers: CORS });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Preflight can be routed to the loader on Vercel; answering it with 405
  // makes the browser silently drop the real POST.
  if (request.method === "OPTIONS") return NO_CONTENT();
  return NO_CONTENT();
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") return NO_CONTENT();

  try {
    const body: any = await request.json();
    const shop = String(body?.shop || "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) return NO_CONTENT();

    // Only collect for shops that asked for it. Checked before any write, so a
    // beacon aimed at a shop with the feature off costs one indexed read.
    const settings = await prisma.merchandiseSettings.findUnique({
      where: { shop },
      select: { isEnabled: true, useBehaviour: true },
    });
    if (!settings?.isEnabled || !settings.useBehaviour) return NO_CONTENT();

    const events = Array.isArray(body?.events) ? body.events.slice(0, MAX_PRODUCTS) : [];
    if (!events.length) return NO_CONTENT();

    // UTC midnight — the bucket key.
    const day = new Date();
    day.setUTCHours(0, 0, 0, 0);

    // Merge duplicates client-side mistakes might send, so each product is one
    // upsert rather than several.
    const merged = new Map<string, Record<string, number>>();
    for (const e of events) {
      const id = String(e?.p || "").replace(/\D/g, "");
      if (!id) continue;
      const cur = merged.get(id) || { v: 0, d: 0, ca: 0, cr: 0, wa: 0, wr: 0 };
      for (const k of ["v", "d", "ca", "cr", "wa", "wr"] as const) {
        const n = Number(e?.[k]);
        if (Number.isFinite(n) && n > 0) cur[k] = Math.min(cur[k] + Math.floor(n), CAP[k]);
      }
      merged.set(id, cur);
    }
    if (!merged.size) return NO_CONTENT();

    // One statement per product, incrementing in place. Not wrapped in a
    // transaction: these are independent counters, and a partial apply loses a
    // few increments rather than corrupting anything.
    await Promise.all(
      [...merged.entries()].map(([productId, c]) =>
        prisma.productBehaviour
          .upsert({
            where: { shop_productId_day: { shop, productId, day } },
            create: {
              shop,
              productId,
              day,
              views: c.v,
              dwell30: c.d,
              cartAdds: c.ca,
              cartRemoves: c.cr,
              wishAdds: c.wa,
              wishRemoves: c.wr,
            },
            update: {
              views: { increment: c.v },
              dwell30: { increment: c.d },
              cartAdds: { increment: c.ca },
              cartRemoves: { increment: c.cr },
              wishAdds: { increment: c.wa },
              wishRemoves: { increment: c.wr },
            },
          })
          .catch(() => {
            /* a lost increment is not worth failing a beacon over */
          }),
      ),
    );
  } catch {
    // Malformed payload, DB blip, anything: the shopper has already navigated
    // away and there is nothing useful to say to them.
  }

  return NO_CONTENT();
};
