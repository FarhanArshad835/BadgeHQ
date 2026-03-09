import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useNavigate, useSubmit } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  ChoiceList,
  Button,
  InlineStack,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const BADGE_LIBRARY = {
  payment: [
    { id: "paypal", label: "PayPal", icon: "PayPal" },
    { id: "visa", label: "Visa", icon: "Visa" },
    { id: "mastercard", label: "Mastercard", icon: "Mastercard" },
    { id: "amex", label: "American Express", icon: "Amex" },
    { id: "apple-pay", label: "Apple Pay", icon: "Apple Pay" },
    { id: "google-pay", label: "Google Pay", icon: "Google Pay" },
    { id: "stripe", label: "Stripe", icon: "Stripe" },
  ],
  trust: [
    { id: "ssl-secure", label: "SSL Secure", icon: "SSL" },
    { id: "money-back", label: "Money Back Guarantee", icon: "Money Back" },
    { id: "free-shipping", label: "Free Shipping", icon: "Free Shipping" },
    { id: "support-24-7", label: "24/7 Support", icon: "24/7 Support" },
    { id: "easy-returns", label: "Easy Returns", icon: "Easy Returns" },
  ],
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  return json({});
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    const badge = await prisma.trustBadge.create({
      data: {
        shop: session.shop,
        title: data.title,
        badges: JSON.stringify(data.badges),
        settings: JSON.stringify(data.settings),
        isActive: data.isActive,
        position: data.position,
        pages: JSON.stringify(data.pages),
      },
    });
    return redirect(`/app/trust-badge/${badge.id}`);
  } catch (error) {
    return json({ error: "Failed to create trust badge" }, { status: 500 });
  }
};

export default function NewTrustBadge() {
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const [title, setTitle] = useState("Trust Badges");
  const [selectedBadges, setSelectedBadges] = useState<string[]>(["visa", "mastercard", "paypal", "ssl-secure"]);
  const [size, setSize] = useState("medium");
  const [badgeColor, setBadgeColor] = useState("#333333");
  const [bgColor, setBgColor] = useState("#ffffff");
  const [showTitle, setShowTitle] = useState(true);
  const [position, setPosition] = useState("after-add-to-cart");
  const [pages, setPages] = useState<string[]>(["product"]);
  const [isActive, setIsActive] = useState(true);

  const handleSave = () => {
    const data = {
      title,
      badges: selectedBadges,
      settings: { size, badgeColor, bgColor, showTitle },
      isActive,
      position,
      pages,
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const toggleBadge = useCallback((badgeId: string) => {
    setSelectedBadges((prev) =>
      prev.includes(badgeId)
        ? prev.filter((id) => id !== badgeId)
        : [...prev, badgeId]
    );
  }, []);

  const allBadges = [...BADGE_LIBRARY.payment, ...BADGE_LIBRARY.trust];

  return (
    <Page>
      <TitleBar title="Create Trust Badge">
        <button onClick={() => navigate("/app/trust-badge")}>Back</button>
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error && (
              <Banner tone="critical">{actionData.error}</Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">General</Text>
                <TextField
                  label="Widget Title"
                  value={title}
                  onChange={setTitle}
                  autoComplete="off"
                />
                <Checkbox
                  label="Show title on storefront"
                  checked={showTitle}
                  onChange={setShowTitle}
                />
                <Checkbox
                  label="Active"
                  checked={isActive}
                  onChange={setIsActive}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Badge Library</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Payment Icons
                </Text>
                <InlineStack gap="200" wrap>
                  {BADGE_LIBRARY.payment.map((badge) => (
                    <Button
                      key={badge.id}
                      pressed={selectedBadges.includes(badge.id)}
                      onClick={() => toggleBadge(badge.id)}
                      size="slim"
                    >
                      {badge.label}
                    </Button>
                  ))}
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Trust Icons
                </Text>
                <InlineStack gap="200" wrap>
                  {BADGE_LIBRARY.trust.map((badge) => (
                    <Button
                      key={badge.id}
                      pressed={selectedBadges.includes(badge.id)}
                      onClick={() => toggleBadge(badge.id)}
                      size="slim"
                    >
                      {badge.label}
                    </Button>
                  ))}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Appearance</Text>
                <Select
                  label="Badge Size"
                  options={[
                    { label: "Small", value: "small" },
                    { label: "Medium", value: "medium" },
                    { label: "Large", value: "large" },
                  ]}
                  value={size}
                  onChange={setSize}
                />
                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Badge Color"
                    value={badgeColor}
                    onChange={setBadgeColor}
                    autoComplete="off"
                    prefix={
                      <div
                        style={{
                          width: 20,
                          height: 20,
                          backgroundColor: badgeColor,
                          borderRadius: 4,
                          border: "1px solid #ccc",
                        }}
                      />
                    }
                  />
                  <TextField
                    label="Background Color"
                    value={bgColor}
                    onChange={setBgColor}
                    autoComplete="off"
                    prefix={
                      <div
                        style={{
                          width: 20,
                          height: 20,
                          backgroundColor: bgColor,
                          borderRadius: 4,
                          border: "1px solid #ccc",
                        }}
                      />
                    }
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Placement</Text>
                <Select
                  label="Position"
                  options={[
                    { label: "Before Add to Cart", value: "before-add-to-cart" },
                    { label: "After Add to Cart", value: "after-add-to-cart" },
                  ]}
                  value={position}
                  onChange={setPosition}
                />
                <ChoiceList
                  title="Show on pages"
                  allowMultiple
                  choices={[
                    { label: "Product Page", value: "product" },
                    { label: "Cart Page", value: "cart" },
                    { label: "Checkout", value: "checkout" },
                  ]}
                  selected={pages}
                  onChange={setPages}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Preview</Text>
              <Box
                padding="400"
                background="bg-surface"
                borderWidth="025"
                borderRadius="200"
                borderColor="border"
              >
                <div style={{ backgroundColor: bgColor, padding: "16px", borderRadius: "8px", textAlign: "center" }}>
                  {showTitle && (
                    <p style={{ margin: "0 0 12px", fontWeight: 600, fontSize: size === "small" ? "12px" : size === "medium" ? "14px" : "16px" }}>
                      {title}
                    </p>
                  )}
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", justifyContent: "center" }}>
                    {selectedBadges.map((badgeId) => {
                      const badge = allBadges.find((b) => b.id === badgeId);
                      if (!badge) return null;
                      const iconSize = size === "small" ? 32 : size === "medium" ? 44 : 56;
                      return (
                        <div
                          key={badgeId}
                          style={{
                            width: iconSize,
                            height: iconSize,
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                            backgroundColor: badgeColor,
                            color: "#fff",
                            borderRadius: "6px",
                            fontSize: size === "small" ? "8px" : size === "medium" ? "10px" : "12px",
                            fontWeight: 600,
                            textAlign: "center",
                            lineHeight: 1.2,
                            padding: "2px",
                          }}
                        >
                          {badge.icon}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
