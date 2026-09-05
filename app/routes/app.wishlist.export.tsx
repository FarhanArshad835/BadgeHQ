/**
 * Wishlist CSV export — "which customer wishlisted which product", the thing
 * merchants actually ask for.
 *
 * Downloads the WishlistEvent history rather than the Wishlist rows: the latter
 * is a destructive upsert of current state and cannot say WHEN something was
 * saved. History therefore starts when this feature shipped — there is nothing
 * retroactive, and the admin page says so.
 *
 * Resource route: returns a raw Response (a CSV is not json()).
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const MAX_ROWS = 50_000; // a spreadsheet's practical limit; also bounds the query

/** Quote every field and double any embedded quote — product titles contain commas. */
const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/**
 * Resolve handles to product titles so the file is readable by a human. Best
 * effort: a deleted product simply exports with a blank title rather than
 * failing the whole download.
 */
async function titlesByHandle(
  admin: { graphql: (q: string, o?: { variables?: any }) => Promise<Response> },
  handles: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!handles.length) return out;

  // Shopify's search caps query length, so ask in modest batches.
  const CHUNK = 40;
  for (let i = 0; i < handles.length; i += CHUNK) {
    const batch = handles.slice(i, i + CHUNK);
    const query = batch.map((h) => `handle:${JSON.stringify(h)}`).join(" OR ");
    try {
      const res = await admin.graphql(
        `query WishlistTitles($q: String!) {
          products(first: 50, query: $q) { nodes { handle title } }
        }`,
        { variables: { q: query } },
      );
      const body: any = await res.json();
      for (const n of body?.data?.products?.nodes ?? []) {
        if (n?.handle) out.set(String(n.handle), String(n.title ?? ""));
      }
    } catch {
      // Leave these titles blank rather than failing the export.
    }
  }
  return out;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const events = await prisma.wishlistEvent.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    take: MAX_ROWS,
    select: { createdAt: true, customerId: true, handle: true, productId: true, action: true },
  });

  const titles = await titlesByHandle(admin, Array.from(new Set(events.map((e) => e.handle))));

  const csv = [
    "saved_at,customer_id,product_handle,product_title,product_id,action",
    ...events.map((e) =>
      [
        esc(e.createdAt.toISOString()),
        // Guests have no customer id; say so rather than leaving it ambiguous.
        esc(e.customerId || "guest"),
        esc(e.handle),
        esc(titles.get(e.handle) ?? ""),
        esc(e.productId),
        esc(e.action),
      ].join(","),
    ),
  ].join("\n");

  const today = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="wishlist-${today}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
