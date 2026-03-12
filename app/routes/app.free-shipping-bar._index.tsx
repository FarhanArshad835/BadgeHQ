import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
  ChoiceList,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStoreCurrency } from "../utils/currency.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [bar, { currencyCode, currencySymbol }] = await Promise.all([
    prisma.freeShippingBar.findFirst({
      where: { shop: session.shop },
      orderBy: { createdAt: "desc" },
    }),
    getStoreCurrency(session.shop, session.accessToken!),
  ]);
  return json({
    currencyCode,
    currencySymbol,
    bar: bar
      ? {
          ...bar,
          messages: JSON.parse(bar.messages) as Record<string, string>,
          colors: JSON.parse(bar.colors) as Record<string, string>,
          pages: JSON.parse(bar.pages) as string[],
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    const existing = await prisma.freeShippingBar.findFirst({
      where: { shop: session.shop },
    });

    const saveData = {
      threshold: parseFloat(data.threshold),
      messages: JSON.stringify(data.messages),
      colors: JSON.stringify(data.colors),
      isActive: data.isActive,
      pages: JSON.stringify(data.pages),
    };

    if (existing) {
      await prisma.freeShippingBar.update({ where: { id: existing.id }, data: saveData });
    } else {
      await prisma.freeShippingBar.create({ data: { shop: session.shop, ...saveData } });
    }
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save free shipping bar" }, { status: 500 });
  }
};

export default function FreeShippingBarSettings() {
  const { bar, currencyCode, currencySymbol } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const [threshold, setThreshold] = useState(String(bar?.threshold || 50));
  const [belowMsg, setBelowMsg] = useState(
    bar?.messages?.below || "You're {{amount}} away from free shipping!"
  );
  const [reachedMsg, setReachedMsg] = useState(
    bar?.messages?.reached || "Congratulations! You've earned free shipping!"
  );
  const [barBg, setBarBg] = useState(bar?.colors?.barBg || "#f0f0f0");
  const [progressBg, setProgressBg] = useState(bar?.colors?.progressBg || "#4caf50");
  const [textCol, setTextCol] = useState(bar?.colors?.text || "#333333");
  const [isActive, setIsActive] = useState(bar?.isActive ?? true);
  const [pages, setPages] = useState<string[]>(bar?.pages || ["cart", "product"]);

  const handleSave = () => {
    const data = {
      threshold,
      messages: { below: belowMsg, reached: reachedMsg },
      colors: { barBg, progressBg, text: textCol },
      isActive,
      pages,
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const previewProgress = 60;

  return (
    <Page>
      <TitleBar title="Free Shipping Bar">
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.success && <Banner tone="success">Free shipping bar saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">General</Text>
                <Checkbox label="Enable free shipping bar" checked={isActive} onChange={setIsActive} />
                <TextField
                  label={`Free Shipping Threshold (${currencyCode})`}
                  type="number"
                  value={threshold}
                  onChange={setThreshold}
                  autoComplete="off"
                  prefix={currencySymbol}
                  helpText="The cart total needed for free shipping"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Messages</Text>
                <TextField
                  label="Below Threshold Message"
                  value={belowMsg}
                  onChange={setBelowMsg}
                  autoComplete="off"
                  helpText="Use {{amount}} for remaining amount"
                  multiline={2}
                />
                <TextField
                  label="Threshold Reached Message"
                  value={reachedMsg}
                  onChange={setReachedMsg}
                  autoComplete="off"
                  multiline={2}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Colors</Text>
                <InlineGrid columns={3} gap="400">
                  <TextField
                    label="Bar Background"
                    value={barBg}
                    onChange={setBarBg}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: barBg, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                  <TextField
                    label="Progress Color"
                    value={progressBg}
                    onChange={setProgressBg}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: progressBg, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                  <TextField
                    label="Text Color"
                    value={textCol}
                    onChange={setTextCol}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: textCol, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Display</Text>
                <ChoiceList
                  title="Show on pages"
                  allowMultiple
                  choices={[
                    { label: "Cart Page", value: "cart" },
                    { label: "Product Pages", value: "product" },
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
              <Box padding="400" background="bg-surface" borderWidth="025" borderRadius="200" borderColor="border">
                <div style={{ textAlign: "center" }}>
                  <p style={{ color: textCol, margin: "0 0 8px", fontSize: "14px" }}>
                    {belowMsg.replace("{{amount}}", `${currencySymbol}${(parseFloat(threshold) * (1 - previewProgress / 100)).toFixed(2)}`)}
                  </p>
                  <div style={{
                    backgroundColor: barBg,
                    borderRadius: "10px",
                    height: "20px",
                    overflow: "hidden",
                  }}>
                    <div style={{
                      backgroundColor: progressBg,
                      height: "100%",
                      width: `${previewProgress}%`,
                      borderRadius: "10px",
                      transition: "width 0.3s",
                    }} />
                  </div>
                  <p style={{ color: textCol, margin: "4px 0 0", fontSize: "12px", opacity: 0.7 }}>
                    {currencySymbol}{(parseFloat(threshold) * previewProgress / 100).toFixed(2)} / {currencySymbol}{parseFloat(threshold).toFixed(2)}
                  </p>
                </div>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
