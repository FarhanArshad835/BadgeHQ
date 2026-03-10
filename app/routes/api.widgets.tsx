/**
 * Public widget API endpoint.
 * Called directly from the storefront via cross-origin fetch.
 * Also handles app proxy requests forwarded by Shopify.
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";

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

  if (appSettings && !appSettings.isEnabled) {
    return json(
      { enabled: false, widgets: {} },
      {
        headers: {
          ...CORS_HEADERS,
          "Cache-Control": "public, max-age=60",
        },
      },
    );
  }

  const [
    trustBadges,
    productBadges,
    announcementBars,
    freeShippingBars,
    stickyCarts,
    countdownTimers,
  ] = await Promise.all([
    prisma.trustBadge.findMany({ where: { shop, isEnabled: true } }),
    prisma.productBadge.findMany({ where: { shop, isActive: true }, orderBy: { priority: "desc" } }),
    prisma.announcementBar.findMany({ where: { shop, isActive: true } }),
    prisma.freeShippingBar.findMany({ where: { shop, isActive: true } }),
    prisma.stickyCart.findMany({ where: { shop, isActive: true } }),
    prisma.countdownTimer.findMany({ where: { shop, isActive: true } }),
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
      targeting: JSON.parse(b.targeting),
      condition: JSON.parse(b.condition),
      pages: JSON.parse(b.pages),
      schedule: JSON.parse(b.schedule),
      priority: b.priority,
      imageUrl: b.imageUrl,
      fontSize: b.fontSize,
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
    stickyCarts: stickyCarts.map((b) => ({
      id: b.id,
      buttonText: b.buttonText,
      buttonColor: b.buttonColor,
      bgColor: b.bgColor,
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
  };

  return json(
    { enabled: true, globalSettings, widgets },
    {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "public, max-age=60",
      },
    },
  );
};
