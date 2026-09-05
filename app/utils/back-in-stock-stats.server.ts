/**
 * Back in Stock analytics, from BackInStockSubscription.
 *
 * The interesting question is not "how many signed up" but "how many are still
 * WAITING": a shopper waiting on a product is demand you can act on, and a large
 * waiting count on one variant is a restock decision.
 */
import prisma from "../db.server";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

export type BackInStockStats = {
  days: Array<{ day: string; adds: number }>;
  signups: number;
  notified: number;
  waiting: number;
  products: number;
  shoppers: number; // distinct phone numbers
  topVariants: Array<{ variantId: string; productId: string; count: number }>;
};

export async function backInStockStats(
  shop: string,
  fromDay: string,
  toDay: string,
): Promise<BackInStockStats> {
  const since = new Date(Date.parse(`${fromDay}T00:00:00Z`) - IST_OFFSET_MS);
  const until = new Date(Date.parse(`${toDay}T00:00:00Z`) - IST_OFFSET_MS + DAY_MS);

  const [inWindow, waitingAll] = await Promise.all([
    prisma.backInStockSubscription.findMany({
      where: { shop, createdAt: { gte: since, lt: until } },
      select: { createdAt: true, phone: true, productId: true, variantId: true, notifiedAt: true },
    }),
    // "Still waiting" is a CURRENT state, not a windowed one: someone who signed
    // up months ago and is still waiting is exactly who the merchant needs to
    // know about, so this deliberately ignores the date range.
    prisma.backInStockSubscription.findMany({
      where: { shop, notifiedAt: null },
      select: { variantId: true, productId: true },
    }),
  ]);

  const byDay = new Map<string, number>();
  for (let t = Date.parse(`${fromDay}T00:00:00Z`); t <= Date.parse(`${toDay}T00:00:00Z`); t += DAY_MS) {
    byDay.set(new Date(t).toISOString().slice(0, 10), 0);
  }

  const shoppers = new Set<string>();
  const products = new Set<string>();
  let notified = 0;
  for (const s of inWindow) {
    const day = new Date(s.createdAt.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
    shoppers.add(s.phone);
    products.add(s.productId);
    if (s.notifiedAt) notified++;
  }

  // Rank by people still waiting: that is the restock signal.
  const byVariant = new Map<string, { productId: string; count: number }>();
  for (const w of waitingAll) {
    const e = byVariant.get(w.variantId) || { productId: w.productId, count: 0 };
    e.count++;
    byVariant.set(w.variantId, e);
  }

  return {
    days: Array.from(byDay.entries()).map(([day, adds]) => ({ day, adds })),
    signups: inWindow.length,
    notified,
    waiting: waitingAll.length,
    products: products.size,
    shoppers: shoppers.size,
    topVariants: Array.from(byVariant.entries())
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 5)
      .map(([variantId, v]) => ({ variantId, productId: v.productId, count: v.count })),
  };
}

/** Recent signups for the activity log. */
export async function recentBackInStockActivity(shop: string, limit = 50) {
  return prisma.backInStockSubscription.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, createdAt: true, phone: true, productId: true, variantId: true, notifiedAt: true },
  });
}
