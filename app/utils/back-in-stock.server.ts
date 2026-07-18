/**
 * Back-in-stock server helpers.
 *
 * Sending is Shopify-native: we never send email ourselves. On restock we fire
 * a Flow custom trigger (flowTriggerReceive) carrying the Customer property,
 * which the merchant's marketing automation turns into a Shopify Email send.
 * That path only reaches email-marketing subscribers, which is why the signup
 * subscribes the shopper (with an explicit notice in the storefront form).
 */

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: any }) => Promise<Response>;
};

export const FLOW_TRIGGER_HANDLE = "badgehq-back-in-stock";

// Deliberately permissive but sane; Shopify does the real validation on create.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && EMAIL_RE.test(email);
}

/** Bare numeric id -> gid. Accepts either form. */
export function toGid(
  kind: "ProductVariant" | "Product" | "Customer" | "InventoryItem",
  id: string,
): string {
  return String(id).startsWith("gid://") ? String(id) : `gid://shopify/${kind}/${id}`;
}

/** gid -> bare numeric id. Accepts either form. */
export function toBareId(gid: string): string {
  const m = String(gid).match(/(\d+)\s*$/);
  return m ? m[1] : String(gid);
}

/**
 * Find an existing customer by email, else create one. Either way ensure they
 * are subscribed to email marketing — without that, Shopify Email's marketing
 * automation silently skips them and the shopper never hears about the restock.
 * Returns the customer gid, or null if Shopify rejected it.
 */
// TEMP: last failure reason from upsertSubscribedCustomer, surfaced by the
// signup endpoint so the cause is visible without server-log access.
let lastSubscribeError: string | null = null;
export function getLastSubscribeError(): string | null {
  return lastSubscribeError;
}

export async function upsertSubscribedCustomer(
  admin: AdminGraphql,
  email: string,
): Promise<string | null> {
  lastSubscribeError = null;
  const consent = {
    marketingState: "SUBSCRIBED",
    marketingOptInLevel: "SINGLE_OPT_IN",
    consentUpdatedAt: new Date().toISOString(),
  };

  // Existing customer? (email search is exact-match here)
  try {
    const found = await admin.graphql(
      `query FindCustomer($q: String!) {
        customers(first: 1, query: $q) { edges { node { id } } }
      }`,
      { variables: { q: `email:${email}` } },
    );
    const body = await found.json();
    if (body?.errors) {
      console.error("[back-in-stock] customer lookup failed:", JSON.stringify(body.errors).slice(0, 300));
    }
    const existing = body?.data?.customers?.edges?.[0]?.node?.id;
    if (existing) {
      const upd = await admin.graphql(
        `mutation SubscribeCustomer($input: CustomerInput!) {
          customerUpdate(input: $input) { userErrors { field message } }
        }`,
        { variables: { input: { id: existing, emailMarketingConsent: consent } } },
      );
      const updBody = await upd.json();
      const updErrs = updBody?.data?.customerUpdate?.userErrors || [];
      if (updErrs.length || updBody?.errors) {
        console.error(
          "[back-in-stock] customerUpdate rejected:",
          JSON.stringify(updErrs.length ? updErrs : updBody.errors).slice(0, 300),
        );
      }
      // Return the id regardless: the customer exists, so the automation can
      // still address them even if consent couldn't be updated.
      return existing;
    }
  } catch (e: any) {
    console.error("[back-in-stock] customer lookup threw:", String(e?.message || e).slice(0, 200));
  }

  try {
    const resp = await admin.graphql(
      `mutation CreateCustomer($input: CustomerInput!) {
        customerCreate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }`,
      { variables: { input: { email, emailMarketingConsent: consent } } },
    );
    const body = await resp.json();
    const id = body?.data?.customerCreate?.customer?.id ?? null;
    if (id) return id;

    const errs = body?.data?.customerCreate?.userErrors || [];
    const taken = errs.some((e: any) => /already been taken/i.test(e?.message || ""));

    // The customer exists but the `customers(query:)` search above didn't find
    // them — that search depends on the search index and on Protected Customer
    // Data access, so it can come back empty for real customers. Look them up
    // by exact identifier instead, then subscribe them.
    if (taken) {
      const byId = await admin.graphql(
        `query CustomerByEmail($id: CustomerIdentifierInput!) {
          customerByIdentifier(identifier: $id) { id }
        }`,
        { variables: { id: { emailAddress: email } } },
      );
      const byIdBody = await byId.json();
      const existingId = byIdBody?.data?.customerByIdentifier?.id ?? null;
      if (existingId) {
        const upd = await admin.graphql(
          `mutation SubscribeExisting($input: CustomerInput!) {
            customerUpdate(input: $input) { userErrors { field message } }
          }`,
          { variables: { input: { id: existingId, emailMarketingConsent: consent } } },
        );
        const updBody = await upd.json();
        const updErrs = updBody?.data?.customerUpdate?.userErrors || [];
        if (updErrs.length) {
          lastSubscribeError = "consent-update: " + JSON.stringify(updErrs).slice(0, 200);
          console.error("[back-in-stock] customerUpdate rejected:", lastSubscribeError);
        }
        // Return the id either way — the customer exists, so the marketing
        // automation can address them.
        return existingId;
      }
      lastSubscribeError =
        "customer exists but could not be looked up: " +
        JSON.stringify(byIdBody?.errors || byIdBody).slice(0, 200);
      console.error("[back-in-stock]", lastSubscribeError);
      return null;
    }

    lastSubscribeError = JSON.stringify(errs.length ? errs : body?.errors || body).slice(0, 300);
    console.error("[back-in-stock] customerCreate failed:", lastSubscribeError);
    return null;
  } catch (e: any) {
    lastSubscribeError = "threw: " + String(e?.message || e).slice(0, 200);
    console.error("[back-in-stock] customerCreate threw:", lastSubscribeError);
    return null;
  }
}

export type RestockedVariant = {
  variantId: string; // bare
  productId: string; // bare
  productTitle: string;
  variantTitle: string;
  productHandle: string;
  productImage: string;
};

/** Resolve an inventory_item_id (from the webhook) to its variant + product. */
export async function resolveInventoryItem(
  admin: AdminGraphql,
  inventoryItemId: string,
): Promise<RestockedVariant | null> {
  try {
    const resp = await admin.graphql(
      `query InventoryItemVariant($id: ID!) {
        inventoryItem(id: $id) {
          variant {
            id
            title
            product { id title handle featuredImage { url } }
          }
        }
      }`,
      { variables: { id: toGid("InventoryItem", inventoryItemId) } },
    );
    const body = await resp.json();
    const v = body?.data?.inventoryItem?.variant;
    if (!v?.id || !v?.product?.id) return null;
    return {
      variantId: toBareId(v.id),
      productId: toBareId(v.product.id),
      productTitle: v.product.title || "",
      variantTitle: v.title || "",
      productHandle: v.product.handle || "",
      productImage: v.product.featuredImage?.url || "",
    };
  } catch {
    return null;
  }
}

/**
 * Fire the Flow custom trigger for one subscriber. The `customer_id` property
 * is what lets the merchant's marketing automation address the shopper.
 * Returns true only when Shopify accepted the trigger.
 */
export async function fireRestockTrigger(
  admin: AdminGraphql,
  shop: string,
  customerGid: string,
  v: RestockedVariant,
): Promise<boolean> {
  try {
    const resp = await admin.graphql(
      `mutation FireBackInStock($handle: String!, $payload: JSON!) {
        flowTriggerReceive(handle: $handle, payload: $payload) {
          userErrors { field message }
        }
      }`,
      {
        variables: {
          handle: FLOW_TRIGGER_HANDLE,
          // Keys must match the field keys declared in
          // extensions/badgehq-flow/shopify.extension.toml exactly.
          payload: {
            customer_id: customerGid,
            producttitle: v.productTitle,
            varianttitle: v.variantTitle,
            producturl: v.productHandle
              ? `https://${shop}/products/${v.productHandle}?variant=${v.variantId}`
              : "",
            productimage: v.productImage,
          },
        },
      },
    );
    const body = await resp.json();
    const errs = body?.data?.flowTriggerReceive?.userErrors || [];
    return errs.length === 0;
  } catch {
    return false;
  }
}
