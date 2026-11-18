/**
 * Mirror the shop's automatic discounts so a collection card can price locally.
 *
 * This is the same job bridge/discount-sync.js does for the cart page in the
 * jm-looks-app repo, and deliberately the same OUTPUT: field names, units and
 * vocabulary all match, so one bestOff() implementation can price a cart line
 * and a collection card and return the same figure. Two models of one rule set
 * is how a badge and the checkout start disagreeing.
 *
 * Why mirror rather than ask Shopify per card:
 *   - Hardcoding the rules went stale the day "200 OFF" was added; cards
 *     quoted the wrong saving, which is worse than quoting none.
 *   - Pricing each hypothetical cart through Shopify is exact but costs a
 *     round trip per product (~570ms measured, 25-cart batches failing), so a
 *     48-card collection page is unusable.
 *
 * What is deliberately NOT claimed: fixed-amount and percentage discounts
 * scoped to collections, named products, or everything. Buy-X-get-Y and
 * app-function discounts are recorded as unsupported rather than guessed at,
 * so a badge can stay silent instead of showing a number the checkout will
 * not honour.
 */
import prisma from "../db.server";

/**
 * automaticDiscountNodes is deprecated; discountNodes is its replacement and
 * returns code discounts too, which are filtered out below - a code discount
 * is not automatic, so it must never feed an unconditional card badge.
 */
const DISCOUNTS_QUERY = `#graphql
  query DiscountRules {
    discountNodes(first: 100) {
      nodes {
        id
        discount {
          __typename
          ... on DiscountAutomaticBasic {
            title
            status
            startsAt
            endsAt
            customerGets {
              value {
                __typename
                ... on DiscountPercentage { percentage }
                ... on DiscountAmount { amount { amount } appliesOnEachItem }
              }
              items {
                __typename
                ... on DiscountCollections { collections(first: 20) { nodes { handle } } }
                ... on DiscountProducts { products(first: 50) { nodes { id } } }
                ... on AllDiscountItems { allItems }
              }
            }
            minimumRequirement {
              __typename
              ... on DiscountMinimumQuantity { greaterThanOrEqualToQuantity }
              ... on DiscountMinimumSubtotal { greaterThanOrEqualToSubtotal { amount } }
            }
          }
          ... on DiscountAutomaticBxgy { title status }
          ... on DiscountAutomaticApp { title status }
        }
      }
    }
  }`;

/** One rule in the shape the storefront applies. Mirrors the cart pricer. */
export type NormalisedRule = {
  nodeId: string;
  title: string;
  status: string;
  kind: "amount" | "percent";
  amount: number;
  /** 0..1, NOT 0..100 - Shopify returns a fraction and the pricer multiplies by it. */
  percent: number;
  perItem: boolean;
  minQty: number;
  minSubtotal: number;
  allItems: boolean;
  products: string[];
  collections: string[];
  unsupported: boolean;
  unsupportedKind: string;
};

function emptyRule(nodeId: string, title: string, status: string): NormalisedRule {
  return {
    nodeId,
    title,
    status,
    kind: "amount",
    amount: 0,
    percent: 0,
    perItem: false,
    minQty: 0,
    minSubtotal: 0,
    allItems: false,
    products: [],
    collections: [],
    unsupported: false,
    unsupportedKind: "",
  };
}

/**
 * Turn one Admin discount node into the shape the storefront applies.
 *
 * Returns null for rules that are irrelevant rather than unmodellable - a code
 * discount, or one outside its own date window. Returns a row with
 * `unsupported` set for rules that EXIST but cannot be priced honestly, which
 * is a different thing and must reach the storefront so it can decline to
 * quote on affected products.
 */
export function normalise(nodeId: string, d: any): NormalisedRule | null {
  if (!d) return null;

  // Code discounts require the shopper to type something, so they must not
  // feed a badge that claims an automatic saving.
  if (typeof d.__typename === "string" && d.__typename.startsWith("DiscountCode")) {
    return null;
  }

  const title = d.title || "";
  const status = d.status || "";

  if (d.__typename !== "DiscountAutomaticBasic") {
    // Exists but cannot be modelled: Buy-X-get-Y, app-function discounts.
    const r = emptyRule(nodeId, title, status);
    r.unsupported = true;
    r.unsupportedKind = d.__typename || "unknown";
    return r;
  }

  // Keep non-active rules so the admin can see why a badge is not showing,
  // but do not let a scheduled or expired rule price anything: the serving
  // query filters on status.
  const now = Date.now();
  const windowClosed =
    (d.startsAt && Date.parse(d.startsAt) > now) ||
    (d.endsAt && Date.parse(d.endsAt) < now);

  const value = d.customerGets && d.customerGets.value;
  const items = d.customerGets && d.customerGets.items;
  if (!value || !items) return null;

  const rule = emptyRule(nodeId, title, windowClosed ? "EXPIRED" : status);

  if (value.__typename === "DiscountPercentage") {
    rule.kind = "percent";
    rule.percent = Number(value.percentage) || 0;
  } else if (value.__typename === "DiscountAmount") {
    rule.kind = "amount";
    rule.amount = parseFloat(value.amount?.amount ?? "0") || 0;
    rule.perItem = !!value.appliesOnEachItem;
  } else {
    rule.unsupported = true;
    rule.unsupportedKind = value.__typename || "unknown-value";
    return rule;
  }

  if (items.__typename === "DiscountCollections") {
    rule.collections = (items.collections?.nodes || []).map((c: any) => c.handle);
  } else if (items.__typename === "DiscountProducts") {
    // Product-scoped rules matter: the free-gift discounts work this way, and
    // treating them as unsupported made the page unable to tell a genuinely
    // free gift from a paid item wearing a FREE label.
    rule.products = (items.products?.nodes || []).map((p: any) =>
      String(p.id).split("/").pop(),
    );
  } else if (items.__typename === "AllDiscountItems") {
    rule.allItems = true;
  } else {
    rule.unsupported = true;
    rule.unsupportedKind = items.__typename || "unknown-items";
    return rule;
  }

  const min = d.minimumRequirement;
  if (min) {
    if (min.__typename === "DiscountMinimumQuantity") {
      rule.minQty = Number(min.greaterThanOrEqualToQuantity) || 0;
    } else if (min.__typename === "DiscountMinimumSubtotal") {
      rule.minSubtotal = parseFloat(min.greaterThanOrEqualToSubtotal?.amount ?? "0") || 0;
    }
  }

  return rule;
}

/**
 * Read every automatic discount and rewrite this shop's mirror.
 *
 * Rows are upserted by node id and rules that vanished from Shopify are
 * deleted, so a discount the merchant removes stops pricing cards within one
 * sync interval rather than lingering.
 */
export async function syncDiscountRules(
  shop: string,
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
): Promise<{ ok: boolean; synced: number; unsupported: number; error?: string }> {
  let nodes: any[];
  try {
    const res = await admin.graphql(DISCOUNTS_QUERY);
    const body: any = await res.json();
    if (body?.errors?.length) {
      return {
        ok: false,
        synced: 0,
        unsupported: 0,
        error: String(body.errors[0]?.message || "graphql error").slice(0, 200),
      };
    }
    nodes = body?.data?.discountNodes?.nodes || [];
  } catch (e: any) {
    return { ok: false, synced: 0, unsupported: 0, error: String(e?.message || e).slice(0, 200) };
  }

  const rules: NormalisedRule[] = [];
  for (const n of nodes) {
    const r = normalise(String(n.id), n.discount);
    if (r) rules.push(r);
  }

  // Upsert each, then drop whatever is no longer in Shopify. Done in that
  // order so a failed write leaves the old rule in place rather than leaving
  // the shop with no rules at all, which would silently un-badge every card.
  for (const r of rules) {
    const data = {
      shop,
      nodeId: r.nodeId,
      title: r.title,
      status: r.status,
      kind: r.kind,
      amount: r.amount,
      percent: r.percent,
      perItem: r.perItem,
      minQty: r.minQty,
      minSubtotal: r.minSubtotal,
      allItems: r.allItems,
      products: JSON.stringify(r.products),
      collections: JSON.stringify(r.collections),
      unsupported: r.unsupported,
      unsupportedKind: r.unsupportedKind,
      syncedAt: new Date(),
    };
    await prisma.discountRule.upsert({
      where: { shop_nodeId: { shop, nodeId: r.nodeId } },
      create: data,
      update: data,
    });
  }

  const keep = rules.map((r) => r.nodeId);
  await prisma.discountRule.deleteMany({
    where: { shop, nodeId: { notIn: keep.length ? keep : ["__none__"] } },
  });

  return {
    ok: true,
    synced: rules.filter((r) => !r.unsupported).length,
    unsupported: rules.filter((r) => r.unsupported).length,
  };
}
