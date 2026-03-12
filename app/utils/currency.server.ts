/**
 * Fetches the store's currency using the REST Admin API (more reliable than GraphQL for this).
 * shop.money_format looks like "Rs. {{amount}}", "${{amount}}", "€{{amount}}" etc.
 * We strip "{{amount}}" to get just the symbol/prefix.
 */
export async function getStoreCurrency(
  shop: string,
  accessToken: string
): Promise<{ currencyCode: string; currencySymbol: string }> {
  try {
    const resp = await fetch(
      `https://${shop}/admin/api/2025-01/shop.json?fields=currency,money_format`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!resp.ok) return { currencyCode: "USD", currencySymbol: "$" };
    const data = await resp.json() as {
      shop?: { currency?: string; money_format?: string };
    };
    const currencyCode = data.shop?.currency ?? "USD";
    const moneyFormat = data.shop?.money_format ?? "${{amount}}";
    const currencySymbol = moneyFormat.replace("{{amount}}", "").trim();
    return { currencyCode, currencySymbol };
  } catch {
    return { currencyCode: "USD", currencySymbol: "$" };
  }
}
