import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
  Badge,
  Button,
  DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { sendWhatsAppTemplate, toIndianTenDigit } from "../utils/whatsapp.server";

const PLACEMENTS = ["below-atc", "above-atc", "replace-button"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const [settings, subs, waitingCount, notifiedCount] = await Promise.all([
    prisma.backInStockSettings.findUnique({ where: { shop } }),
    prisma.backInStockSubscription.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
    prisma.backInStockSubscription.count({ where: { shop, notifiedAt: null } }),
    prisma.backInStockSubscription.count({ where: { shop, NOT: { notifiedAt: null } } }),
  ]);

  return json({
    shop,
    isEnabled: settings?.isEnabled ?? false,
    placement: settings?.placement ?? "below-atc",
    buttonText: settings?.buttonText ?? "Notify me when available",
    headingText: settings?.headingText ?? "Get notified when this is back",
    consentText:
      settings?.consentText ?? "We'll message you on WhatsApp when it's back in stock.",
    successText: settings?.successText ?? "Done! We'll WhatsApp you when it's back in stock.",
    // The raw provider key never leaves the server — only whether one is saved.
    waEnabled: settings?.waEnabled ?? false,
    waProvider: settings?.waProvider ?? "interakt",
    hasWaKey: Boolean(settings?.waApiKey),
    waKeyPreview: settings?.waApiKey ? settings.waApiKey.slice(-4) : "",
    waTemplateName: settings?.waTemplateName ?? "",
    waLanguageCode: settings?.waLanguageCode ?? "en",
    waFromNumber: settings?.waFromNumber ?? "",
    waFallbackImage: settings?.waFallbackImage ?? "",
    waitingCount,
    notifiedCount,
    subscribers: subs.map((s) => ({
      id: s.id,
      email: s.email,
      phone: s.phone,
      variantId: s.variantId,
      subscribed: Boolean(s.customerId),
      notified: Boolean(s.notifiedAt),
      createdAt: s.createdAt.toISOString().slice(0, 10),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  // Test send — uses the SAVED key so the merchant can verify setup without
  // re-pasting it, and without waiting for a real restock.
  if (formData.get("intent") === "test") {
    const s = await prisma.backInStockSettings.findUnique({ where: { shop: session.shop } });
    if (!s?.waApiKey || !s.waTemplateName) {
      return json({ testError: "Save your API key and template name first." });
    }
    if (s.waProvider === "doubletick" && !s.waFromNumber) {
      return json({ testError: "DoubleTick needs your sender number. Save it first." });
    }
    const phone = toIndianTenDigit(formData.get("testPhone"));
    if (!phone) {
      return json({ testError: "Enter a valid 10-digit Indian mobile number." });
    }
    const res = await sendWhatsAppTemplate({
      provider: s.waProvider,
      apiKey: s.waApiKey,
      phone,
      templateName: s.waTemplateName,
      languageCode: s.waLanguageCode || "en",
      fromNumber: s.waFromNumber,
      bodyValues: ["Test product", "Test variant", `https://${session.shop}`],
      headerImageUrl: s.waFallbackImage || undefined,
      // Exercises the dynamic URL button too, so a template misconfiguration
      // shows up in the test rather than on a real restock.
      buttonUrlSuffix: "test-product",
      callbackData: "bis:test",
    });
    return res.ok
      ? json({ testResult: `Sent to ${phone}. Check WhatsApp — it can take a few seconds.` })
      : json({ testError: `Send failed: ${res.error}` });
  }

  const data = JSON.parse(formData.get("data") as string);

  const placement = PLACEMENTS.includes(data.placement) ? data.placement : "below-atc";
  const text = (v: unknown, fallback: string) => {
    const s = String(v ?? "").trim();
    return s ? s.slice(0, 300) : fallback;
  };

  const newKey = String(data.waApiKey || "").trim();
  const waProvider = data.waProvider === "doubletick" ? "doubletick" : "interakt";
  // WhatsApp template names are lowercase alphanumeric + underscore.
  const templateName = String(data.waTemplateName || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 100);
  const languageCode = String(data.waLanguageCode || "en").trim().slice(0, 10) || "en";
  const fromNumber = String(data.waFromNumber || "").trim().replace(/[^\d+]/g, "").slice(0, 20);
  // Only accept an https image URL — WhatsApp refuses anything else.
  const rawImage = String(data.waFallbackImage || "").trim().slice(0, 500);
  const fallbackImage = /^https:\/\//.test(rawImage) ? rawImage : "";

  try {
    const values = {
      isEnabled: Boolean(data.isEnabled),
      placement,
      buttonText: text(data.buttonText, "Notify me when available"),
      headingText: text(data.headingText, "Get notified when this is back"),
      consentText: text(
        data.consentText,
        "We'll message you on WhatsApp when it's back in stock.",
      ),
      successText: text(data.successText, "Done! We'll WhatsApp you when it's back in stock."),
      waEnabled: Boolean(data.waEnabled),
      waProvider,
      // Empty key field means "keep the saved key".
      ...(newKey ? { waApiKey: newKey } : {}),
      waTemplateName: templateName,
      waLanguageCode: languageCode,
      waFromNumber: fromNumber,
      waFallbackImage: fallbackImage,
    };
    await prisma.backInStockSettings.upsert({
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

export default function BackInStockPage() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<{
    success?: boolean;
    error?: string;
    testResult?: string;
    testError?: string;
  }>();
  const submit = useSubmit();

  const initial = {
    enabled: d.isEnabled,
    placement: d.placement,
    buttonText: d.buttonText,
    headingText: d.headingText,
    consentText: d.consentText,
    successText: d.successText,
    waEnabled: d.waEnabled,
    waProvider: d.waProvider,
    waApiKey: "",
    waTemplateName: d.waTemplateName,
    waLanguageCode: d.waLanguageCode,
    waFromNumber: d.waFromNumber,
    waFallbackImage: d.waFallbackImage,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [placement, setPlacement] = useState(initial.placement);
  const [buttonText, setButtonText] = useState(initial.buttonText);
  const [headingText, setHeadingText] = useState(initial.headingText);
  const [consentText, setConsentText] = useState(initial.consentText);
  const [successText, setSuccessText] = useState(initial.successText);
  const [waEnabled, setWaEnabled] = useState(initial.waEnabled);
  const [waProvider, setWaProvider] = useState(initial.waProvider);
  const [waApiKey, setWaApiKey] = useState(initial.waApiKey);
  const [waTemplateName, setWaTemplateName] = useState(initial.waTemplateName);
  const [waLanguageCode, setWaLanguageCode] = useState(initial.waLanguageCode);
  const [waFromNumber, setWaFromNumber] = useState(initial.waFromNumber);
  const [waFallbackImage, setWaFallbackImage] = useState(initial.waFallbackImage);
  const [testPhone, setTestPhone] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    placement !== initial.placement ||
    buttonText !== initial.buttonText ||
    headingText !== initial.headingText ||
    consentText !== initial.consentText ||
    successText !== initial.successText ||
    waEnabled !== initial.waEnabled ||
    waProvider !== initial.waProvider ||
    waApiKey !== initial.waApiKey ||
    waTemplateName !== initial.waTemplateName ||
    waLanguageCode !== initial.waLanguageCode ||
    waFromNumber !== initial.waFromNumber ||
    waFallbackImage !== initial.waFallbackImage;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      setWaApiKey(""); // key is saved; don't keep it in the field
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setEnabled(initial.enabled);
    setPlacement(initial.placement);
    setButtonText(initial.buttonText);
    setHeadingText(initial.headingText);
    setConsentText(initial.consentText);
    setSuccessText(initial.successText);
    setWaEnabled(initial.waEnabled);
    setWaProvider(initial.waProvider);
    setWaApiKey(initial.waApiKey);
    setWaTemplateName(initial.waTemplateName);
    setWaLanguageCode(initial.waLanguageCode);
    setWaFromNumber(initial.waFromNumber);
    setWaFallbackImage(initial.waFallbackImage);
  };

  const handleSave = () => {
    submit(
      {
        data: JSON.stringify({
          isEnabled: enabled,
          placement,
          buttonText,
          headingText,
          consentText,
          successText,
          waEnabled,
          waProvider,
          waApiKey,
          waTemplateName,
          waLanguageCode,
          waFromNumber,
          waFallbackImage,
        }),
      },
      { method: "POST" },
    );
  };

  const handleTest = () => submit({ intent: "test", testPhone }, { method: "POST" });

  const rows = d.subscribers.map((s) => [
    s.phone ? "+91 " + s.phone : "—",
    s.email,
    s.variantId,
    s.createdAt,
    s.notified ? "Notified" : s.phone ? "Waiting" : "Waiting (no WhatsApp number)",
  ]);

  return (
    <Page>
      <TitleBar title="Back in Stock">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            {!(d.waEnabled && d.hasWaKey && d.waTemplateName) && (
              <Banner tone="warning" title="Set up WhatsApp to send the notifications">
                <Text as="p">
                  Signups are being collected, but nobody is notified until you connect
                  Interakt below. Shoppers are messaged on the WhatsApp number they enter
                  themselves — no Shopify customer data is used to reach them.
                </Text>
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Back in Stock</Text>
                  <InlineStack gap="200">
                    <Badge tone="attention">{`${d.waitingCount} waiting`}</Badge>
                    <Badge tone="success">{`${d.notifiedCount} notified`}</Badge>
                  </InlineStack>
                </InlineStack>
                <Text as="p" tone="subdued">
                  Shows a "notify me" form on sold-out variants and sends the shopper a
                  WhatsApp message when stock returns.
                </Text>
                <Checkbox
                  label="Enable back in stock"
                  helpText="When disabled, the form disappears from your storefront"
                  checked={enabled}
                  onChange={setEnabled}
                />
                <Select
                  label="Placement on the product page"
                  options={[
                    { label: "Below the Add to Cart button", value: "below-atc" },
                    { label: "Above the Add to Cart button", value: "above-atc" },
                    { label: "Replace the sold-out button", value: "replace-button" },
                  ]}
                  value={placement}
                  onChange={setPlacement}
                  helpText="Only shown while the selected variant is sold out."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Wording</Text>
                <TextField
                  label="Button text"
                  value={buttonText}
                  onChange={setButtonText}
                  autoComplete="off"
                />
                <TextField
                  label="Form heading"
                  value={headingText}
                  onChange={setHeadingText}
                  autoComplete="off"
                />
                <TextField
                  label="Consent notice"
                  value={consentText}
                  onChange={setConsentText}
                  autoComplete="off"
                  multiline={2}
                  helpText="Shown under the form. Tell shoppers you'll message them on WhatsApp — keep this honest and clear."
                />
                <TextField
                  label="Success message"
                  value={successText}
                  onChange={setSuccessText}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">WhatsApp delivery</Text>
                <Text as="p" tone="subdued">
                  Restock alerts are sent on WhatsApp using your own provider account, to
                  the number the shopper types into the form.
                </Text>
                <Checkbox
                  label="Send restock alerts on WhatsApp"
                  helpText="When off, signups are collected but nobody is notified"
                  checked={waEnabled}
                  onChange={setWaEnabled}
                />
                <Select
                  label="Provider"
                  options={[
                    { label: "Interakt", value: "interakt" },
                    { label: "DoubleTick", value: "doubletick" },
                  ]}
                  value={waProvider}
                  onChange={setWaProvider}
                />
                <TextField
                  label="API key"
                  value={waApiKey}
                  onChange={setWaApiKey}
                  autoComplete="off"
                  placeholder={
                    d.hasWaKey
                      ? `Saved key ending in ${d.waKeyPreview} — enter a new key to replace it`
                      : "Paste your API key"
                  }
                  helpText={
                    waProvider === "doubletick"
                      ? "DoubleTick → Settings → API key. Stored securely — never sent to your storefront."
                      : "Interakt → Settings → Developer Settings → Secret Key (base64). Stored securely — never sent to your storefront."
                  }
                />
                <TextField
                  label="Template name"
                  value={waTemplateName}
                  onChange={setWaTemplateName}
                  autoComplete="off"
                  placeholder="back_in_stock"
                  helpText={`An approved template with an IMAGE header, three body variables ({{1}} product, {{2}} variant, {{3}} product link) and a dynamic URL button whose base URL is https://${d.shop}/products/`}
                />
                <TextField
                  label="Fallback image URL"
                  value={waFallbackImage}
                  onChange={setWaFallbackImage}
                  autoComplete="off"
                  placeholder="https://cdn.shopify.com/…/logo.jpg"
                  helpText="Used as the message image when a product has no featured image. Must start with https:// — WhatsApp rejects a template whose image header is empty."
                />
                <InlineStack gap="300" wrap={false}>
                  <div style={{ flexGrow: 1 }}>
                    <TextField
                      label="Template language"
                      value={waLanguageCode}
                      onChange={setWaLanguageCode}
                      autoComplete="off"
                      placeholder="en"
                    />
                  </div>
                  {waProvider === "doubletick" && (
                    <div style={{ flexGrow: 1 }}>
                      <TextField
                        label="Sender number"
                        value={waFromNumber}
                        onChange={setWaFromNumber}
                        autoComplete="off"
                        placeholder="+919876543210"
                        helpText="Your DoubleTick WhatsApp business number."
                      />
                    </div>
                  )}
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Send a test message</Text>
                <Text as="p" tone="subdued">
                  Uses your saved settings to send the template right now with sample
                  values. Save first.
                </Text>
                {actionData?.testResult && (
                  <Banner tone="success">{actionData.testResult}</Banner>
                )}
                {actionData?.testError && <Banner tone="warning">{actionData.testError}</Banner>}
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flexGrow: 1 }}>
                    <TextField
                      label="Your WhatsApp number"
                      labelHidden
                      value={testPhone}
                      onChange={(v) => setTestPhone(v.replace(/\D/g, "").slice(0, 12))}
                      autoComplete="off"
                      inputMode="numeric"
                      placeholder="10-digit mobile number"
                    />
                  </div>
                  <Button onClick={handleTest} disabled={testPhone.length < 10}>
                    Send test
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Recent signups</Text>
                {rows.length === 0 ? (
                  <Text as="p" tone="subdued">No signups yet.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text", "text"]}
                    headings={["WhatsApp", "Email", "Variant", "Signed up", "Status"]}
                    rows={rows}
                  />
                )}
                <Text as="p" tone="subdued">
                  "Waiting (no WhatsApp number)" means the shopper signed up before the
                  WhatsApp field existed, so they can't be messaged — reach out by email.
                </Text>
              </BlockStack>
            </Card>

            <Banner tone="info" title="Optional: also send an email">
              <Text as="p">
                BadgeHQ still fires a Shopify Flow trigger ("BadgeHQ back in stock") on
                every restock, so if you build a marketing automation with a "Send
                marketing email" action it will send alongside WhatsApp. This only reaches
                email-marketing subscribers and is entirely optional — WhatsApp works on
                its own.
              </Text>
            </Banner>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
