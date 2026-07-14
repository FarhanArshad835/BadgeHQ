/**
 * Customer order self-service endpoint, reached through the Shopify App
 * Proxy: storefront /apps/badgehq/order-actions -> this route.
 *
 * Shopify verifies nothing for us here — authenticate.public.appProxy checks
 * the proxy signature, and logged_in_customer_id (appended by Shopify, only
 * when the customer has a storefront session) is the customer identity. We
 * additionally require the order to belong to that customer.
 *
 * GET  ?name=%23172138            -> eligibility + current shipping address
 * POST intent=cancel|update-address (form-encoded)
 *
 * Responses are per-customer: always Cache-Control: no-store. This path
 * bypasses the Cloudflare worker entirely.
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  ADDRESS_EDIT_ENABLED,
  cancelOrder,
  checkOwnership,
  findOrderByName,
  getEligibility,
  updateShippingAddress,
} from "../utils/order-actions.server";

const NO_STORE = { "Cache-Control": "no-store" };

const UNPAID_STATUSES = ["PENDING", "AUTHORIZED", "EXPIRED"];

async function resolveContext(request: Request) {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session || !admin) {
    return { error: json({ error: "unauthorized" }, { status: 401, headers: NO_STORE }) };
  }

  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id") || "";
  if (!customerId) {
    return { error: json({ error: "not-logged-in" }, { status: 401, headers: NO_STORE }) };
  }

  const settings = await prisma.orderManageSettings.findUnique({
    where: { shop: session.shop },
  });
  if (!settings || !settings.isEnabled) {
    return { error: json({ enabled: false }, { status: 200, headers: NO_STORE }) };
  }

  return { session, admin, customerId, settings, url };
}

async function loadOwnedOrder(admin: any, url: URL, request: Request, customerId: string) {
  const name =
    url.searchParams.get("name") ||
    (request.method === "POST" ? "" : "");
  if (!name) return { error: json({ error: "missing-order" }, { status: 400, headers: NO_STORE }) };

  let order;
  try {
    order = await findOrderByName(admin, name);
  } catch {
    // Most likely the merchant hasn't approved the new orders scopes yet.
    return { error: json({ error: "permissions" }, { status: 200, headers: NO_STORE }) };
  }
  if (!order) {
    return { error: json({ error: "order-not-found" }, { status: 404, headers: NO_STORE }) };
  }
  const ownership = checkOwnership(order, customerId);
  if (ownership === "protected") {
    // Order exists but customer field is redacted — Protected Customer Data
    // access isn't granted yet. Surface it so the merchant can diagnose.
    return { error: json({ error: "protected-data" }, { status: 200, headers: NO_STORE }) };
  }
  if (ownership !== "owner") {
    return { error: json({ error: "order-not-found" }, { status: 404, headers: NO_STORE }) };
  }
  return { order };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const ctx = await resolveContext(request);
  if ("error" in ctx) return ctx.error;

  const found = await loadOwnedOrder(ctx.admin, ctx.url, request, ctx.customerId);
  if ("error" in found) return found.error;

  const { cancellable, reason, addressEditable } = getEligibility(found.order, ctx.settings);
  return json(
    {
      enabled: true,
      cancellable,
      reason,
      addressEditable,
      shippingAddress: addressEditable ? found.order.shippingAddress : null,
    },
    { headers: NO_STORE },
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "method-not-allowed" }, { status: 405, headers: NO_STORE });
  }

  const ctx = await resolveContext(request);
  if ("error" in ctx) return ctx.error;

  const form = new URLSearchParams(await request.text());
  const name = form.get("name") || "";
  ctx.url.searchParams.set("name", name);

  const found = await loadOwnedOrder(ctx.admin, ctx.url, request, ctx.customerId);
  if ("error" in found) return found.error;
  const order = found.order;

  // Re-check eligibility server-side; never trust the button state.
  const { cancellable, addressEditable } = getEligibility(order, ctx.settings);
  const intent = form.get("intent");

  if (intent === "cancel") {
    if (!cancellable) return json({ error: "not-cancellable" }, { status: 403, headers: NO_STORE });
    const refund = !UNPAID_STATUSES.includes(order.displayFinancialStatus);
    const result = await cancelOrder(ctx.admin, order.id, refund);
    return json(result, { status: result.ok ? 200 : 422, headers: NO_STORE });
  }

  if (intent === "update-address") {
    // Address editing needs Level-2 PCD (Name/Address), not yet granted — see
    // ADDRESS_EDIT_ENABLED. Reject before any PII handling.
    if (!ADDRESS_EDIT_ENABLED) {
      return json({ error: "address-edit-disabled" }, { status: 200, headers: NO_STORE });
    }
    if (!addressEditable) return json({ error: "not-editable" }, { status: 403, headers: NO_STORE });
    const result = await updateShippingAddress(ctx.admin, order.id, form);
    return json(result, { status: result.ok ? 200 : 422, headers: NO_STORE });
  }

  return json({ error: "unknown-intent" }, { status: 400, headers: NO_STORE });
};
