// Public storefront endpoint that exposes per-product totals (inventory,
// price, created_at) using the merchant's stored Admin API access token
// server-side. This is the equivalent of ShineTrust's
// `templates/search.shinetrust.product-handles.liquid` approach — instead
// of a Liquid template installed in the theme, we hit Shopify's Admin API
// from our backend (which has full inventory visibility regardless of the
// storefront API restrictions that hide inventory_quantity).
//
// The widget calls this once per page load and caches the response in
// sessionStorage, then uses the inventory totals for badge condition checks
// like "inventory > 300", "low stock", etc.
//
// Cached at the edge for 5 minutes via s-maxage so we don't hit Shopify's
// admin rate limit on every visitor.
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

const API_VERSION = "2024-10";
const PAGE_LIMIT = 250;
const MAX_PRODUCTS = 5000; // 20 paginated calls — generous cap

type Inventory = {
  inventory: number; // -1 = continue policy on at least one variant (treat as infinite); -2 = untracked
  price: number;
  compare_at_price: number;
  created_at: string;
  product_type: string;
  vendor: string;
  tags: string[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const reqUrl = new URL(request.url);
  const shop = reqUrl.searchParams.get("shop");
  if (!shop) return json({ error: "Missing shop parameter" }, { status: 400 });

  // Pull the most-recent offline session for this shop. The widget runs on
  // the storefront and doesn't carry auth — we rely on the merchant having
  // installed the app, which left an offline access token in our DB.
  const session = await prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    return json({ error: "Shop not authorized" }, {
      status: 403,
      headers: { "Access-Control-Allow-Origin": "*" },
    });
  }

  const products: Record<string, Inventory> = {};
  let pageInfo: string | null = null;
  let collected = 0;
  let pages = 0;
  const accessToken: string = session.accessToken;

  while (collected < MAX_PRODUCTS) {
    const apiUrl: string = pageInfo
      ? `https://${shop}/admin/api/${API_VERSION}/products.json?limit=${PAGE_LIMIT}&page_info=${encodeURIComponent(pageInfo)}`
      : `https://${shop}/admin/api/${API_VERSION}/products.json?limit=${PAGE_LIMIT}&fields=id,handle,variants,created_at,product_type,vendor,tags`;

    const r: Response = await fetch(apiUrl, {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
    });
    if (!r.ok) break;
    const body: any = await r.json();
    const items: any[] = (body && body.products) || [];

    for (const p of items) {
      let total = 0;
      let anyTracked = false;
      let infinite = false;
      const variants = p.variants || [];
      for (const v of variants) {
        // inventory_management null/empty = untracked; skip
        if (!v.inventory_management) continue;
        if (v.inventory_policy === "continue") {
          infinite = true;
          continue;
        }
        const q = v.inventory_quantity;
        if (q !== null && q !== undefined && !isNaN(q)) {
          total += q;
          anyTracked = true;
        }
      }
      const v0 = variants[0] || {};
      products[p.handle] = {
        inventory: infinite ? -1 : anyTracked ? total : -2,
        price: parseFloat(v0.price) || 0,
        compare_at_price: parseFloat(v0.compare_at_price) || 0,
        created_at: p.created_at,
        product_type: p.product_type || "",
        vendor: p.vendor || "",
        tags: Array.isArray(p.tags) ? p.tags : (p.tags || "").split(",").map((t: string) => t.trim()).filter(Boolean),
      };
      collected++;
      if (collected >= MAX_PRODUCTS) break;
    }
    pages++;

    // Shopify cursor pagination via the Link header
    const linkHeader: string | null = r.headers.get("link") || r.headers.get("Link");
    const nextMatch: RegExpMatchArray | null = linkHeader ? linkHeader.match(/<([^>]+)>;\s*rel="next"/) : null;
    if (!nextMatch) break;
    try {
      const nextUrl: URL = new URL(nextMatch[1]);
      pageInfo = nextUrl.searchParams.get("page_info");
      if (!pageInfo) break;
    } catch {
      break;
    }
  }

  return json(
    { products, count: collected, pages, truncated: collected >= MAX_PRODUCTS },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        // Edge cache for 5 minutes; merchants get fresh inventory after
        // that without us hammering the Admin API on every visitor.
        "Cache-Control": "public, max-age=60, s-maxage=300",
      },
    }
  );
};
