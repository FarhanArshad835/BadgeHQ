export interface BadgeItem {
  id: string;
  name: string;
  category: BadgeCategory;
  imageUrl: string;
  tags: string[];
}

export type BadgeCategory =
  | "payment"
  | "security"
  | "shipping"
  | "trust"
  | "custom";

// Inline SVG data URIs for reliable, CDN-free badge rendering
function svg(content: string, viewBox = "0 0 120 40"): string {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${content}</svg>`)}`;
}

function badgeSvg(text: string, bg: string, fg = "#fff"): string {
  return svg(
    `<rect width="120" height="40" rx="6" fill="${bg}"/><text x="60" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="11" font-weight="700" fill="${fg}">${text}</text>`
  );
}

function shieldSvg(text: string, bg: string, fg = "#fff"): string {
  return svg(
    `<path d="M60 2 L110 12 L110 28 Q110 38 60 38 Q10 38 10 28 L10 12 Z" fill="${bg}"/><text x="60" y="25" text-anchor="middle" font-family="Arial,sans-serif" font-size="10" font-weight="700" fill="${fg}">${text}</text>`
  );
}

function circleSvg(text: string, bg: string, fg = "#fff"): string {
  return svg(
    `<circle cx="20" cy="20" r="18" fill="${bg}"/><text x="20" y="24" text-anchor="middle" font-family="Arial,sans-serif" font-size="7" font-weight="700" fill="${fg}">${text}</text>`,
    "0 0 40 40"
  );
}

export const badgeLibrary: BadgeItem[] = [
  // ── PAYMENT (15 badges) ──
  { id: "visa", name: "Visa", category: "payment", imageUrl: badgeSvg("VISA", "#1a1f71"), tags: ["card", "credit"] },
  { id: "mastercard", name: "Mastercard", category: "payment", imageUrl: badgeSvg("Mastercard", "#eb001b"), tags: ["card", "credit"] },
  { id: "amex", name: "American Express", category: "payment", imageUrl: badgeSvg("AMEX", "#006fcf"), tags: ["card", "credit"] },
  { id: "paypal", name: "PayPal", category: "payment", imageUrl: badgeSvg("PayPal", "#003087"), tags: ["digital", "wallet"] },
  { id: "apple-pay", name: "Apple Pay", category: "payment", imageUrl: badgeSvg("Apple Pay", "#000000"), tags: ["mobile", "wallet"] },
  { id: "google-pay", name: "Google Pay", category: "payment", imageUrl: badgeSvg("Google Pay", "#4285F4"), tags: ["mobile", "wallet"] },
  { id: "stripe", name: "Stripe", category: "payment", imageUrl: badgeSvg("Stripe", "#635bff"), tags: ["processor"] },
  { id: "discover", name: "Discover", category: "payment", imageUrl: badgeSvg("Discover", "#ff6000"), tags: ["card", "credit"] },
  { id: "bitcoin", name: "Bitcoin", category: "payment", imageUrl: badgeSvg("Bitcoin", "#f7931a"), tags: ["crypto"] },
  { id: "shopify-pay", name: "Shop Pay", category: "payment", imageUrl: badgeSvg("Shop Pay", "#5a31f4"), tags: ["shopify", "wallet"] },
  { id: "klarna", name: "Klarna", category: "payment", imageUrl: badgeSvg("Klarna", "#ffb3c7", "#0a0b09"), tags: ["bnpl"] },
  { id: "afterpay", name: "Afterpay", category: "payment", imageUrl: badgeSvg("Afterpay", "#b2fce4", "#000"), tags: ["bnpl"] },
  { id: "venmo", name: "Venmo", category: "payment", imageUrl: badgeSvg("Venmo", "#008CFF"), tags: ["wallet"] },
  { id: "samsung-pay", name: "Samsung Pay", category: "payment", imageUrl: badgeSvg("Samsung Pay", "#1428a0"), tags: ["mobile", "wallet"] },
  { id: "diners-club", name: "Diners Club", category: "payment", imageUrl: badgeSvg("Diners Club", "#0079be"), tags: ["card", "credit"] },

  // ── SECURITY (12 badges) ──
  { id: "ssl-secure", name: "SSL Secure", category: "security", imageUrl: shieldSvg("SSL Secure", "#27ae60"), tags: ["encryption", "certificate"] },
  { id: "256-bit", name: "256-Bit Encryption", category: "security", imageUrl: shieldSvg("256-Bit SSL", "#2c3e50"), tags: ["encryption"] },
  { id: "norton-secured", name: "Norton Secured", category: "security", imageUrl: shieldSvg("Norton", "#ffc629", "#000"), tags: ["antivirus", "verified"] },
  { id: "mcafee-secure", name: "McAfee Secure", category: "security", imageUrl: shieldSvg("McAfee", "#c8102e"), tags: ["antivirus", "verified"] },
  { id: "secure-checkout", name: "Secure Checkout", category: "security", imageUrl: shieldSvg("Secure", "#3498db"), tags: ["checkout"] },
  { id: "dmca-protected", name: "DMCA Protected", category: "security", imageUrl: shieldSvg("DMCA", "#1a237e"), tags: ["copyright"] },
  { id: "pci-compliant", name: "PCI Compliant", category: "security", imageUrl: shieldSvg("PCI DSS", "#00695c"), tags: ["compliance"] },
  { id: "bbb-accredited", name: "BBB Accredited", category: "security", imageUrl: shieldSvg("BBB A+", "#005a8c"), tags: ["accreditation"] },
  { id: "trusted-site", name: "Trusted Site", category: "security", imageUrl: shieldSvg("Trusted", "#43a047"), tags: ["trust"] },
  { id: "verified-secure", name: "Verified & Secure", category: "security", imageUrl: shieldSvg("Verified", "#1565c0"), tags: ["verification"] },
  { id: "gdpr-compliant", name: "GDPR Compliant", category: "security", imageUrl: shieldSvg("GDPR", "#0d47a1"), tags: ["privacy", "compliance"] },
  { id: "safe-secure", name: "100% Safe & Secure", category: "security", imageUrl: shieldSvg("100% Safe", "#388e3c"), tags: ["safety"] },

  // ── SHIPPING (10 badges) ──
  { id: "free-shipping", name: "Free Shipping", category: "shipping", imageUrl: badgeSvg("Free Shipping", "#00897b"), tags: ["delivery"] },
  { id: "fast-delivery", name: "Fast Delivery", category: "shipping", imageUrl: badgeSvg("Fast Delivery", "#ef6c00"), tags: ["speed"] },
  { id: "easy-returns", name: "Easy Returns", category: "shipping", imageUrl: badgeSvg("Easy Returns", "#5c6bc0"), tags: ["return"] },
  { id: "free-returns", name: "Free Returns", category: "shipping", imageUrl: badgeSvg("Free Returns", "#7b1fa2"), tags: ["return"] },
  { id: "worldwide-shipping", name: "Worldwide Shipping", category: "shipping", imageUrl: badgeSvg("Worldwide", "#0277bd"), tags: ["international"] },
  { id: "same-day", name: "Same Day Dispatch", category: "shipping", imageUrl: badgeSvg("Same Day", "#c62828"), tags: ["speed"] },
  { id: "tracked-delivery", name: "Tracked Delivery", category: "shipping", imageUrl: badgeSvg("Tracked", "#37474f"), tags: ["tracking"] },
  { id: "express-shipping", name: "Express Shipping", category: "shipping", imageUrl: badgeSvg("Express", "#d84315"), tags: ["speed"] },
  { id: "30-day-returns", name: "30 Day Returns", category: "shipping", imageUrl: badgeSvg("30-Day Returns", "#6a1b9a"), tags: ["return", "policy"] },
  { id: "carbon-neutral", name: "Carbon Neutral Shipping", category: "shipping", imageUrl: badgeSvg("Carbon Neutral", "#2e7d32"), tags: ["eco"] },

  // ── TRUST (12 badges) ──
  { id: "money-back", name: "Money Back Guarantee", category: "trust", imageUrl: circleSvg("Money Back", "#f57f17"), tags: ["guarantee", "refund"] },
  { id: "satisfaction", name: "100% Satisfaction", category: "trust", imageUrl: circleSvg("100%", "#43a047"), tags: ["guarantee"] },
  { id: "authentic", name: "100% Authentic", category: "trust", imageUrl: circleSvg("Authentic", "#1565c0"), tags: ["genuine"] },
  { id: "quality-assured", name: "Quality Assured", category: "trust", imageUrl: circleSvg("Quality", "#6a1b9a"), tags: ["quality"] },
  { id: "award-winner", name: "Award Winner", category: "trust", imageUrl: circleSvg("Award", "#ff8f00"), tags: ["recognition"] },
  { id: "top-rated", name: "Top Rated", category: "trust", imageUrl: circleSvg("Top Rated", "#d32f2f"), tags: ["rating"] },
  { id: "best-seller", name: "Best Seller", category: "trust", imageUrl: circleSvg("Best Seller", "#c62828"), tags: ["popular"] },
  { id: "customer-favorite", name: "Customer Favorite", category: "trust", imageUrl: circleSvg("Favorite", "#e91e63"), tags: ["popular"] },
  { id: "24-7-support", name: "24/7 Support", category: "trust", imageUrl: badgeSvg("24/7 Support", "#00838f"), tags: ["service"] },
  { id: "live-chat", name: "Live Chat Support", category: "trust", imageUrl: badgeSvg("Live Chat", "#00695c"), tags: ["service"] },
  { id: "price-match", name: "Price Match", category: "trust", imageUrl: badgeSvg("Price Match", "#4527a0"), tags: ["guarantee"] },
  { id: "warranty", name: "Lifetime Warranty", category: "trust", imageUrl: badgeSvg("Warranty", "#1b5e20"), tags: ["guarantee"] },

  // ── CUSTOM / SEASONAL (10 badges) ──
  { id: "natural", name: "100% Natural", category: "custom", imageUrl: badgeSvg("100% Natural", "#2e7d32"), tags: ["eco", "organic"] },
  { id: "cotton", name: "100% Cotton", category: "custom", imageUrl: badgeSvg("100% Cotton", "#5d4037"), tags: ["material"] },
  { id: "fresh", name: "100% Fresh", category: "custom", imageUrl: badgeSvg("100% Fresh", "#00c853"), tags: ["food"] },
  { id: "eco-friendly", name: "100% Eco Friendly", category: "custom", imageUrl: badgeSvg("Eco Friendly", "#1b5e20"), tags: ["eco"] },
  { id: "easy-to-return", name: "Easy To Return", category: "custom", imageUrl: badgeSvg("Easy Return", "#4a148c"), tags: ["return"] },
  { id: "authorized-dealer", name: "Authorized Dealer", category: "custom", imageUrl: badgeSvg("Authorized", "#283593"), tags: ["official"] },
  { id: "handmade", name: "Handmade", category: "custom", imageUrl: badgeSvg("Handmade", "#795548"), tags: ["craft"] },
  { id: "limited-edition", name: "Limited Edition", category: "custom", imageUrl: badgeSvg("Limited Ed.", "#b71c1c"), tags: ["exclusive"] },
  { id: "cruelty-free", name: "Cruelty Free", category: "custom", imageUrl: badgeSvg("Cruelty Free", "#e91e63"), tags: ["vegan", "eco"] },
  { id: "vegan", name: "100% Vegan", category: "custom", imageUrl: badgeSvg("Vegan", "#4caf50"), tags: ["vegan", "eco"] },
];

export const badgeCategories: { label: string; value: BadgeCategory | "all" }[] = [
  { label: "All Categories", value: "all" },
  { label: "Payment", value: "payment" },
  { label: "Security", value: "security" },
  { label: "Shipping", value: "shipping" },
  { label: "Trust", value: "trust" },
  { label: "Custom / Seasonal", value: "custom" },
];

export function getBadgeById(id: string): BadgeItem | undefined {
  return badgeLibrary.find((b) => b.id === id);
}

export function getBadgesByIds(ids: string[]): BadgeItem[] {
  return ids.map((id) => getBadgeById(id)).filter(Boolean) as BadgeItem[];
}

export function filterBadges(
  category: BadgeCategory | "all",
  search: string
): BadgeItem[] {
  return badgeLibrary.filter((badge) => {
    const matchesCategory = category === "all" || badge.category === category;
    const matchesSearch =
      !search ||
      badge.name.toLowerCase().includes(search.toLowerCase()) ||
      badge.tags.some((t) => t.toLowerCase().includes(search.toLowerCase()));
    return matchesCategory && matchesSearch;
  });
}
