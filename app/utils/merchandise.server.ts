/**
 * Collection merchandising — rank products, then write that order to Shopify.
 *
 * The storefront has no say in this: ordering is computed server-side and
 * persisted as the collection's Manual sort, so it applies to the whole
 * collection (not just the first page a shopper happens to load), survives
 * filtering, and costs the storefront nothing.
 *
 * Smart collections accept a manual order. Verified on this store:
 * "2 FOR 1299 Heels" carries VARIANT_PRICE rules AND sortOrder MANUAL. Shopify
 * keeps deciding membership; this decides the order within it.
 *
 * Signals, cheapest first:
 *   sales       OrderLineFinancials, already synced twice daily - free
 *   reviews     doran.prReviewCount metafield - one bulk read
 *   newness     publishedAt - same read
 *   stock       totalInventory - same read
 *   behaviour   storefront beacon (Phase 2) - zero until that ships
 *
 * Scores are stored UNWEIGHTED. Weighting happens at sort time, so changing a
 * weight re-ranks instantly without re-reading Shopify.
 */
import prisma from "../db.server";

/** Shopify caps a single reorder mutation's move list. Batched below it. */
const REORDER_BATCH = 250;

/**
 * Shopify runs collectionReorderProducts as an async job and allows only a
 * small number per shop at once. Collections are therefore reordered in
 * sequence, never in parallel - a fan-out here is what gets a shop throttled.
 */
const BETWEEN_COLLECTIONS_MS = 1500;

export type MerchSettings = {
  shop: string;
  isEnabled: boolean;
  collectionIds: string[];
  weightSales: number;
  weightReviews: number;
  weightNewArrival: number;
  weightBehaviour: number;
  weightCart: number;
  weightWish: number;
  weightDwell: number;
  weightViews: number;
  useSales: boolean;
  useReviews: boolean;
  useNewArrival: boolean;
  useBehaviour: boolean;
  useCart: boolean;
  useWish: boolean;
  useDwell: boolean;
  useViews: boolean;
  newArrivalDays: number;
  salesWindowDays: number;
  sinkOutOfStock: boolean;
};

export async function getMerchSettings(shop: string): Promise<MerchSettings> {
  const row = await prisma.merchandiseSettings.upsert({
    where: { shop },
    update: {},
    create: { shop },
  });
  let ids: string[] = [];
  try {
    const parsed = JSON.parse(row.collectionIds);
    if (Array.isArray(parsed)) ids = parsed.filter((x) => typeof x === "string");
  } catch {
    // A malformed value must not take the engine down - an empty allow-list
    // simply means nothing is reordered, which is the safe failure.
  }
  return { ...row, collectionIds: ids };
}

/**
 * Units sold per product over the rolling window.
 *
 * Counted on orderCreatedAt rather than deliveredAt: ranking should react to
 * what shoppers are buying now, not what finished its delivery leg three weeks
 * later. (The P&L deliberately uses the opposite basis, for the opposite
 * reason.)
 */
async function salesByProduct(shop: string, windowDays: number) {
  const rows = await prisma.$queryRawUnsafe<Array<{ productId: string; units: number }>>(
    `SELECT "productId", SUM(quantity)::int AS units
       FROM "OrderLineFinancials"
      WHERE shop = $1
        AND "productId" <> ''
        AND "orderCreatedAt" >= NOW() - ($2 || ' days')::interval
      GROUP BY "productId"`,
    shop,
    String(windowDays),
  );
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.productId, r.units);
  return map;
}

/** The four shopper actions, each kept separate so each can carry its own
 *  weight rather than being blended into one "behaviour" number. */
export type BehaviourCounts = {
  cart: number;
  wish: number;
  dwell: number;
  views: number;
};

/**
 * Net shopper actions per product, from the storefront beacon.
 *
 * Returns the four actions separately. They measure different things - an add
 * to cart is near-purchase intent, a view is barely a signal - and blending
 * them into a single figure meant a merchant could only tune the blend, never
 * say directly that a cart add matters more than a view.
 *
 * Removals subtract from their own action, floored at zero: a product added
 * then abandoned is a weaker bet than one never added, but it should not go
 * negative and start dragging down the other signals.
 *
 * No caps here. Each action is normalised against the best performer in the
 * same collection at scoring time, which bounds it to 0-1 naturally - the
 * per-action caps the old points system needed were only there because the
 * four were being summed into one raw number before weighting.
 *
 * Product ids arrive from the storefront as bare numbers; sales and Shopify
 * use GIDs. Normalised to the GID form here so one map keys the other.
 */
async function behaviourByProduct(shop: string, windowDays: number) {
  const rows = await prisma.$queryRawUnsafe<
    Array<{
      productId: string;
      views: number;
      dwell30: number;
      cartAdds: number;
      cartRemoves: number;
      wishAdds: number;
      wishRemoves: number;
    }>
  >(
    `SELECT "productId",
            SUM(views)::int        AS views,
            SUM(dwell30)::int      AS dwell30,
            SUM("cartAdds")::int    AS "cartAdds",
            SUM("cartRemoves")::int AS "cartRemoves",
            SUM("wishAdds")::int    AS "wishAdds",
            SUM("wishRemoves")::int AS "wishRemoves"
       FROM "ProductBehaviour"
      WHERE shop = $1 AND day >= NOW() - ($2 || ' days')::interval
      GROUP BY "productId"`,
    shop,
    String(windowDays),
  );

  const map = new Map<string, BehaviourCounts>();
  for (const r of rows) {
    map.set(`gid://shopify/Product/${r.productId}`, {
      cart: Math.max(r.cartAdds - r.cartRemoves, 0),
      wish: Math.max(r.wishAdds - r.wishRemoves, 0),
      dwell: r.dwell30,
      views: r.views,
    });
  }
  return map;
}

type ProductFacts = {
  productId: string;
  reviewCount: number;
  publishedAt: Date | null;
  inStock: boolean;
};

/**
 * Publish date, stock and review count for every product in the collections
 * being managed.
 *
 * Read per collection rather than across the whole catalogue: only products
 * that are actually going to be ranked are worth a query, and the store has
 * ~1,200 products against collections as small as 13.
 */
export async function fetchCollectionProducts(
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
  collectionId: string,
): Promise<ProductFacts[]> {
  const out: ProductFacts[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < 40; page++) {
    const res: Response = await admin.graphql(
      `#graphql
      query CollectionProducts($id: ID!, $cursor: String) {
        collection(id: $id) {
          products(first: 250, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id
              publishedAt
              totalInventory
              reviews: metafield(namespace: "doran", key: "prReviewCount") { value }
            }
          }
        }
      }`,
      { variables: { id: collectionId, cursor } },
    );
    const body: any = await res.json();
    const conn = body?.data?.collection?.products;
    if (!conn) break;

    for (const n of conn.nodes || []) {
      out.push({
        productId: String(n.id),
        reviewCount: Math.max(0, Number(n.reviews?.value) || 0),
        publishedAt: n.publishedAt ? new Date(n.publishedAt) : null,
        // totalInventory is null for products that do not track inventory;
        // those are always purchasable, so they must not be treated as sold out.
        inStock: n.totalInventory == null || Number(n.totalInventory) > 0,
      });
    }

    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

/**
 * Turn raw signals into a 0-1000 score.
 *
 * Each signal is normalised to 0-1 against the best performer in the SAME
 * collection, then weighted. Normalising per collection matters: a 13-product
 * bag collection and a 1,064-product catch-all have wildly different sales
 * ceilings, and a global scale would flatten the small one to nothing.
 *
 * Sales uses a log curve. Linear normalisation against a 2,242-unit top seller
 * would push everything else to near-zero, which stops the other signals from
 * being able to separate anything.
 */
export function computeScores(
  facts: ProductFacts[],
  sales: Map<string, number>,
  behaviour: Map<string, BehaviourCounts>,
  s: MerchSettings,
): Array<{
  productId: string;
  score: number;
  inStock: boolean;
  unitsSold: number;
  /** What each signal contributed, on the same 0-1000 scale as the score, so
   *  a merchant can see WHY a product ranks where it does rather than having
   *  to trust the total. Only enabled signals appear. */
  parts: Array<{ label: string; points: number; detail: string }>;
}> {
  const now = Date.now();
  const newMs = s.newArrivalDays * 86400_000;

  const unitsOf = (p: ProductFacts) => sales.get(p.productId) ?? 0;
  const behOf = (p: ProductFacts) =>
    behaviour.get(p.productId) ?? { cart: 0, wish: 0, dwell: 0, views: 0 };

  const maxUnitsLog = Math.max(...facts.map((p) => Math.log1p(unitsOf(p))), 1);
  const maxReviews = Math.max(...facts.map((p) => p.reviewCount), 1);

  // Each action is normalised against the best performer in the SAME
  // collection, so a weight means the same thing whether an action happens ten
  // times a day or ten thousand. This is also what replaces the old per-action
  // caps: a runaway count can only ever reach 1.0 of its own signal, it cannot
  // leak into the others.
  const maxCart = Math.max(...facts.map((p) => behOf(p).cart), 1);
  const maxWish = Math.max(...facts.map((p) => behOf(p).wish), 1);
  const maxDwell = Math.max(...facts.map((p) => behOf(p).dwell), 1);
  const maxViews = Math.max(...facts.map((p) => behOf(p).views), 1);

  // Only enabled signals share the weight, so switching one off redistributes
  // to the others rather than shrinking every score toward zero.
  const totalWeight =
    (s.useSales ? s.weightSales : 0) +
    (s.useReviews ? s.weightReviews : 0) +
    (s.useNewArrival ? s.weightNewArrival : 0) +
    (s.useCart ? s.weightCart : 0) +
    (s.useWish ? s.weightWish : 0) +
    (s.useDwell ? s.weightDwell : 0) +
    (s.useViews ? s.weightViews : 0) || 1;

  return facts.map((p) => {
    const units = unitsOf(p);
    const b = behOf(p);

    const parts: Array<{ label: string; points: number; detail: string }> = [];
    // Each signal contributes (its 0-1 share) x (its weight). Recorded on the
    // same 0-1000 scale the final score uses, so the parts add up to the total
    // a merchant sees rather than to some internal intermediate.
    const add = (on: boolean, label: string, share: number, weight: number, detail: string) => {
      if (!on) return;
      parts.push({ label, points: Math.round((share * weight) / totalWeight * 1000), detail });
    };

    add(s.useSales, "Best sellers", Math.log1p(units) / maxUnitsLog, s.weightSales,
      `${units} sold`);
    add(s.useReviews, "Reviews", p.reviewCount / maxReviews, s.weightReviews,
      `${p.reviewCount} review${p.reviewCount === 1 ? "" : "s"}`);
    if (s.useNewArrival) {
      // Decays across the window rather than dropping off a cliff on day 31.
      const ageDays = p.publishedAt ? (now - p.publishedAt.getTime()) / 86400_000 : Infinity;
      const freshness = p.publishedAt && ageDays * 86400_000 < newMs ? 1 - (ageDays * 86400_000) / newMs : 0;
      add(true, "New arrival", freshness, s.weightNewArrival,
        Number.isFinite(ageDays) ? `${Math.round(ageDays)}d old` : "no date");
    }
    add(s.useCart, "Added to cart", b.cart / maxCart, s.weightCart, `${b.cart}`);
    add(s.useWish, "Wishlisted", b.wish / maxWish, s.weightWish, `${b.wish}`);
    add(s.useDwell, "Viewed 30s+", b.dwell / maxDwell, s.weightDwell, `${b.dwell}`);
    add(s.useViews, "Views", b.views / maxViews, s.weightViews, `${b.views}`);

    return {
      productId: p.productId,
      // Rounded from the summed parts, not from the raw score. Rounding each
      // part independently can leave their total 1 off a separately-rounded
      // score, and a breakdown that does not add up to the number beside it
      // reads as a bug even when the ranking is right.
      score: parts.reduce((a, x) => a + x.points, 0),
      inStock: p.inStock,
      unitsSold: units,
      parts,
    };
  });
}

/**
 * Final ordering.
 *
 * Out-of-stock products sink below every in-stock one but keep their relative
 * order among themselves - they are NOT pinned to the very bottom. A sold-out
 * best seller still carries its Back in Stock signup, and burying it under
 * genuinely weak products loses those captures.
 */
export function rankProducts(
  scored: Array<{ productId: string; score: number; inStock: boolean }>,
  sinkOutOfStock: boolean,
): string[] {
  return [...scored]
    .sort((a, b) => {
      if (sinkOutOfStock && a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      return b.score - a.score;
    })
    .map((p) => p.productId);
}

/**
 * Write an order to Shopify.
 *
 * `moves` is absolute: each entry names where a product should end up. Sent in
 * batches because the mutation caps its move list, and sequentially because
 * each call queues an async job on Shopify's side.
 */
export async function applyOrder(
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
  collectionId: string,
  orderedIds: string[],
): Promise<{ ok: boolean; error?: string }> {
  // Shopify refuses a reorder outright unless the collection is on MANUAL
  // sort - "Can't reorder products unless collection is manually sorted" - so
  // switch it first. Harmless when it is already MANUAL, and it is what the
  // admin screen promises when it marks a collection "will switch to manual
  // sort".
  const sortRes = await admin.graphql(
    `#graphql
    mutation SetManual($input: CollectionInput!) {
      collectionUpdate(input: $input) {
        collection { id sortOrder }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: collectionId, sortOrder: "MANUAL" } } },
  );
  const sortBody: any = await sortRes.json();
  const sortErrs = sortBody?.data?.collectionUpdate?.userErrors || [];
  if (sortErrs.length) {
    return {
      ok: false,
      error: `could not set manual sort: ${sortErrs.map((e: any) => e.message).join("; ")}`.slice(0, 300),
    };
  }

  for (let i = 0; i < orderedIds.length; i += REORDER_BATCH) {
    const moves = orderedIds
      .slice(i, i + REORDER_BATCH)
      .map((id, n) => ({ id, newPosition: String(i + n) }));

    const res = await admin.graphql(
      `#graphql
      mutation Reorder($id: ID!, $moves: [MoveInput!]!) {
        collectionReorderProducts(id: $id, moves: $moves) {
          userErrors { field message }
        }
      }`,
      { variables: { id: collectionId, moves } },
    );
    const body: any = await res.json();
    const errs = body?.data?.collectionReorderProducts?.userErrors || [];
    if (errs.length) return { ok: false, error: errs.map((e: any) => e.message).join("; ").slice(0, 300) };
  }
  return { ok: true };
}

/** Persist the inputs behind each rank, so the admin screen can explain them. */
async function saveScores(
  shop: string,
  facts: ProductFacts[],
  scored: Array<{ productId: string; score: number; unitsSold: number }>,
) {
  const factBy = new Map(facts.map((f) => [f.productId, f]));
  // Chunked: a single transaction over 1,000+ upserts holds a connection far
  // longer than this needs to.
  for (let i = 0; i < scored.length; i += 100) {
    await Promise.all(
      scored.slice(i, i + 100).map((s) => {
        const f = factBy.get(s.productId);
        const data = {
          unitsSold: s.unitsSold,
          reviewCount: f?.reviewCount ?? 0,
          publishedAt: f?.publishedAt ?? null,
          inStock: f?.inStock ?? true,
          score: s.score,
        };
        return prisma.productScore.upsert({
          where: { shop_productId: { shop, productId: s.productId } },
          update: data,
          create: { shop, productId: s.productId, ...data },
        });
      }),
    );
  }
}

/**
 * One full pass: score every managed collection and write the new order.
 *
 * Returns per-collection results rather than throwing, so one bad collection
 * (deleted, or renamed out from under the allow-list) does not stop the rest.
 */
export async function runMerchandising(
  shop: string,
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
  opts: { dryRun?: boolean } = {},
): Promise<{
  ok: boolean;
  collections: Array<{ id: string; products: number; reordered: boolean; error?: string }>;
}> {
  const s = await getMerchSettings(shop);
  if (!s.isEnabled || !s.collectionIds.length) {
    return { ok: false, collections: [] };
  }

  const sales = await salesByProduct(shop, s.salesWindowDays);

  const anyBehaviour = s.useCart || s.useWish || s.useDwell || s.useViews;
  const behaviour = anyBehaviour
    ? await behaviourByProduct(shop, s.salesWindowDays)
    : new Map<string, BehaviourCounts>();

  const results: Array<{ id: string; products: number; reordered: boolean; error?: string }> = [];

  for (const collectionId of s.collectionIds) {
    try {
      const facts = await fetchCollectionProducts(admin, collectionId);
      if (!facts.length) {
        results.push({ id: collectionId, products: 0, reordered: false, error: "empty or missing" });
        continue;
      }

      const scored = computeScores(facts, sales, behaviour, s);
      await saveScores(shop, facts, scored);

      if (opts.dryRun) {
        results.push({ id: collectionId, products: facts.length, reordered: false });
        continue;
      }

      const ordered = rankProducts(scored, s.sinkOutOfStock);
      const applied = await applyOrder(admin, collectionId, ordered);
      results.push({
        id: collectionId,
        products: facts.length,
        reordered: applied.ok,
        error: applied.error,
      });
    } catch (e: any) {
      results.push({
        id: collectionId,
        products: 0,
        reordered: false,
        error: String(e?.message || e).slice(0, 200),
      });
    }

    // Paced between collections: each reorder queues an async job on Shopify,
    // and firing them back to back is what triggers throttling.
    await new Promise((r) => setTimeout(r, BETWEEN_COLLECTIONS_MS));
  }

  await prisma.merchandiseSettings.update({
    where: { shop },
    data: {
      lastRunAt: new Date(),
      lastRunStatus: results.every((r) => r.reordered || r.products === 0)
        ? `ok: ${results.length} collections`
        : `partial: ${results.filter((r) => r.error).length} failed`,
    },
  });

  return { ok: true, collections: results };
}
