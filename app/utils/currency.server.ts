import { authenticate } from "../shopify.server";

const CURRENCY_QUERY = `#graphql
  query {
    shop {
      currencyCode
      moneyFormat
    }
  }
`;

/**
 * Fetches the store's currency code and symbol.
 * moneyFormat from Shopify looks like "${{amount}}" or "€{{amount}}" etc.
 * We strip "{{amount}}" to get just the symbol/prefix.
 */
export async function getStoreCurrency(request: Request): Promise<{
  currencyCode: string;
  currencySymbol: string;
}> {
  try {
    const { admin } = await authenticate.admin(request);
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
