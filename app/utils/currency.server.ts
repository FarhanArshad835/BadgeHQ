const CURRENCY_QUERY = `#graphql
  query {
    shop {
      currencyCode
      moneyFormat
    }
  }
`;

type AdminContext = { graphql: (query: string) => Promise<{ json: () => Promise<unknown> }> };

/**
 * Fetches the store's currency code and symbol.
 * Pass the admin object from authenticate.admin(request) directly
 * to avoid double-authenticating the same request.
 *
 * moneyFormat from Shopify looks like "₹{{amount}}", "${{amount}}", "€{{amount}}" etc.
 * We strip "{{amount}}" to get just the symbol/prefix.
 */
export async function getStoreCurrency(admin: AdminContext): Promise<{
  currencyCode: string;
  currencySymbol: string;
}> {
  try {
    const response = await admin.graphql(CURRENCY_QUERY);
    const data = await response.json() as {
      data?: { shop?: { currencyCode?: string; moneyFormat?: string } };
    };
    const shop = data?.data?.shop;
    const currencyCode = shop?.currencyCode ?? "USD";
    const moneyFormat = shop?.moneyFormat ?? "${{amount}}";
    const currencySymbol = moneyFormat.replace("{{amount}}", "").trim();
    return { currencyCode, currencySymbol };
  } catch {
    return { currencyCode: "USD", currencySymbol: "$" };
  }
}
