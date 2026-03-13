import prisma from "./db.server";

export const PLANS = {
  FREE: "free",
  GROWTH: "growth",
  PRO: "pro",
} as const;

export type Plan = (typeof PLANS)[keyof typeof PLANS];

export const PLAN_DETAILS: Record<
  Plan,
  { name: string; price: number; features: string[] }
> = {
  free: {
    name: "Free",
    price: 0,
    features: [
      "Announcement bar",
      "Trust badges (1 set)",
      "Product badges (2 badges)",
      "Basic customization",
    ],
  },
  growth: {
    name: "Growth",
    price: 9.99,
    features: [
      "All 6 features",
      "Unlimited trust badges",
      "Unlimited product badges",
      "Free shipping bar",
      "Sticky add-to-cart",
      "Countdown timer",
    ],
  },
  pro: {
    name: "Pro",
    price: 19.99,
    features: [
      "Everything in Growth",
      "Priority support",
      "Advanced page targeting",
      "Schedule widgets",
    ],
  },
};

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
