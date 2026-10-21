import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Select,
  Checkbox,
  Banner,
  Box,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const appSettings = await prisma.appSettings.findUnique({
    where: { shop: session.shop },
  });
  const settings = appSettings
    ? (JSON.parse(appSettings.settings) as Record<string, string>)
    : { fontFamily: "inherit", colorScheme: "light" };
  return json({
    isEnabled: appSettings?.isEnabled ?? true,
    settings,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    await prisma.appSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        isEnabled: data.isEnabled,
        settings: JSON.stringify(data.settings),
      },
      update: {
        isEnabled: data.isEnabled,
        settings: JSON.stringify(data.settings),
      },
    });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

export default function GlobalSettings() {
  const { isEnabled, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();
  // Without this the page looks frozen on a slow connection: the button
  // stays live and nothing acknowledges the click until the loader returns.
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const initial = {
    enabled: isEnabled,
    fontFamily: settings.fontFamily || "inherit",
    colorScheme: settings.colorScheme || "light",
    hideCompare: !!(settings as any).priceDisplay?.hideCompare,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [fontFamily, setFontFamily] = useState(initial.fontFamily);
  const [colorScheme, setColorScheme] = useState(initial.colorScheme);
  const [hideCompare, setHideCompare] = useState<boolean>(
    !!(initial as any).hideCompare,
  );
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    fontFamily !== initial.fontFamily ||
    colorScheme !== initial.colorScheme ||
    hideCompare !== (initial as any).hideCompare;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setEnabled(initial.enabled);
    setFontFamily(initial.fontFamily);
    setColorScheme(initial.colorScheme);
    setHideCompare(!!(initial as any).hideCompare);
  };

  const handleSave = () => {
    const data = {
      isEnabled: enabled,
      settings: {
        fontFamily,
        colorScheme,
        // Nested so the widget can tell "not configured" from "configured
        // off" without the two looking the same.
        priceDisplay: { enabled: hideCompare, hideCompare },
      },
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Global Settings">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty || busy} loading={busy ? "" : undefined}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">App Control</Text>
                <Checkbox
                  label="Enable BadgeHQ"
                  helpText="When disabled, no widgets will render on your storefront"
                  checked={enabled}
                  onChange={setEnabled}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Product Card Prices</Text>
                <Checkbox
                  label="Hide the struck-through MRP on product cards"
                  helpText="Shows only your selling price. The MRP still appears on the product page and nothing about what a customer is charged changes."
                  checked={hideCompare}
                  onChange={setHideCompare}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Default Styling</Text>
                <Select
                  label="Default Font Family"
                  options={[
                    { label: "Inherit from theme", value: "inherit" },
                    { label: "Arial", value: "Arial, sans-serif" },
                    { label: "Helvetica", value: "Helvetica, sans-serif" },
                    { label: "Georgia", value: "Georgia, serif" },
                    { label: "Times New Roman", value: "'Times New Roman', serif" },
                    { label: "Courier New", value: "'Courier New', monospace" },
                    { label: "Verdana", value: "Verdana, sans-serif" },
                  ]}
                  value={fontFamily}
                  onChange={setFontFamily}
                />
                <Select
                  label="Default Color Scheme"
                  options={[
                    { label: "Light", value: "light" },
                    { label: "Dark", value: "dark" },
                    { label: "Auto (match theme)", value: "auto" },
                  ]}
                  value={colorScheme}
                  onChange={setColorScheme}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* The embedded frame clips at the last element, so without this the
            final control sits flush against the bottom edge. Wrapped in a
            Section because Layout only accepts Layout.Section children. */}
        <Layout.Section>
          <Box paddingBlockEnd="800" />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
