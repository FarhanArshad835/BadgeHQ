/**
 * Wishlist analytics, read from WishlistEvent.
 *
 * Everything here is derived from events recorded since the feature shipped —
 * there is no retroactive history, and the page says so rather than implying the
 * numbers cover all time.
 */
import prisma from "../db.server";

const DAY_MS = 24 * 60 * 60 * 1000;
// The store is India-first, like the rest of this app, so a "day" is an IST day.
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** YYYY-MM-DD for the IST day a UTC instant falls in. */
function istDay(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export type WishlistStats = {
  days: Array<{ day: string; adds: number }>;
  totalAdds: number;
  removes: number;
  customers: number; // distinct logged-in customers
  guestAdds: number;
  products: number; // distinct products wishlisted
  topProducts: Array<{ handle: string; count: number }>;
  topCustomers: Array<{ customerId: string; count: number }>;
  sentToMeta: number;
  failedToMeta: number;
};

/**
 * All figures for the last `windowDays` IST days, inclusive of today.
 * One pass over the window's events: the volumes here are small enough that
 * grouping in memory beats six round trips to Neon.
 */
export async function wishlistStats(shop: string, windowDays = 7): Promise<WishlistStats> {
  const since = new Date(Date.now() - (windowDays - 1) * DAY_MS);
  // Start from IST midnight of the earliest day, so the first bucket is whole.
  since.setUTCHours(0, 0, 0, 0);

  const events = await prisma.wishlistEvent.findMany({
    where: { shop, createdAt: { gte: since } },
    select: { createdAt: true, customerId: true, handle: true, action: true, metaStatus: true },
  });

  // Seed every day in the window so a quiet day plots as zero rather than
  // vanishing and distorting the shape of the line.
  const byDay = new Map<string, number>();
  for (let i = 0; i < windowDays; i++) {
    byDay.set(istDay(new Date(Date.now() - (windowDays - 1 - i) * DAY_MS)), 0);
  }

  const byProduct = new Map<string, number>();
  const byCustomer = new Map<string, number>();
  const customers = new Set<string>();
  let totalAdds = 0;
  let removes = 0;
  let guestAdds = 0;
  let sentToMeta = 0;
  let failedToMeta = 0;

  for (const e of events) {
    if (e.metaStatus === "sent") sentToMeta++;
    if (e.metaStatus === "failed") failedToMeta++;

    if (e.action === "remove") {
      removes++;
      continue; // the rest of these figures are about saves
    }
    totalAdds++;

    const day = istDay(e.createdAt);
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);

    byProduct.set(e.handle, (byProduct.get(e.handle) ?? 0) + 1);
    if (e.customerId) {
      customers.add(e.customerId);
      byCustomer.set(e.customerId, (byCustomer.get(e.customerId) ?? 0) + 1);
    } else {
      guestAdds++;
    }
  }

  const top = (m: Map<string, number>, n: number) =>
    Array.from(m.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);

  return {
    days: Array.from(byDay.entries()).map(([day, adds]) => ({ day, adds })),
    totalAdds,
    removes,
    customers: customers.size,
    guestAdds,
    products: byProduct.size,
    topProducts: top(byProduct, 5).map(([handle, count]) => ({ handle, count })),
    topCustomers: top(byCustomer, 5).map(([customerId, count]) => ({ customerId, count })),
    sentToMeta,
    failedToMeta,
  };
}

/**
 * Recent activity for the log. Capped: this is a "what just happened" view, not
 * an archive — the CSV export is the archive.
 */
export async function recentWishlistActivity(shop: string, limit = 50) {
  return prisma.wishlistEvent.findMany({
    where: { shop },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: { id: true, createdAt: true, customerId: true, handle: true, action: true, metaStatus: true },
  });
}
