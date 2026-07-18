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
export async function upsertSubscribedCustomer(
  admin: AdminGraphql,
  email: string,
): Promise<string | null> {
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
    if (!id) {
      // Most likely causes: write_customers not approved, or Protected
      // Customer Data not granted. Log it — silently returning null is what
      // made this invisible before.
      console.error(
        "[back-in-stock] customerCreate failed:",
        JSON.stringify(body?.data?.customerCreate?.userErrors || body?.errors || body).slice(0, 400),
      );
    }
    return id;
  } catch (e: any) {
    console.error("[back-in-stock] customerCreate threw:", String(e?.message || e).slice(0, 200));
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
