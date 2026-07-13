/**
 * TEMPORARY debug endpoint — verifies the order-management backend without a
 * storefront customer session (the store uses New Customer Accounts, so the
 * app-proxy path can't be exercised from jmlooks.com yet).
 *
 * Guarded by BUMP_SECRET. Uses the shop's stored offline Admin token to run
 * the SAME lookup + eligibility the real /order-actions route runs, so its
 * output is exactly what a logged-in customer would get (minus the ownership
 * check, which needs the live customer id).
 *
 * DELETE THIS ROUTE once New Customer Accounts support is decided.
 *
 *   GET /debug/order-actions?secret=<BUMP_SECRET>&shop=<shop>.myshopify.com&name=%23172138
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { findOrderByName, getEligibility } from "../utils/order-actions.server";

const NO_STORE = { "Cache-Control": "no-store" };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (!process.env.BUMP_SECRET || url.searchParams.get("secret") !== process.env.BUMP_SECRET) {
    return json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
  }

  const shop = url.searchParams.get("shop") || "";
  const name = url.searchParams.get("name") || "";
  if (!shop || !name) {
    return json({ error: "pass ?shop= and ?name=%23NNN" }, { status: 400, headers: NO_STORE });
  }

  const dbSession = await prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });
  if (!dbSession?.accessToken) {
    return json({ error: "no-admin-token-for-shop" }, { status: 404, headers: NO_STORE });
  }
  const accessToken = dbSession.accessToken;

  // Minimal admin.graphql shim matching what order-actions.server expects.
  const admin = {
    graphql: (query: string, opts?: { variables?: any }) =>
      fetch(`https://${shop}/admin/api/2025-01/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables: opts?.variables }),
      }),
  };

  const settings = await prisma.orderManageSettings.findUnique({ where: { shop } });

  let order;
  try {
    order = await findOrderByName(admin, name);
  } catch (e: any) {
    return json({ step: "lookup-threw", error: String(e?.message || e) }, { headers: NO_STORE });
  }

  if (!order) {
    return json(
      { found: false, hint: "no order by that name, OR read_orders scope not granted" },
      { headers: NO_STORE },
    );
  }

  const eligibility = settings
    ? getEligibility(order, settings)
    : { note: "orderManageSettings not configured for shop" };

  return json(
    {
      found: true,
      order: {
        name: order.name,
        cancelledAt: order.cancelledAt,
        financialStatus: order.displayFinancialStatus,
        fulfillmentCount: order.fulfillmentCount,
        customerIdPresent: order.customerId !== null,
        customerIdPresentHint:
          order.customerId === null
            ? "customer REDACTED — Protected Customer Data not granted yet"
            : "customer present — Protected Customer Data OK",
        shippingAddressPresent: order.shippingAddress !== null,
      },
      settings: settings
        ? { isEnabled: settings.isEnabled, allowCancel: settings.allowCancel, cancelScope: settings.cancelScope, allowAddressEdit: settings.allowAddressEdit }
        : null,
      eligibility,
    },
    { headers: NO_STORE },
  );
};
