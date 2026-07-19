/**
 * Back-in-stock server helpers.
 *
 * Delivery is WhatsApp (Interakt or DoubleTick) and nothing else. The shopper
 * types their own number into the storefront form, so that number is their
 * identity here — we read NO Shopify customer records, which is why this
 * feature needs no Protected Customer Data access at all.
 *
 * `notifiedAt` is set only when the provider accepts the message, so anyone we
 * couldn't reach is retried on the next restock instead of being lost.
 */
import { sendWhatsAppTemplate } from "./whatsapp.server";

type AdminGraphql = {
  graphql: (query: string, opts?: { variables?: any }) => Promise<Response>;
};

/** Bare numeric id -> gid. Accepts either form. */
export function toGid(
  kind: "ProductVariant" | "Product" | "InventoryItem",
  id: string,
): string {
  return String(id).startsWith("gid://") ? String(id) : `gid://shopify/${kind}/${id}`;
}

/** gid -> bare numeric id. Accepts either form. */
export function toBareId(gid: string): string {
  const m = String(gid).match(/(\d+)\s*$/);
  return m ? m[1] : String(gid);
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
 * Value for the template's dynamic URL button. WhatsApp stores the fixed
 * prefix (https://<shop>/products/) in the approved template and appends only
 * this suffix, which Meta caps at 128 characters. Returns "" when there's no
 * handle, so the send simply omits the button parameter.
 */
export function buildButtonSuffix(v: RestockedVariant): string {
  if (!v.productHandle) return "";
  return `${v.productHandle}?variant=${v.variantId}`.slice(0, 128);
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
 * Notify one shopper on WhatsApp that a variant is back. The approved template
 * must have an image header, two body variables ({{1}} product, {{2}} variant)
 * and a dynamic URL button.
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

  const res = await sendWhatsAppTemplate({
    provider: s.waProvider,
    apiKey: s.waApiKey,
    phone: opts.phone,
    templateName: s.waTemplateName,
    languageCode: s.waLanguageCode || "en",
    fromNumber: s.waFromNumber,
    // TWO body variables only — the product link lives on the URL button, so
    // the template body has no {{3}}. Meta rejects a send whose value count
    // doesn't match the approved template exactly.
    bodyValues: [
      title,
      // A single-variant product has no meaningful variant title — reuse the
      // product title rather than sending an empty (rejected) variable.
      clean(opts.variant.variantTitle, title),
    ],
    // Products with no featured image fall back to the merchant's image, so a
    // single image template covers every send (Meta rejects an empty header).
    headerImageUrl: opts.variant.productImage || s.waFallbackImage || undefined,
    // Dynamic URL button. The template holds the fixed prefix
    // https://<shop>/products/ and we supply only the suffix.
    buttonUrlSuffix: buildButtonSuffix(opts.variant),
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
