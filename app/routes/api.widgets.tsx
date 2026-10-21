/**
 * Public widget API endpoint.
 * Called directly from the storefront via cross-origin fetch.
 * Also handles app proxy requests forwarded by Shopify.
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { getStoreCurrency } from "../utils/currency.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle CORS preflight
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Handle CORS preflight that may arrive as GET on some browsers
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);
  const shop = url.searchParams.get("shop");

  if (!shop) {
    return json({ error: "Missing shop parameter" }, { status: 400, headers: CORS_HEADERS });
  }

  const appSettings = await prisma.appSettings.findUnique({
    where: { shop },
  });

  // Note: isEnabled DB flag is no longer used as a gate here.
  // The Theme App Extension itself controls whether widget.js runs on the storefront.

  // Get stored session to fetch store currency
  const session = await prisma.session.findFirst({
    where: { shop },
    orderBy: { expires: "desc" },
  });
  const { currencySymbol } = session?.accessToken
    ? await getStoreCurrency(shop, session.accessToken)
    : { currencySymbol: "$" };

  const [
    trustBadges,
    productBadges,
    announcementBars,
    freeShippingBars,
    bundleOffers,
    stickyCarts,
    countdownTimers,
    deliverySettings,
    orderManageSettings,
    wishlistSettings,
    backInStockSettings,
    aiReplySettings,
    merchSettings,
  ] = await Promise.all([
    prisma.trustBadge.findMany({ where: { shop, isEnabled: true } }),
    prisma.productBadge.findMany({ where: { shop, isActive: true }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }] }),
    prisma.announcementBar.findMany({ where: { shop, isActive: true } }),
    prisma.freeShippingBar.findMany({ where: { shop, isActive: true } }),
    prisma.bundleOffer.findMany({
      where: { shop, isActive: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),
    prisma.stickyCart.findMany({ where: { shop, isActive: true } }),
    prisma.countdownTimer.findMany({ where: { shop, isActive: true } }),
    prisma.deliverySettings.findUnique({ where: { shop } }),
    prisma.orderManageSettings.findUnique({ where: { shop } }),
    prisma.wishlistSettings.findUnique({ where: { shop } }),
    prisma.backInStockSettings.findUnique({ where: { shop } }),
    prisma.aiReplySettings.findUnique({ where: { shop } }),
    // Only the on/off flag reaches the storefront: the collector must not run
    // (or cost a beacon) for a shop that has not enabled behaviour tracking.
    prisma.merchandiseSettings.findUnique({
      where: { shop },
      select: {
        isEnabled: true,
        weightCart: true,
        weightWish: true,
        weightDwell: true,
        weightViews: true,
      },
    }),
  ]);

  const globalSettings = appSettings
    ? JSON.parse(appSettings.settings)
    : { fontFamily: "inherit", colorScheme: "light" };

  const widgets = {
    trustBadges: trustBadges.map((b) => ({
      id: b.id,
      name: b.name,
      badgeIds: JSON.parse(b.badgeIds),
      settings: JSON.parse(b.settings),
    })),
    productBadges: productBadges.map((b) => ({
      id: b.id,
      text: b.text,
      badgeType: b.badgeType,
      shape: b.shape,
      badgeColor: b.badgeColor,
      textColor: b.textColor,
      position: b.position,
      placement: (b as any).placement || "image",
      infoPosition: (b as any).infoPosition || "above-price",
      hideComparePrice: !!(b as any).hideComparePrice,
      padTop: (b as any).padTop ?? 4,
      padRight: (b as any).padRight ?? 8,
      padBottom: (b as any).padBottom ?? 4,
      padLeft: (b as any).padLeft ?? 8,
      priceRule: (() => {
        try {
          return JSON.parse((b as any).priceRule || "{}");
        } catch {
          return { mode: "hide" };
        }
      })(),
      targeting: JSON.parse(b.targeting),
      condition: JSON.parse(b.condition),
      pages: JSON.parse(b.pages),
      schedule: JSON.parse(b.schedule),
      priority: b.priority,
      imageUrl: b.imageUrl,
      fontSize: b.fontSize,
      fontSizeMobile: (b as any).fontSizeMobile ?? b.fontSize,
      opacity: b.opacity,
      rotation: b.rotation,
      gradient: b.gradient,
      borderColor: b.borderColor,
      borderWidth: b.borderWidth,
      customCSS: b.customCSS,
    })),
    announcementBars: announcementBars.map((b) => ({
      id: b.id,
      messages: JSON.parse(b.messages),
      bgColor: b.bgColor,
      textColor: b.textColor,
      showClose: b.showClose,
      pages: JSON.parse(b.pages),
      schedule: JSON.parse(b.schedule),
    })),
    freeShippingBars: freeShippingBars.map((b) => ({
      id: b.id,
      threshold: b.threshold,
      messages: JSON.parse(b.messages),
      colors: JSON.parse(b.colors),
      pages: JSON.parse(b.pages),
    })),
    bundleOffers: bundleOffers.map((b) => ({
      id: b.id,
      title: b.title,
      quantity: b.quantity,
      scope: b.scope,
      collectionHandle: b.collectionHandle,
      // Labels the shop link; the widget matches on handle, not this.
      collectionTitle: b.collectionTitle,
      ctaText: b.ctaText,
      flagText: b.flagText,
      productHandles: JSON.parse(b.productHandles),
      messages: JSON.parse(b.messages),
      colors: JSON.parse(b.colors),
      showProgress: b.showProgress,
      pages: JSON.parse(b.pages),
    })),
    // Tracking is on whenever merchandising is, independent of the server
    // weights: the four behaviour sliders now drive the shopper's own
    // client-side reorder, which is per-browser and needs the data collected
    // even when the shared server ranking ignores behaviour entirely.
    behaviourTracking: Boolean(merchSettings?.isEnabled),
    // What each shopper action is worth in that client reorder. Sent so the
    // merchant's sliders decide it rather than constants baked into the
    // widget, and so a change takes effect on the next page load.
    behaviourWeights: {
      cart: merchSettings?.weightCart ?? 8,
      wish: merchSettings?.weightWish ?? 5,
      dwell: merchSettings?.weightDwell ?? 2,
      views: merchSettings?.weightViews ?? 1,
    },
    stickyCarts: stickyCarts.map((b) => ({
      id: b.id,
      buttonText: b.buttonText,
      buttonColor: b.buttonColor,
      bgColor: b.bgColor,
      textColor: b.textColor ?? "#ffffff",
      buttonStyle: b.buttonStyle ?? "solid",
      buttonRadius: b.buttonRadius ?? "6",
      barPadding: b.barPadding ?? "10",
      showPrice: b.showPrice ?? true,
      showQuantity: b.showQuantity ?? true,
      alwaysShow: b.alwaysShow ?? false,
      showMobile: b.showMobile,
      showDesktop: b.showDesktop,
      position: b.position,
    })),
    countdownTimers: countdownTimers.map((b) => ({
      id: b.id,
      endDate: b.endDate.toISOString(),
      style: b.style,
      messages: JSON.parse(b.messages),
      colors: JSON.parse(b.colors),
      pages: JSON.parse(b.pages),
    })),
    // Only the boolean + placement — the Delhivery token/origin pin never
    // leave the server.
    deliveryEstimate: {
      enabled: Boolean(
        deliverySettings?.isEnabled &&
        deliverySettings?.apiToken &&
        /^\d{6}$/.test(deliverySettings?.originPin ?? ""),
      ),
      placement: deliverySettings?.placement ?? "below-atc",
      // Merchant-editable widget text (safe to expose — no token involved).
      heading: deliverySettings?.headingText ?? "Estimate delivery date",
      deliverBy: deliverySettings?.deliverByText ?? "Delivery by",
      freeDelivery: deliverySettings?.freeDeliveryOn
        ? (deliverySettings?.freeDeliveryText ?? "Free delivery")
        : "",
      fasterNote: deliverySettings?.fasterNoteOn
        ? (deliverySettings?.fasterNoteText ?? "")
        : "",
    },
    orderManagement: {
      enabled: Boolean(orderManageSettings?.isEnabled),
      allowCancel: orderManageSettings?.allowCancel ?? true,
      cancelScope: orderManageSettings?.cancelScope ?? "unpaid",
      allowAddressEdit: orderManageSettings?.allowAddressEdit ?? true,
      showOnPages: orderManageSettings?.showOnPages
        ? JSON.parse(orderManageSettings.showOnPages)
        : ["account"],
    },
    aiReplies: {
      // Requires a key to be usable — and the key itself never leaves the
      // server, exactly like the Delhivery token.
      enabled: Boolean(aiReplySettings?.isEnabled && aiReplySettings?.apiKey),
      botName: aiReplySettings?.botName ?? "Support",
      greeting: aiReplySettings?.greeting ?? "Hi! Ask me about shipping, returns or sizing.",
      supportEmail: aiReplySettings?.supportEmail ?? "",
      supportUrl: aiReplySettings?.supportUrl ?? "",
      accentColor: aiReplySettings?.accentColor ?? "#111111",
      position: aiReplySettings?.position ?? "bottom-right",
    },
    backInStock: {
      enabled: Boolean(backInStockSettings?.isEnabled),
      placement: backInStockSettings?.placement ?? "below-atc",
      buttonText: backInStockSettings?.buttonText ?? "Notify me when available",
      headingText: backInStockSettings?.headingText ?? "Get notified when this is back",
      consentText:
        backInStockSettings?.consentText ??
        "We'll message you on WhatsApp when it's back in stock.",
      successText:
        backInStockSettings?.successText ?? "Done! We'll WhatsApp you when it's back in stock.",
    },
    wishlist: {
      enabled: Boolean(wishlistSettings?.isEnabled),
      showOnCards: wishlistSettings?.showOnCards ?? true,
      cardPosition: wishlistSettings?.cardPosition ?? "top-right",
      showOnProduct: wishlistSettings?.showOnProduct ?? true,
      productPlacement: wishlistSettings?.productPlacement ?? "below-atc",
      showHeader: wishlistSettings?.showHeader ?? true,
      iconColor: wishlistSettings?.iconColor ?? "#e74c3c",
    },
  };

  return json(
    { enabled: true, currencySymbol, globalSettings, widgets },
    {
      headers: {
        ...CORS_HEADERS,
        // Browser caches for 5 min, Vercel edge caches for 10 min.
        // s-maxage is what enables edge caching of dynamic routes — without
        // it, every request hits the origin Lambda even if Vercel could
        // serve from cache. The dashboard previously showed this route at
        // 0% cached vs /api/products/inventory at 93.5% — exact same kind
        // of data, but inventory had s-maxage in its response.
        "Cache-Control": "public, max-age=300, s-maxage=600, stale-while-revalidate=60",
      },
    },
  );
};
