import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate } from "@remix-run/react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  InlineGrid,
  Box,
  Icon,
  Badge,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;

  // Ensure ScriptTag is registered so widget.js loads on the storefront
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  if (appUrl) {
    const widgetSrc = `${appUrl}/widget.js`;
    try {
      const existing = await admin.rest.resources.ScriptTag.all({
        session,
        src: widgetSrc,
      });
      if (!existing.data || existing.data.length === 0) {
        const scriptTag = new admin.rest.resources.ScriptTag({ session });
        scriptTag.event = "onload";
        scriptTag.src = widgetSrc;
        scriptTag.display_scope = "online_store";
        await scriptTag.save({ update: true });
        console.log("BadgeHQ: ScriptTag registered from dashboard:", widgetSrc);
      }
    } catch (e) {
      console.error("BadgeHQ: ScriptTag registration failed:", e);
    }
  }

  const [
    trustBadgeCount,
    productBadgeCount,
    announcementBarCount,
    freeShippingBarCount,
    stickyCartCount,
    countdownTimerCount,
    appSettings,
  ] = await Promise.all([
    prisma.trustBadge.count({ where: { shop } }),
    prisma.productBadge.count({ where: { shop } }),
    prisma.announcementBar.count({ where: { shop } }),
    prisma.freeShippingBar.count({ where: { shop } }),
    prisma.stickyCart.count({ where: { shop } }),
    prisma.countdownTimer.count({ where: { shop } }),
    prisma.appSettings.findUnique({ where: { shop } }),
  ]);

  return json({
    stats: {
      trustBadges: trustBadgeCount,
      productBadges: productBadgeCount,
      announcementBars: announcementBarCount,
      freeShippingBars: freeShippingBarCount,
      stickyCarts: stickyCartCount,
      countdownTimers: countdownTimerCount,
    },
    isEnabled: appSettings?.isEnabled ?? true,
  });
};

const features = [
  {
    title: "Trust Badges",
    description: "Display payment & trust icons to build customer confidence",
    route: "/app/trust-badge",
    key: "trustBadges" as const,
  },
  {
    title: "Product Badges",
    description: "Overlay badges on product images (Sale, New, Hot, etc.)",
    route: "/app/product-badge",
    key: "productBadges" as const,
  },
  {
    title: "Announcement Bar",
    description: "Sticky announcement bar with rotating messages",
    route: "/app/announcement-bar",
    key: "announcementBars" as const,
  },
  {
    title: "Free Shipping Bar",
    description: "Progress bar showing how close to free shipping threshold",
    route: "/app/free-shipping-bar",
    key: "freeShippingBars" as const,
  },
  {
    title: "Sticky Add to Cart",
    description: "Sticky button that follows the customer on scroll",
    route: "/app/sticky-cart",
    key: "stickyCarts" as const,
  },
  {
    title: "Countdown Timer",
    description: "Create urgency with countdown timer widgets",
    route: "/app/countdown-timer",
    key: "countdownTimers" as const,
  },
];

export default function Dashboard() {
  const { stats, isEnabled } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <Page>
      <TitleBar title="BadgeHQ" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <InlineGrid columns={2} alignItems="center">
                  <Text as="h2" variant="headingLg">
                    Welcome to BadgeHQ
                  </Text>
                  <Box>
                    <Badge tone={isEnabled ? "success" : "critical"}>
                      {isEnabled ? "App Enabled" : "App Disabled"}
                    </Badge>
                  </Box>
                </InlineGrid>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Boost your store's trust and conversions with badges, banners,
                  and conversion tools.
                </Text>
              </BlockStack>
            </Card>
          </Layout.Section>
        </Layout>

        <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
          {features.map((feature) => (
            <Card key={feature.key}>
              <BlockStack gap="300">
                <Text as="h3" variant="headingMd">
                  {feature.title}
                </Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {feature.description}
                </Text>
                <InlineGrid columns={2} alignItems="center">
                  <Badge>
                    {`${stats[feature.key]} ${stats[feature.key] === 1 ? "widget" : "widgets"}`}
                  </Badge>
                  <Box>
                    <button
                      onClick={() => navigate(feature.route)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "var(--p-color-text-emphasis)",
                        cursor: "pointer",
                        textDecoration: "underline",
                        padding: 0,
                        font: "inherit",
                      }}
                    >
                      Manage
                    </button>
                  </Box>
                </InlineGrid>
              </BlockStack>
            </Card>
          ))}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
