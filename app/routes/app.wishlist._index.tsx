import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
  Button,
  Badge,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { sendWishlistEvent } from "../utils/meta-capi.server";

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
    // Meta Conversions API. The dataset id is public (it identifies the pixel),
    // but the access token NEVER leaves the server — only whether one is saved,
    // plus a last-4 preview so the merchant can tell which token is in place.
    capiEnabled: settings?.capiEnabled ?? false,
    capiDatasetId: settings?.capiDatasetId ?? "",
    hasCapiToken: Boolean(settings?.capiAccessToken),
    capiTokenPreview: settings?.capiAccessToken ? settings.capiAccessToken.slice(-4) : "",
    capiSendEmail: settings?.capiSendEmail ?? false,
    eventCount: await prisma.wishlistEvent.count({ where: { shop: session.shop } }),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // "Send test event" uses the SAVED token, so the merchant doesn't have to
  // paste a secret again just to check the connection works.
  if (formData.get("intent") === "test-capi") {
    const s = await prisma.wishlistSettings.findUnique({ where: { shop: session.shop } });
    if (!s?.capiDatasetId || !s?.capiAccessToken) {
      return json({ error: "Save a Meta dataset id and access token first." }, { status: 400 });
    }
    const result = await sendWishlistEvent({
      datasetId: s.capiDatasetId,
      accessToken: s.capiAccessToken,
      handle: "badgehq-test-product",
      // A synthetic identifier: enough for Meta to accept the event without
      // attributing it to a real shopper.
      customerId: `badgehq-test-${session.shop}`,
      eventId: `badgehq-test-${Date.now()}`,
      testEventCode: String(formData.get("testEventCode") || "").trim() || undefined,
    });
    return result.ok
      ? json({ testOk: `Meta accepted the test event (${result.eventsReceived} received). Check Events Manager > Test Events.` })
      : json({ error: result.reason }, { status: 400 });
  }

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
      capiEnabled: Boolean(data.capiEnabled),
      capiDatasetId: String(data.capiDatasetId || "").trim().replace(/\D/g, ""),
      capiSendEmail: Boolean(data.capiSendEmail),
    };
    // A blank token field means "keep the saved one" — the house convention, so
    // saving an unrelated setting can't silently wipe the credential.
    const newToken = String(data.capiAccessToken || "").trim();
    await prisma.wishlistSettings.upsert({
      where: { shop: session.shop },
      create: { shop: session.shop, ...values, ...(newToken ? { capiAccessToken: newToken } : {}) },
      update: { ...values, ...(newToken ? { capiAccessToken: newToken } : {}) },
    });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

export default function WishlistSettingsPage() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string; testOk?: string }>();
  const submit = useSubmit();

  const initial = {
    enabled: loaderData.isEnabled,
    showOnCards: loaderData.showOnCards,
    cardPosition: loaderData.cardPosition,
    showOnProduct: loaderData.showOnProduct,
    productPlacement: loaderData.productPlacement,
    showHeader: loaderData.showHeader,
    iconColor: loaderData.iconColor,
    capiEnabled: loaderData.capiEnabled,
    capiDatasetId: loaderData.capiDatasetId,
    capiSendEmail: loaderData.capiSendEmail,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [showOnCards, setShowOnCards] = useState(initial.showOnCards);
  const [cardPosition, setCardPosition] = useState(initial.cardPosition);
  const [showOnProduct, setShowOnProduct] = useState(initial.showOnProduct);
  const [productPlacement, setProductPlacement] = useState(initial.productPlacement);
  const [showHeader, setShowHeader] = useState(initial.showHeader);
  const [iconColor, setIconColor] = useState(initial.iconColor);
  const [capiEnabled, setCapiEnabled] = useState(initial.capiEnabled);
  const [capiDatasetId, setCapiDatasetId] = useState(initial.capiDatasetId);
  // Starts empty: the saved token is never sent to the browser, so an empty
  // field means "unchanged" rather than "cleared".
  const [capiAccessToken, setCapiAccessToken] = useState("");
  const [capiSendEmail, setCapiSendEmail] = useState(initial.capiSendEmail);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    showOnCards !== initial.showOnCards ||
    cardPosition !== initial.cardPosition ||
    showOnProduct !== initial.showOnProduct ||
    productPlacement !== initial.productPlacement ||
    showHeader !== initial.showHeader ||
    iconColor !== initial.iconColor ||
    capiEnabled !== initial.capiEnabled ||
    capiDatasetId !== initial.capiDatasetId ||
    capiSendEmail !== initial.capiSendEmail ||
    capiAccessToken.length > 0;

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
    setCapiEnabled(initial.capiEnabled);
    setCapiDatasetId(initial.capiDatasetId);
    setCapiAccessToken("");
    setCapiSendEmail(initial.capiSendEmail);
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
          capiEnabled,
          capiDatasetId,
          capiAccessToken,
          capiSendEmail,
        }),
      },
      { method: "POST" },
    );
  };

  const handleTestCapi = () => {
    submit({ intent: "test-capi" }, { method: "POST" });
  };

  // Two columns on a wide screen: settings left, integrations right. A single
  // stacked column left most of the display empty and pushed Meta and the CSV
  // export below the fold.
  return (
    <Page fullWidth>
      <TitleBar title="Wishlist">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <BlockStack gap="300">
        {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <BlockStack gap="300">
            <Card>
              <BlockStack gap="300">
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

          {/* Right column: the two things merchants buy this for. */}
          <BlockStack gap="300">
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Send wishlists to Meta</Text>
                  <Badge tone={loaderData.capiEnabled ? "success" : undefined}>
                    {loaderData.capiEnabled ? "On" : "Off"}
                  </Badge>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Every saved product is sent to Meta as an <b>AddToWishlist</b> event, so Facebook and
                  Instagram can retarget that shopper with the exact product they saved. Sent from our
                  server, so ad-blockers do not stop it. Works for guests as well as logged-in customers.
                </Text>

                <Checkbox
                  label="Send wishlist events to Meta"
                  checked={capiEnabled}
                  onChange={setCapiEnabled}
                />
                <TextField
                  label="Dataset (Pixel) ID"
                  value={capiDatasetId}
                  onChange={setCapiDatasetId}
                  autoComplete="off"
                  placeholder="1234567890123456"
                  helpText="Events Manager → your dataset → Settings. Digits only."
                />
                <TextField
                  label="Conversions API access token"
                  type="password"
                  value={capiAccessToken}
                  onChange={setCapiAccessToken}
                  autoComplete="off"
                  placeholder={
                    loaderData.hasCapiToken
                      ? `Saved token ending in ${loaderData.capiTokenPreview}. Enter a new one to replace it.`
                      : "Paste the token generated in Events Manager"
                  }
                  helpText="Events Manager → Settings → Generate access token. Stored securely, server-side only. Never sent to your storefront."
                />

                <InlineStack gap="300" blockAlign="center">
                  <Button onClick={handleTestCapi} disabled={!loaderData.hasCapiToken}>
                    Send test event
                  </Button>
                  <Text as="span" tone="subdued">
                    Then check Events Manager → Test Events.
                  </Text>
                </InlineStack>

                {actionData?.testOk && <Banner tone="success">{actionData.testOk}</Banner>}

                {/* Email is Shopify Protected Customer Data Level 2. Requesting it
                    without approval makes Shopify reject the whole query, so this
                    stays off until approval lands — then it's one checkbox. */}
                <Checkbox
                  label="Also send hashed customer email (needs Shopify approval)"
                  checked={capiSendEmail}
                  onChange={setCapiSendEmail}
                  helpText="Improves Meta's match rate. Requires Protected Customer Data Level 2 approval from Shopify. Leave this off until that is granted, or events will fail."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">Export wishlist data</Text>
                <Text as="p" tone="subdued">
                  {loaderData.eventCount > 0
                    ? `${loaderData.eventCount.toLocaleString()} wishlist ${loaderData.eventCount === 1 ? "action" : "actions"} recorded: which customer saved which product, and when.`
                    : "No wishlist activity recorded yet. Saves are recorded from now on; anything wishlisted before today isn't included."}
                </Text>
                <InlineStack>
                  <Button url="/app/wishlist/export" download disabled={loaderData.eventCount === 0}>
                    Download CSV
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            {/* Moved below the settings it explains, rather than above them. */}
            <Banner tone="info">
              Everything appears automatically: hearts on product cards, a wishlist button on
              product pages, and a header icon that opens the wishlist page at
              /apps/badgehq/wishlist. Guests keep their wishlist on their device; logged-in
              customers sync across devices. Changes reach your storefront in about a minute.
            </Banner>
          </BlockStack>
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
