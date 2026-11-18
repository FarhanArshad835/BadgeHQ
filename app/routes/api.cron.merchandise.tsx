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
import { syncDiscountRules } from "../utils/discount-sync.server";

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

  // Discount rules, for every shop running a badge - NOT only the ones with
  // merchandising on. A badge quoting a saving is the thing that goes wrong
  // when the mirror is stale, and badges are configured independently of
  // collection ordering, so gating this on merchandiseSettings would leave a
  // badge shop pricing cards from rules read who-knows-when.
  //
  // Cheap enough to run unconditionally: one Admin call per shop against a
  // list that is at most a hundred discounts, on an hourly cron.
  const ruleShops = await prisma.productBadge.findMany({
    where: { isActive: true },
    select: { shop: true },
    distinct: ["shop"],
  });
  const ruleOut: Record<string, unknown> = {};
  for (const { shop } of ruleShops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      ruleOut[shop] = await syncDiscountRules(shop, admin);
    } catch (e: any) {
      // A failed sync must leave the previous rules in place rather than
      // clearing them: stale-but-close beats a card with no badge at all,
      // and the next run retries in an hour.
      ruleOut[shop] = { ok: false, error: String(e?.message || e).slice(0, 200) };
    }
  }

  // Retention: behaviour rows older than any usable window are dead weight.
  // 120 days covers the longest sales window (90) with room to spare.
  await prisma.$executeRawUnsafe(
    `DELETE FROM "ProductBehaviour" WHERE day < NOW() - INTERVAL '120 days'`,
  ).catch(() => {
    /* housekeeping only - never fail a run over it */
  });

  return json({
    ok: true,
    dryRun,
    shops: shops.length,
    results: out,
    discountRules: ruleOut,
  });
};
