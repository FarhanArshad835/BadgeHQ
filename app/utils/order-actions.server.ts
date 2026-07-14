/**
 * Customer self-service order actions (cancel / edit shipping address),
 * executed with the shop's offline Admin API session obtained from
 * authenticate.public.appProxy. All eligibility rules are enforced here —
 * the storefront UI is advisory only.
 */

export type OrderSummary = {
  id: string;
  name: string;
  cancelledAt: string | null;
  displayFinancialStatus: string;
  fulfillmentCount: number;
  customerId: string | null;
  shippingAddress: Record<string, string | null> | null;
};

type AdminGraphql = { graphql: (query: string, opts?: { variables?: any }) => Promise<Response> };

/**
 * Protected Customer Data Level-2 gate. Shopify approved Level 1 (customer id,
 * order number) but NOT Name/Address. Querying shippingAddress without that
 * approval makes the Admin API reject the WHOLE order query, which would break
 * even order cancellation. So while this is false we never request
 * shippingAddress and the address-edit capability is disabled end to end.
 * Flip to true once Shopify approves Level-2 PCD (ref #106713).
 */
export const ADDRESS_EDIT_ENABLED = false;

// Level-1 only — safe to query with the currently approved PCD scope.
const ORDER_FIELDS_BASE = `
  id
  name
  cancelledAt
  displayFinancialStatus
  fulfillments { id }
  customer { id }
`;

// Base + shippingAddress (Level-2 PCD). Only used when ADDRESS_EDIT_ENABLED.
const ORDER_FIELDS_WITH_ADDRESS = `
  ${ORDER_FIELDS_BASE}
  shippingAddress {
    firstName lastName address1 address2 city
    province provinceCode zip country countryCode phone
  }
`;

export async function findOrderByName(admin: AdminGraphql, name: string): Promise<OrderSummary | null> {
  // Order names look like "#172138" — strip the # for the search query and
  // keep only safe characters so the query string can't be broken out of.
  const clean = name.replace(/^#/, "").replace(/[^\w.-]/g, "");
  if (!clean) return null;

  const fields = ADDRESS_EDIT_ENABLED ? ORDER_FIELDS_WITH_ADDRESS : ORDER_FIELDS_BASE;
  const resp = await admin.graphql(
    `query FindOrder($q: String!) {
      orders(first: 2, query: $q) {
        edges { node { ${fields} } }
      }
    }`,
    { variables: { q: `name:${clean}` } },
  );
  const body = await resp.json();
  const edges = body?.data?.orders?.edges ?? [];
  if (edges.length !== 1) return null;

  const node = edges[0].node;
  return {
    id: node.id,
    name: node.name,
    cancelledAt: node.cancelledAt,
    displayFinancialStatus: node.displayFinancialStatus || "",
    fulfillmentCount: (node.fulfillments || []).length,
    customerId: node.customer?.id ?? null,
    shippingAddress: node.shippingAddress ?? null,
  };
}

/** Ownership check with a distinct "protected" state. When the app has not
 * been granted Protected Customer Data access, Shopify redacts order.customer
 * entirely (customerId === null) even though the order exists — that's a
 * configuration gap, not a not-your-order case, so we report it separately.
 * Numeric tail comparison: order.customer.id is a gid, logged_in_customer_id
 * is the bare numeric id. */
export function checkOwnership(
  order: OrderSummary,
  loggedInCustomerId: string,
): "owner" | "not-owner" | "protected" {
  if (order.customerId === null) return "protected";
  if (!/^\d+$/.test(loggedInCustomerId)) return "not-owner";
  return order.customerId.endsWith(`/${loggedInCustomerId}`) ? "owner" : "not-owner";
}

const UNPAID_STATUSES = ["PENDING", "AUTHORIZED", "EXPIRED"];

export function getEligibility(
  order: OrderSummary,
  settings: { allowCancel: boolean; cancelScope: string; allowAddressEdit: boolean },
): { cancellable: boolean; reason: string; addressEditable: boolean } {
  if (order.cancelledAt) {
    return { cancellable: false, reason: "cancelled", addressEditable: false };
  }
  if (order.fulfillmentCount > 0) {
    return { cancellable: false, reason: "fulfilled", addressEditable: false };
  }

  const unpaid = UNPAID_STATUSES.includes(order.displayFinancialStatus);
  let cancellable = settings.allowCancel;
  let reason = "";
  if (cancellable && !unpaid && settings.cancelScope !== "all") {
    cancellable = false;
    reason = "prepaid";
  }
  // Address edit stays off until Shopify grants Level-2 PCD, regardless of the
  // merchant's toggle.
  const addressEditable = ADDRESS_EDIT_ENABLED && settings.allowAddressEdit;
  return { cancellable, reason, addressEditable };
}

export async function cancelOrder(
  admin: AdminGraphql,
  orderId: string,
  refund: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const resp = await admin.graphql(
    `mutation CancelOrder($orderId: ID!, $refund: Boolean!) {
      orderCancel(
        orderId: $orderId
        reason: CUSTOMER
        refund: $refund
        restock: true
        notifyCustomer: true
        staffNote: "Cancelled by the customer from the order page (BadgeHQ)"
      ) {
        job { id }
        orderCancelUserErrors { field message }
        userErrors { field message }
      }
    }`,
    { variables: { orderId, refund } },
  );
  const body = await resp.json();
  const result = body?.data?.orderCancel;
  const errors = [...(result?.orderCancelUserErrors || []), ...(result?.userErrors || [])];
  if (!result || errors.length) {
    return { ok: false, error: errors[0]?.message || "cancel-failed" };
  }
  return { ok: true };
}

const ADDRESS_FIELDS = ["firstName", "lastName", "address1", "address2", "city", "province", "zip", "country", "phone"] as const;

export async function updateShippingAddress(
  admin: AdminGraphql,
  orderId: string,
  form: URLSearchParams,
): Promise<{ ok: boolean; error?: string }> {
  // Defense in depth: never touch address PII while Level-2 PCD is ungranted.
  if (!ADDRESS_EDIT_ENABLED) {
    return { ok: false, error: "address-edit-disabled" };
  }
  const address: Record<string, string> = {};
  for (const f of ADDRESS_FIELDS) {
    const v = (form.get(f) || "").trim().slice(0, 255);
    if (v) address[f] = v;
  }
  if (!address.address1 || !address.city || !address.zip) {
    return { ok: false, error: "Address line 1, city, and PIN/ZIP code are required." };
  }

  const resp = await admin.graphql(
    `mutation UpdateOrderAddress($input: OrderInput!) {
      orderUpdate(input: $input) {
        order { id }
        userErrors { field message }
      }
    }`,
    { variables: { input: { id: orderId, shippingAddress: address } } },
  );
  const body = await resp.json();
  const errors = body?.data?.orderUpdate?.userErrors || [];
  if (!body?.data?.orderUpdate?.order || errors.length) {
    return { ok: false, error: errors[0]?.message || "address-update-failed" };
  }
  return { ok: true };
}
