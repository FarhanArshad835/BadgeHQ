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
  DataTable,
  List,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";

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
    isEnabled: settings?.isEnabled ?? false,
    placement: settings?.placement ?? "below-atc",
    buttonText: settings?.buttonText ?? "Notify me when available",
    headingText: settings?.headingText ?? "Get notified when this is back",
    consentText:
      settings?.consentText ??
      "We'll email you when it's back in stock. You'll also receive our emails — unsubscribe anytime.",
    successText: settings?.successText ?? "Done! We'll email you when it's back in stock.",
    waitingCount,
    notifiedCount,
    subscribers: subs.map((s) => ({
      id: s.id,
      email: s.email,
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
  const data = JSON.parse(formData.get("data") as string);

  const placement = PLACEMENTS.includes(data.placement) ? data.placement : "below-atc";
  const text = (v: unknown, fallback: string) => {
    const s = String(v ?? "").trim();
    return s ? s.slice(0, 300) : fallback;
  };

  try {
    const values = {
      isEnabled: Boolean(data.isEnabled),
      placement,
      buttonText: text(data.buttonText, "Notify me when available"),
      headingText: text(data.headingText, "Get notified when this is back"),
      consentText: text(
        data.consentText,
        "We'll email you when it's back in stock. You'll also receive our emails — unsubscribe anytime.",
      ),
      successText: text(data.successText, "Done! We'll email you when it's back in stock."),
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
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const initial = {
    enabled: d.isEnabled,
    placement: d.placement,
    buttonText: d.buttonText,
    headingText: d.headingText,
    consentText: d.consentText,
    successText: d.successText,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [placement, setPlacement] = useState(initial.placement);
  const [buttonText, setButtonText] = useState(initial.buttonText);
  const [headingText, setHeadingText] = useState(initial.headingText);
  const [consentText, setConsentText] = useState(initial.consentText);
  const [successText, setSuccessText] = useState(initial.successText);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    placement !== initial.placement ||
    buttonText !== initial.buttonText ||
    headingText !== initial.headingText ||
    consentText !== initial.consentText ||
    successText !== initial.successText;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
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
        }),
      },
      { method: "POST" },
    );
  };

  const rows = d.subscribers.map((s) => [
    s.email,
    s.variantId,
    s.createdAt,
    s.notified ? "Notified" : s.subscribed ? "Waiting" : "Waiting (not subscribed)",
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

            <Banner tone="warning" title="One-time setup required to send the emails">
              <BlockStack gap="200">
                <Text as="p">
                  Shopify has no API that lets an app email a shopper directly, so BadgeHQ
                  hands off to Shopify Email. Until you create the automation below, signups
                  are collected but nobody is emailed.
                </Text>
                <List type="number">
                  <List.Item>
                    In Shopify admin go to <strong>Automations</strong> (Marketing → Automations)
                    and create a custom automation.
                  </List.Item>
                  <List.Item>
                    Choose the trigger <strong>BadgeHQ back in stock</strong>.
                  </List.Item>
                  <List.Item>
                    Add the action <strong>Send marketing email</strong> and write your
                    "it's back" email. The trigger gives you the customer plus
                    product title, variant, image and URL to use in the template.
                  </List.Item>
                  <List.Item>Turn the automation on. That's it — it covers every product.</List.Item>
                </List>
                <Text as="p" tone="subdued">
                  Shopify Email only sends to customers subscribed to email marketing, which
                  is why the signup form subscribes shoppers and says so.
                </Text>
              </BlockStack>
            </Banner>

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
                  Shows a "notify me" form on sold-out variants and emails the shopper
                  through Shopify Email when stock returns.
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
                  helpText="Shown under the email field. Signing up subscribes the shopper to your emails — keep this honest and clear."
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
                <Text as="h2" variant="headingMd">Recent signups</Text>
                {rows.length === 0 ? (
                  <Text as="p" tone="subdued">No signups yet.</Text>
                ) : (
                  <DataTable
                    columnContentTypes={["text", "text", "text", "text"]}
                    headings={["Email", "Variant", "Signed up", "Status"]}
                    rows={rows}
                  />
                )}
                <Text as="p" tone="subdued">
                  "Waiting (not subscribed)" means Shopify wouldn't subscribe that shopper,
                  so the automation can't email them — reach out manually if needed.
                </Text>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
