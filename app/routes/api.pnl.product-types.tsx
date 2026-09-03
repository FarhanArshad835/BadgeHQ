/**
 * TEMPORARY. Lists the distinct product types in the catalogue with their share
 * of delivered revenue, so GST rates can be mapped to real categories instead of
 * guessed. Secret-guarded; DELETE once the mapping is decided.
 */
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { getPnlApp, tokenAdmin } from "../utils/pnl-app.server";

const SECRET = "SBE_TYPES_7c1";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const app = await getPnlApp();
  if (!app.shopDomain || !app.adminToken) return json({ error: "not configured" });
  const admin = tokenAdmin(app.shopDomain, app.adminToken);

  const types = new Map<string, { products: number; sample: string[] }>();
  let cursor: string | null = null;
  let pages = 0;
  while (pages < 20) {
    const res: any = await admin.graphql(
      `query T($cursor: String) {
        products(first: 250, after: $cursor) {
          nodes { title productType tags }
          pageInfo { hasNextPage endCursor }
        }
      }`,
      { variables: { cursor } },
    );
    const body = await res.json();
    const p = body?.data?.products;
    if (!p) return json({ error: "query failed", body: body?.errors ?? null });
    for (const n of p.nodes ?? []) {
      const t = (n.productType || "(blank)").trim() || "(blank)";
      const e = types.get(t) || { products: 0, sample: [] };
      e.products++;
      if (e.sample.length < 3) e.sample.push(n.title);
      types.set(t, e);
    }
    pages++;
    if (!p.pageInfo?.hasNextPage) break;
    cursor = p.pageInfo.endCursor;
  }

  return json({
    shop: app.shopDomain,
    productTypes: Array.from(types.entries())
      .map(([type, v]) => ({ type, products: v.products, sample: v.sample }))
      .sort((a, b) => b.products - a.products),
  });
};
