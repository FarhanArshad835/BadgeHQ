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
  Badge,
  Banner,
  List,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";


async function checkThemeExtensionEnabled(shop: string, accessToken: string): Promise<boolean> {
  try {
    // Get the active (main) theme
    const themesResp = await fetch(
      `https://${shop}/admin/api/2025-01/themes.json?role=main`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!themesResp.ok) return false;
    const themesData = await themesResp.json() as { themes?: { id: number }[] };
    const themeId = themesData.themes?.[0]?.id;
    if (!themeId) return false;

    // Fetch the theme's settings_data.json which contains app embed block states
    const assetResp = await fetch(
      `https://${shop}/admin/api/2025-01/themes/${themeId}/assets.json?asset[key]=config/settings_data.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    if (!assetResp.ok) return false;
    const assetData = await assetResp.json() as { asset?: { value?: string } };
    const content = assetData.asset?.value;
    if (!content) return false;

    const settings = JSON.parse(content) as {
      current?: { blocks?: Record<string, { type?: string; disabled?: boolean }> };
    };
    const blocks = settings?.current?.blocks ?? {};

    // Block keys are numeric IDs — match on the block's type field which contains the app handle
    return Object.values(blocks).some(
      (block) => block.type?.includes("badgehq") && block.disabled !== true
    );
  } catch {
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const accessToken = session.accessToken!;

  const [
    trustBadgeCount,
    productBadgeCount,
    announcementBarCount,
    freeShippingBarCount,
    stickyCartCount,
    countdownTimerCount,
    themeExtensionEnabled,
  ] = await Promise.all([
    prisma.trustBadge.count({ where: { shop } }),
    prisma.productBadge.count({ where: { shop } }),
    prisma.announcementBar.count({ where: { shop } }),
    prisma.freeShippingBar.count({ where: { shop } }),
    prisma.stickyCart.count({ where: { shop } }),
    prisma.countdownTimer.count({ where: { shop } }),
    checkThemeExtensionEnabled(shop, accessToken),
  ]);

  const shopHandle = shop.replace(".myshopify.com", "");
  // Deep link directly to BadgeHQ Widget in App Embeds and auto-activate it
  const themeEditorUrl = `https://admin.shopify.com/store/${shopHandle}/themes/current/editor?context=apps&activateAppId=019cdd10-586c-7dc0-93a3-dc55c3f1c3fb/badgehq-widget`;

  return json({
    stats: {
      trustBadges: trustBadgeCount,
      productBadges: productBadgeCount,
      announcementBars: announcementBarCount,
      freeShippingBars: freeShippingBarCount,
      stickyCarts: stickyCartCount,
      countdownTimers: countdownTimerCount,
    },
    isEnabled: themeExtensionEnabled,
    themeEditorUrl,
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
  const { stats, isEnabled, themeEditorUrl } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <Page>
      <TitleBar title="BadgeHQ" />
      <BlockStack gap="500">
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {/* Setup instructions banner — auto-hidden when widget is detected as active */}
              {!isEnabled && (
                <Banner
                  title="Activate BadgeHQ on your storefront"
                  tone="warning"
                >
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">
                      BadgeHQ uses a Theme App Extension to display widgets on your storefront. Follow these steps to get started:
                    </Text>
                    <List type="number">
                      <List.Item>
                        Click <strong>Open Theme Editor</strong> below to go directly to the App Embeds section.
                      </List.Item>
                      <List.Item>
                        Find <strong>BadgeHQ Widget</strong> in the App Embeds list and toggle it on.
                      </List.Item>
                      <List.Item>
                        Click <strong>Save</strong> in the Theme Editor to activate the widget on your store.
                      </List.Item>
                      <List.Item>
                        Return here — the banner will disappear automatically once detected as active.
                      </List.Item>
                    </List>
                    <Box paddingBlockStart="200">
                      {/*
                        target="_top" navigates the top-level browser frame to the URL,
                        escaping the embedded iframe. App Bridge cannot intercept this.
                        Polaris Button / window.open both fail inside cross-origin iframes.
                      */}
                      <a
                        href={themeEditorUrl}
                        target="_top"
                        rel="noopener noreferrer"
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "4px",
                          padding: "6px 12px",
                          border: "1px solid #8c9196",
                          borderRadius: "6px",
                          background: "#ffffff",
                          color: "#202223",
                          fontSize: "0.875rem",
                          fontWeight: 500,
                          textDecoration: "none",
                          cursor: "pointer",
                          lineHeight: 1.5,
                        }}
                      >
                        Open Theme Editor ↗
                      </a>
                    </Box>
                  </BlockStack>
                </Banner>
              )}

              <Card>
                <BlockStack gap="400">
                  <InlineGrid columns={2} alignItems="center">
                    <Text as="h2" variant="headingLg">
                      Welcome to BadgeHQ
                    </Text>
                    <Box>
                      <Badge tone={isEnabled ? "success" : "warning"}>
                        {isEnabled ? "Widget Active" : "Setup Required"}
                      </Badge>
                    </Box>
                  </InlineGrid>
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Boost your store's trust and conversions with badges, banners,
                    and conversion tools.
                  </Text>
                </BlockStack>
              </Card>
            </BlockStack>
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
