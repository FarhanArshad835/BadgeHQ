import prisma from "./db.server";
import { PLANS, PLAN_DETAILS, type Plan } from "./billing.shared";

// Re-export shared constants so existing imports from billing.server still work
export { PLANS, PLAN_DETAILS, type Plan };

export async function getShopPlan(shop: string): Promise<Plan> {
  const record = await prisma.shopPlan.findUnique({ where: { shop } });
  return (record?.plan as Plan) ?? PLANS.FREE;
}

export async function upsertShopPlan(
  shop: string,
  plan: Plan,
  billingId?: string
) {
  return prisma.shopPlan.upsert({
    where: { shop },
    create: { shop, plan, billingId: billingId ?? null, status: "active" },
    update: { plan, billingId: billingId ?? undefined, status: "active" },
  });
}

export async function cancelShopPlan(shop: string) {
  return prisma.shopPlan.upsert({
    where: { shop },
    create: { shop, plan: PLANS.FREE, status: "cancelled" },
    update: { plan: PLANS.FREE, status: "cancelled", billingId: null },
  });
}

/** Extract reauthorize URL from a billing 401 error (tries 3 methods). */
export function extractReauthorizeUrl(error: unknown): string | null {
  try {
    const e = error as Record<string, unknown>;

    // Method 1: error.response.headers.get()
    const resp = e?.response as Record<string, unknown> | undefined;
    const headers1 = resp?.headers as Record<string, unknown> | undefined;
    if (typeof headers1?.get === "function") {
      const url = (headers1.get as (k: string) => string | null)(
        "x-shopify-api-request-failure-reauthorize-url"
      );
      if (url) return url;
    }

    // Method 2: plain headers object
    const headers2 = e?.headers as Record<string, string> | undefined;
    const url2 =
      headers2?.["x-shopify-api-request-failure-reauthorize-url"];
    if (url2) return url2;

    // Method 3: dig into Symbol internals
    const symbols = Object.getOwnPropertySymbols(e);
    for (const sym of symbols) {
      const inner = (e as Record<symbol, unknown>)[sym] as
        | Record<string, unknown>
        | undefined;
      const innerHeaders = inner?.headers as Record<string, unknown> | undefined;
      if (typeof innerHeaders?.get === "function") {
        const url = (innerHeaders.get as (k: string) => string | null)(
          "x-shopify-api-request-failure-reauthorize-url"
        );
        if (url) return url;
      }
    }
  } catch {
    // ignore
  }
  return null;
}
