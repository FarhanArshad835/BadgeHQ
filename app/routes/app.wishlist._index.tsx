import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.wishlistSettings.findUnique({
    where: { shop: session.shop },
  });
  return json({
    isEnabled: settings?.isEnabled ?? false,
    showOnCards: settings?.showOnCards ?? true,
    cardPosition: settings?.cardPosition ?? "top-right",
    showOnProduct: settings?.showOnProduct ?? true,
    productPlacement: settings?.productPlacement ?? "below-atc",
    showHeader: settings?.showHeader ?? true,
    iconColor: settings?.iconColor ?? "#e74c3c",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  const iconColor = String(data.iconColor || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(iconColor)) {
    return json({ error: "Icon color must be a hex color like #e74c3c." }, { status: 400 });
  }
  const cardPosition = data.cardPosition === "top-left" ? "top-left" : "top-right";
  const productPlacement = data.productPlacement === "above-atc" ? "above-atc" : "below-atc";

  try {
    const values = {
      isEnabled: Boolean(data.isEnabled),
      showOnCards: Boolean(data.showOnCards),
      cardPosition,
      showOnProduct: Boolean(data.showOnProduct),
      productPlacement,
      showHeader: Boolean(data.showHeader),
      iconColor,
    };
    await prisma.wishlistSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, ...values },
      update: values,
    });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

export default function WishlistSettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const initial = {
    enabled: loaderData.isEnabled,
    showOnCards: loaderData.showOnCards,
    cardPosition: loaderData.cardPosition,
    showOnProduct: loaderData.showOnProduct,
    productPlacement: loaderData.productPlacement,
    showHeader: loaderData.showHeader,
    iconColor: loaderData.iconColor,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [showOnCards, setShowOnCards] = useState(initial.showOnCards);
  const [cardPosition, setCardPosition] = useState(initial.cardPosition);
  const [showOnProduct, setShowOnProduct] = useState(initial.showOnProduct);
  const [productPlacement, setProductPlacement] = useState(initial.productPlacement);
  const [showHeader, setShowHeader] = useState(initial.showHeader);
  const [iconColor, setIconColor] = useState(initial.iconColor);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    showOnCards !== initial.showOnCards ||
    cardPosition !== initial.cardPosition ||
    showOnProduct !== initial.showOnProduct ||
    productPlacement !== initial.productPlacement ||
    showHeader !== initial.showHeader ||
    iconColor !== initial.iconColor;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setEnabled(initial.enabled);
    setShowOnCards(initial.showOnCards);
    setCardPosition(initial.cardPosition);
    setShowOnProduct(initial.showOnProduct);
    setProductPlacement(initial.productPlacement);
    setShowHeader(initial.showHeader);
    setIconColor(initial.iconColor);
  };

  const handleSave = () => {
    submit(
      {
        data: JSON.stringify({
          isEnabled: enabled,
          showOnCards,
          cardPosition,
          showOnProduct,
          productPlacement,
          showHeader,
          iconColor,
        }),
      },
      { method: "POST" },
    );
  };

  return (
    <Page>
      <TitleBar title="Wishlist">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Banner tone="info">
              Everything appears automatically — hearts on product cards, a wishlist
              button on product pages, and a header icon that opens the wishlist page at
              /apps/badgehq/wishlist. Guests keep their wishlist on their device;
              logged-in customers sync across devices. Changes reach your storefront in
              about a minute.
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Wishlist</Text>
                <Checkbox
                  label="Enable wishlist"
                  helpText="When disabled, all wishlist elements disappear from your storefront"
                  checked={enabled}
                  onChange={setEnabled}
                />
                <TextField
                  label="Heart color"
                  value={iconColor}
                  onChange={setIconColor}
                  autoComplete="off"
                  placeholder="#e74c3c"
                  helpText="Hex color used for filled hearts and the count badge"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Surfaces</Text>
                <Checkbox
                  label="Hearts on product cards (collections, featured products)"
                  checked={showOnCards}
                  onChange={setShowOnCards}
                />
                <Select
                  label="Card heart position"
                  disabled={!showOnCards}
                  options={[
                    { label: "Top right", value: "top-right" },
                    { label: "Top left", value: "top-left" },
                  ]}
                  value={cardPosition}
                  onChange={setCardPosition}
                />
                <Checkbox
                  label="Wishlist button on product pages"
                  checked={showOnProduct}
                  onChange={setShowOnProduct}
                />
                <Select
                  label="Product page button placement"
                  disabled={!showOnProduct}
                  options={[
                    { label: "Below Add to Cart", value: "below-atc" },
                    { label: "Above Add to Cart", value: "above-atc" },
                  ]}
                  value={productPlacement}
                  onChange={setProductPlacement}
                />
                <Checkbox
                  label="Header icon with item count"
                  helpText="Injected into the theme header; falls back to a floating button on themes without a standard header icon area"
                  checked={showHeader}
                  onChange={setShowHeader}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
