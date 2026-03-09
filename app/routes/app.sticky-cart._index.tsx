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
  Select,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const cart = await prisma.stickyCart.findFirst({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return json({ cart });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    const existing = await prisma.stickyCart.findFirst({
      where: { shop: session.shop },
    });

    const saveData = {
      buttonText: data.buttonText,
      buttonColor: data.buttonColor,
      bgColor: data.bgColor,
      showMobile: data.showMobile,
      showDesktop: data.showDesktop,
      position: data.position,
      isActive: data.isActive,
    };

    if (existing) {
      await prisma.stickyCart.update({ where: { id: existing.id }, data: saveData });
    } else {
      await prisma.stickyCart.create({ data: { shop: session.shop, ...saveData } });
    }
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save sticky cart settings" }, { status: 500 });
  }
};

export default function StickyCartSettings() {
  const { cart } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const [buttonText, setButtonText] = useState(cart?.buttonText || "Add to Cart");
  const [buttonColor, setButtonColor] = useState(cart?.buttonColor || "#ffffff");
  const [bgColor, setBgColor] = useState(cart?.bgColor || "#000000");
  const [showMobile, setShowMobile] = useState(cart?.showMobile ?? true);
  const [showDesktop, setShowDesktop] = useState(cart?.showDesktop ?? true);
  const [position, setPosition] = useState(cart?.position || "bottom");
  const [isActive, setIsActive] = useState(cart?.isActive ?? true);

  const handleSave = () => {
    const data = { buttonText, buttonColor, bgColor, showMobile, showDesktop, position, isActive };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Sticky Add to Cart">
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.success && <Banner tone="success">Sticky cart settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">General</Text>
                <Checkbox label="Enable sticky add to cart" checked={isActive} onChange={setIsActive} />
                <TextField
                  label="Button Text"
                  value={buttonText}
                  onChange={setButtonText}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Appearance</Text>
                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Button Text Color"
                    value={buttonColor}
                    onChange={setButtonColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: buttonColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                  <TextField
                    label="Background Color"
                    value={bgColor}
                    onChange={setBgColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: bgColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                </InlineGrid>
                <Select
                  label="Position"
                  options={[
                    { label: "Top of screen", value: "top" },
                    { label: "Bottom of screen", value: "bottom" },
                  ]}
                  value={position}
                  onChange={setPosition}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Visibility</Text>
                <Checkbox label="Show on mobile" checked={showMobile} onChange={setShowMobile} />
                <Checkbox label="Show on desktop" checked={showDesktop} onChange={setShowDesktop} />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Preview</Text>
              <Box padding="400" background="bg-surface" borderWidth="025" borderRadius="200" borderColor="border">
                <div style={{ position: "relative", height: 200, backgroundColor: "#f9f9f9", borderRadius: 8, overflow: "hidden" }}>
                  <div style={{ padding: 16, textAlign: "center" }}>
                    <Text as="p" variant="bodyMd" tone="subdued">Store content</Text>
                  </div>
                  <div style={{
                    position: "absolute",
                    left: 0, right: 0,
                    ...(position === "top" ? { top: 0 } : { bottom: 0 }),
                    backgroundColor: bgColor,
                    padding: "10px 16px",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                  }}>
                    <div>
                      <div style={{ color: buttonColor, fontSize: 12, fontWeight: 600 }}>Product Name</div>
                      <div style={{ color: buttonColor, fontSize: 11, opacity: 0.7 }}>$29.99</div>
                    </div>
                    <div style={{
                      backgroundColor: buttonColor,
                      color: bgColor,
                      padding: "8px 16px",
                      borderRadius: 6,
                      fontSize: 13,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}>
                      {buttonText}
                    </div>
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
