/**
 * Hourly merchandising cron — rescores managed collections and writes the new
 * order to Shopify.
 *
 * Reads only data the app already holds (OrderLineFinancials) plus one bulk
 * Shopify read per collection, so it costs nothing per visitor. The storefront
 * is never involved.
 *
 * ?dry=1 scores and persists without reordering, which is how you check what
 * an ordering WOULD be before letting it touch a live collection.
 *
 * Guarded by CRON_SECRET, like the other crons here.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { runMerchandising } from "../utils/merchandise.server";

export const config = { maxDuration: 300 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("Authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const dryRun = new URL(request.url).searchParams.get("dry") === "1";

  const shops = await prisma.merchandiseSettings.findMany({
    where: { isEnabled: true },
    select: { shop: true },
  });

  const out: Record<string, unknown> = {};
  for (const { shop } of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      out[shop] = await runMerchandising(shop, admin, { dryRun });
    } catch (e: any) {
      // One shop's token problem must not stop the others.
      out[shop] = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  }

  return json({ ok: true, dryRun, shops: shops.length, results: out });
};
