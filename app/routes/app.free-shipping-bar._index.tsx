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

  const initial = {
    threshold: String(bar?.threshold || 50),
    belowMsg: bar?.messages?.below || "You're {{amount}} away from free shipping!",
    reachedMsg: bar?.messages?.reached || "Congratulations! You've earned free shipping!",
    barBg: bar?.colors?.barBg || "#f0f0f0",
    progressBg: bar?.colors?.progressBg || "#4caf50",
    textCol: bar?.colors?.text || "#333333",
    isActive: bar?.isActive ?? true,
    pages: bar?.pages || ["cart", "product"],
  };

  const [threshold, setThreshold] = useState(initial.threshold);
  const [belowMsg, setBelowMsg] = useState(initial.belowMsg);
  const [reachedMsg, setReachedMsg] = useState(initial.reachedMsg);
  const [barBg, setBarBg] = useState(initial.barBg);
  const [progressBg, setProgressBg] = useState(initial.progressBg);
  const [textCol, setTextCol] = useState(initial.textCol);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [pages, setPages] = useState<string[]>(initial.pages);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    threshold !== initial.threshold ||
    belowMsg !== initial.belowMsg ||
    reachedMsg !== initial.reachedMsg ||
    barBg !== initial.barBg ||
    progressBg !== initial.progressBg ||
    textCol !== initial.textCol ||
    isActive !== initial.isActive ||
    JSON.stringify(pages) !== JSON.stringify(initial.pages);

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setThreshold(initial.threshold);
    setBelowMsg(initial.belowMsg);
    setReachedMsg(initial.reachedMsg);
    setBarBg(initial.barBg);
    setProgressBg(initial.progressBg);
    setTextCol(initial.textCol);
    setIsActive(initial.isActive);
    setPages(initial.pages);
  };

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
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Free shipping bar saved successfully.</Banner>}
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
