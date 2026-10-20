/**
 * How alike two products are, for affinity ranking.
 *
 * Affinity answers "more like the one I just looked at" - a shopper who
 * engaged with a black stiletto should see other black stilettos lifted, not
 * a black t-shirt.
 *
 * Every weight here was set against this catalogue rather than chosen in the
 * abstract, and three plausible-sounding signals were dropped because the
 * measurements said they carry nothing:
 *
 *   price      80% of all product pairs fall within 30% of each other - the
 *              shop prices almost everything at 849 - so it would add a near
 *              constant to every comparison and separate nothing.
 *   vendor     two distinct values across 1,065 products.
 *   type       Shopify productType is set on 60%; titles name a kind on 92%,
 *              so productType is a fallback rather than the primary signal.
 */

/** A product reduced to what similarity actually reads. */
export type SimProduct = {
  productId: string;
  title: string;
  tags: string[];
  productType: string;
  colors: string[];
};

/* ------------------------------------------------------------------ kinds */

/**
 * The kinds of thing a product is, from its title.
 *
 * A set rather than one category: 31% of titles name more than one kind, and
 * they are descriptive rather than confused - "Platform Wedge Heels" really is
 * both a wedge and a heel. Two products are comparable when their sets
 * intersect, which is what lets a wedge heel sit alongside a stiletto while
 * keeping a t-shirt out.
 *
 * Read from the title only, not the tags. Tags here run to a median of 32 per
 * product and include things like "shoes for women" on apparel, so folding
 * them in makes nearly everything share a kind with everything.
 */
const KIND_PATTERNS: Array<[string, RegExp]> = [
  ["heel", /\bheels?\b|stiletto|\bpumps?\b|slingback/i],
  // Deliberately NOT "strappy" or "open-toe": 47 products use those words in
  // the title AND are heels, so matching on them labels heels as sandals.
  ["sandal", /\bsandals?\b|\bslides?\b|jutti?s?\b|\bmules?\b/i],
  ["wedge", /\bwedges?\b/i],
  ["flat", /\bflats?\b|ballerinas?|ballet|loafers?/i],
  ["sneaker", /sneakers?|trainers?/i],
  ["boot", /\bboots?\b/i],
  ["bag", /\bbags?\b|handbag|clutch|tote|crossbody|purse/i],
  ["apparel", /\btees?\b|t-?shirts?|\btops?\b|sweatshirt|crop|dress|gown|trousers?|pants?|skirt|jeans?/i],
];

export function getKinds(p: SimProduct): Set<string> {
  const kinds = new Set<string>();
  for (const [kind, re] of KIND_PATTERNS) {
    if (re.test(p.title)) kinds.add(kind);
  }
  // Juttis are the main gap in the title patterns - several are named only
  // "Embellished Pointed-Toe Jutti" with the kind in productType instead.
  if (!kinds.size && p.productType.trim()) {
    kinds.add("type:" + p.productType.trim().toLowerCase());
  }
  return kinds;
}

/* ----------------------------------------------------------------- colour */

/**
 * Colour families, because exact matching misses most real matches: the shop
 * uses 102 distinct colour values, and cherry/wine/maroon are one colour to a
 * shopper.
 */
const COLOR_FAMILIES: Array<[string, RegExp]> = [
  ["black", /black|charcoal|jet/i],
  ["white", /white|ivory|off.?white/i],
  ["cream", /cream|beige|nude|camel|\btan\b|apricot|oatmeal|sand/i],
  ["brown", /brown|coffee|chocolate|mocha|bronze/i],
  ["red", /\bred\b|cherry|wine|burgundy|maroon|rust/i],
  ["pink", /pink|peach|blush|rose|coral|fuchsia|magenta/i],
  ["blue", /blue|navy|denim|teal|aqua/i],
  ["green", /green|olive|mint|sage/i],
  ["purple", /purple|lilac|lavender|mauve|violet/i],
  ["yellow", /yellow|gold|mustard|lemon/i],
  ["grey", /grey|gray|silver|steel/i],
  ["multi", /multi|print|floral|animal|leopard|checker/i],
];

export function colorFamilies(p: SimProduct): Set<string> {
  const out = new Set<string>();
  for (const c of p.colors) {
    for (const [fam, re] of COLOR_FAMILIES) {
      if (re.test(c)) out.add(fam);
    }
  }
  return out;
}

/* ------------------------------------------------------------------- tags */

/**
 * Only the curated style tags count.
 *
 * The shop's own ht- prefix marks heel type - ht-stiletto, ht-block,
 * ht-wedge, ht-kitten - and is unambiguous where present (49% of products).
 * The rest of the tag list is marketing and SEO: an average random pair
 * already shares 5.2 tags, so counting all of them would score unrelated
 * products as close.
 */
function styleTags(p: SimProduct): Set<string> {
  const out = new Set<string>();
  for (const t of p.tags) {
    const s = t.toLowerCase().trim();
    if (s.startsWith("ht-")) out.add(s);
  }
  return out;
}

/* ------------------------------------------------------------------ title */

/** Words that appear on almost everything and so distinguish nothing. */
const STOP = new Set([
  "with", "for", "the", "and", "women", "womens", "women's", "ladies", "girls",
  "shoes", "shoe", "looks", "toe", "sole", "style", "new", "jm", "jmlooks",
  "fashion", "elegant", "stylish", "casual", "comfortable", "designer",
]);

function titleWords(title: string): Set<string> {
  return new Set(
    title
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w)),
  );
}

/** Jaccard overlap: shared words over the words either title uses. */
function titleOverlap(a: string, b: string): number {
  const A = titleWords(a);
  const B = titleWords(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  A.forEach((w) => {
    if (B.has(w)) shared++;
  });
  return shared / (A.size + B.size - shared);
}

/* ------------------------------------------------------------- similarity */

/**
 * 0 when the products are different kinds of thing, otherwise 0..1.
 *
 * The kind check is a gate rather than a weighted signal. Additively, a red
 * t-shirt and a red heel would score on colour alone and earn a boost - this
 * catalogue holds 220 products in the red family of which 64 are not footwear,
 * so that is not a hypothetical. Inside one kind, colour is the strongest
 * signal a shopper actually perceives.
 */
export function similarity(a: SimProduct, b: SimProduct): number {
  if (a.productId === b.productId) return 0;

  const ka = getKinds(a);
  const kb = getKinds(b);
  if (!ka.size || !kb.size) return 0; // uncategorisable: never guess
  let shares = false;
  ka.forEach((k) => {
    if (kb.has(k)) shares = true;
  });
  if (!shares) return 0;

  let score = 0;

  // Colour family - 99% coverage, and the thing a shopper notices first.
  const ca = colorFamilies(a);
  const cb = colorFamilies(b);
  let colorHit = false;
  ca.forEach((c) => {
    if (cb.has(c)) colorHit = true;
  });
  if (colorHit) score += 0.35;

  // Curated style tags. Scaled by how many are shared rather than a flat hit:
  // two products sharing ht-stiletto AND ht-party are closer than one.
  const ta = styleTags(a);
  const tb = styleTags(b);
  let sharedTags = 0;
  ta.forEach((t) => {
    if (tb.has(t)) sharedTags++;
  });
  if (sharedTags) score += Math.min(sharedTags / 2, 1) * 0.25;

  // Title overlap on meaningful words. Jaccard rather than a raw count, so a
  // long title does not score higher just for having more words.
  score += titleOverlap(a.title, b.title) * 0.25;

  // Shopify's own type, where both have one. Last because it is set on 60%.
  if (
    a.productType &&
    b.productType &&
    a.productType.toLowerCase() === b.productType.toLowerCase()
  ) {
    score += 0.15;
  }

  return Math.min(score, 1);
}
