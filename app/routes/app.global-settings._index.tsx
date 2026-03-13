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
  Select,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

export default function GlobalSettings() {
  const { isEnabled, settings } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const initial = {
    enabled: isEnabled,
    fontFamily: settings.fontFamily || "inherit",
    colorScheme: settings.colorScheme || "light",
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [fontFamily, setFontFamily] = useState(initial.fontFamily);
  const [colorScheme, setColorScheme] = useState(initial.colorScheme);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    fontFamily !== initial.fontFamily ||
    colorScheme !== initial.colorScheme;

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
  };

  const handleSave = () => {
    const data = {
      isEnabled: enabled,
      settings: { fontFamily, colorScheme },
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Global Settings">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
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
                  label="Enable SaleKit"
                  helpText="When disabled, no widgets will render on your storefront"
                  checked={enabled}
                  onChange={setEnabled}
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
      </Layout>
    </Page>
  );
}
