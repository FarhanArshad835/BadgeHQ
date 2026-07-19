/**
 * Back-in-stock server helpers.
 *
 * Delivery is WhatsApp (Interakt or DoubleTick). The shopper types their own
 * number into the storefront form, so notifying them reads NO Shopify customer
 * records and needs no Protected Customer Data access. `notifiedAt` is set only
 * when the provider accepts the message, so a failure is retried next restock.
 *
 * Mirroring the shopper into Shopify's customer list (and firing the Flow
 * trigger for merchants who built the marketing automation) is an optional
 * BONUS: it runs only when the shop actually granted write_customers, and it
 * never affects whether a shopper counts as notified.
 */
import { sendWhatsAppTemplate } from "./whatsapp.server";

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
  let lastSubscribeError: string | null = null;
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
  productUrl?: string;
};

/** Canonical storefront URL for the restocked variant. "" when no handle. */
export function buildProductUrl(shop: string, v: RestockedVariant): string {
  return v.productHandle
    ? `https://${shop}/products/${v.productHandle}?variant=${v.variantId}`
    : "";
}

/**
 * Does this shop actually grant write_customers? Checked live so a shop that
 * never approved it makes ZERO customer API calls. Failure = assume no.
 */
export async function hasWriteCustomers(admin: AdminGraphql): Promise<boolean> {
  try {
    const resp = await admin.graphql(
      `query { currentAppInstallation { accessScopes { handle } } }`,
    );
    const body = await resp.json();
    const scopes = body?.data?.currentAppInstallation?.accessScopes ?? [];
    return scopes.some((s: any) => s?.handle === "write_customers");
  } catch {
    return false;
  }
}

/**
 * WhatsApp/Meta rejects a template send when any body variable is empty, and
 * newlines/tabs are not allowed either. Flatten whitespace and fall back to a
 * non-empty value. Shopify's single-variant placeholder "Default Title" is
 * treated as empty — it is meaningless to a shopper.
 */
function clean(value: unknown, fallback: string): string {
  const v = String(value ?? "").replace(/\s+/g, " ").trim();
  return v && v.toLowerCase() !== "default title" ? v : fallback;
}

export type WhatsAppConfig = {
  waEnabled: boolean;
  waProvider: string;
  waApiKey: string;
  waTemplateName: string;
  waLanguageCode: string;
  waFromNumber: string;
  waFallbackImage: string;
};

/** True when this shop can actually deliver a WhatsApp message. */
export function canDeliverWhatsApp(s: WhatsAppConfig | null | undefined): boolean {
  if (!s?.waEnabled || !s.waApiKey || !s.waTemplateName) return false;
  // DoubleTick additionally needs the sender number.
  if (s.waProvider === "doubletick" && !s.waFromNumber) return false;
  return true;
}

/**
 * Notify one shopper on WhatsApp that a variant is back. Template body must be
 * {{1}} product, {{2}} variant, {{3}} product URL.
 */
export async function sendRestockWhatsApp(opts: {
  settings: WhatsAppConfig;
  phone: string;
  shop: string;
  variant: RestockedVariant;
}): Promise<{ ok: boolean; error?: string }> {
  const s = opts.settings;
  if (!canDeliverWhatsApp(s)) return { ok: false, error: "whatsapp-not-configured" };
  if (!opts.phone) return { ok: false, error: "no-phone" };

  const title = clean(opts.variant.productTitle, "Your item");
  const url = opts.variant.productUrl || buildProductUrl(opts.shop, opts.variant);

  const res = await sendWhatsAppTemplate({
    provider: s.waProvider,
    apiKey: s.waApiKey,
    phone: opts.phone,
    templateName: s.waTemplateName,
    languageCode: s.waLanguageCode || "en",
    fromNumber: s.waFromNumber,
    bodyValues: [
      title,
      // A single-variant product has no meaningful variant title — reuse the
      // product title rather than sending an empty (rejected) variable.
      clean(opts.variant.variantTitle, title),
      clean(url, "our store"),
    ],
    // Products with no featured image fall back to the merchant's image, so a
    // single image template covers every send (Meta rejects an empty header).
    headerImageUrl: opts.variant.productImage || s.waFallbackImage || undefined,
    callbackData: `bis:${opts.variant.variantId}`,
  });

  return res.ok ? { ok: true } : { ok: false, error: res.error };
}

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
