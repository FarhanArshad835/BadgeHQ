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
