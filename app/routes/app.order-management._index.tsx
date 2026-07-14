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
  ChoiceList,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.orderManageSettings.findUnique({
    where: { shop: session.shop },
  });
  return json({
    isEnabled: settings?.isEnabled ?? false,
    allowCancel: settings?.allowCancel ?? true,
    cancelScope: settings?.cancelScope ?? "unpaid",
    allowAddressEdit: settings?.allowAddressEdit ?? true,
    showOnPages: parsePages(settings?.showOnPages),
  });
};

const VALID_PAGES = ["account", "account-new", "thank-you"];

function parsePages(raw: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(raw ?? '["account"]');
    if (Array.isArray(arr)) {
      const clean = arr.filter((p) => VALID_PAGES.includes(p));
      if (clean.length) return clean;
    }
  } catch {
    // fall through to default
  }
  return ["account"];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  const cancelScope = data.cancelScope === "all" ? "all" : "unpaid";
  // Whitelist the requested pages; always keep at least one so the widget has
  // somewhere to show.
  const pages = Array.isArray(data.showOnPages)
    ? data.showOnPages.filter((p: unknown) => VALID_PAGES.includes(p as string))
    : [];
  const showOnPages = JSON.stringify(pages.length ? pages : ["account"]);

  try {
    await prisma.orderManageSettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        isEnabled: data.isEnabled,
        allowCancel: data.allowCancel,
        cancelScope,
        allowAddressEdit: data.allowAddressEdit,
        showOnPages,
      },
      update: {
        isEnabled: data.isEnabled,
        allowCancel: data.allowCancel,
        cancelScope,
        allowAddressEdit: data.allowAddressEdit,
        showOnPages,
      },
    });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

export default function OrderManagement() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const initial = {
    enabled: loaderData.isEnabled,
    allowCancel: loaderData.allowCancel,
    cancelScope: loaderData.cancelScope,
    allowAddressEdit: loaderData.allowAddressEdit,
    showOnPages: loaderData.showOnPages,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [allowCancel, setAllowCancel] = useState(initial.allowCancel);
  const [cancelScope, setCancelScope] = useState(initial.cancelScope);
  const [allowAddressEdit, setAllowAddressEdit] = useState(initial.allowAddressEdit);
  const [showOnPages, setShowOnPages] = useState<string[]>(initial.showOnPages);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    allowCancel !== initial.allowCancel ||
    cancelScope !== initial.cancelScope ||
    allowAddressEdit !== initial.allowAddressEdit ||
    JSON.stringify(showOnPages) !== JSON.stringify(initial.showOnPages);

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setEnabled(initial.enabled);
    setAllowCancel(initial.allowCancel);
    setCancelScope(initial.cancelScope);
    setAllowAddressEdit(initial.allowAddressEdit);
    setShowOnPages(initial.showOnPages);
  };

  const handleSave = () => {
    submit(
      {
        data: JSON.stringify({
          isEnabled: enabled,
          allowCancel,
          cancelScope,
          allowAddressEdit,
          showOnPages,
        }),
      },
      { method: "POST" },
    );
  };

  return (
    <Page>
      <TitleBar title="Order Management">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Banner tone="info">
              Adds "Cancel order" and "Edit shipping address" to the customer's order page
              in their account, available only while the order is unfulfilled. Requires the
              app to have orders permission — if you recently installed this feature, open
              the app once and approve the new permissions when prompted.
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Customer Self-Service</Text>
                <Text as="p" tone="subdued">
                  Cuts support tickets by letting customers fix mistakes themselves in the
                  window before you fulfill the order.
                </Text>
                <Checkbox
                  label="Enable order management"
                  helpText="When disabled, no buttons appear on customer order pages"
                  checked={enabled}
                  onChange={setEnabled}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Where to show</Text>
                <ChoiceList
                  allowMultiple
                  title="Show the order buttons on"
                  choices={[
                    {
                      label: "Customer account order page (classic)",
                      value: "account",
                      helpText: "The order page under your storefront's customer accounts. Works today.",
                    },
                    {
                      label: "New customer account order page",
                      value: "account-new",
                      helpText: "Shopify's new customer accounts order page. Requires the app extension (coming soon).",
                    },
                    {
                      label: "Thank-you page (after checkout)",
                      value: "thank-you",
                      helpText: "Shown right after purchase, including guest checkouts. Requires the app extension (coming soon).",
                    },
                  ]}
                  selected={showOnPages}
                  onChange={setShowOnPages}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Order Cancellation</Text>
                <Checkbox
                  label="Allow customers to cancel unfulfilled orders"
                  checked={allowCancel}
                  onChange={setAllowCancel}
                />
                <Select
                  label="Which orders can be cancelled"
                  disabled={!allowCancel}
                  options={[
                    { label: "Unpaid / COD orders only", value: "unpaid" },
                    { label: "All orders (prepaid orders are auto-refunded)", value: "all" },
                  ]}
                  value={cancelScope}
                  onChange={setCancelScope}
                  helpText={
                    cancelScope === "all"
                      ? "Careful: prepaid orders will be refunded to the original payment method automatically, without your approval."
                      : "Prepaid orders will show a 'contact us to cancel' message instead."
                  }
                />
                <Text as="p" tone="subdued">
                  Cancelled items are restocked and the customer receives Shopify's
                  cancellation email.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Address Editing</Text>
                <Checkbox
                  label="Allow customers to edit the shipping address on unfulfilled orders"
                  checked={allowAddressEdit}
                  onChange={setAllowAddressEdit}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
