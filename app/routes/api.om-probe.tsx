/**
 * TEMPORARY. Asks Shopify for exactly the fields order cancellation depends on,
 * to find out whether customer.id comes back or is redacted under this app's
 * Protected Customer Data level. Secret-guarded; DELETE after reading.
 */
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";

const SECRET = "SBE_OMPROBE_3a";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const shop = url.searchParams.get("shop") || "";
  const session = await prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) return json({ error: "no session for shop", shop });

  const res = await fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
    body: JSON.stringify({
      query: `{ orders(first: 3, sortKey: CREATED_AT, reverse: true) {
        nodes { id name cancelledAt displayFinancialStatus fulfillments { id } customer { id } }
      } }`,
    }),
  });
  const body = await res.json();
  const nodes = body?.data?.orders?.nodes ?? [];
  return json({
    scope: session.scope,
    topLevelErrors: body?.errors ?? null,
    orders: nodes.map((o: any) => ({
      name: o.name,
      customerIdPresent: o.customer?.id != null,
      customerId: o.customer?.id ?? null,
      cancelled: Boolean(o.cancelledAt),
      fulfillments: o.fulfillments?.length ?? 0,
    })),
  });
};
