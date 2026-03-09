import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const PRESET_BADGES = [
  "Sale %", "New", "Best Seller", "Hot", "Low Stock",
  "Trending", "Limited", "Sold Out", "Free Shipping", "Exclusive",
];

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const badge = await prisma.productBadge.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!badge) throw new Response("Not found", { status: 404 });
  return json({
    badge: {
      ...badge,
      targeting: JSON.parse(badge.targeting) as { type: string; value: string },
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    await prisma.productBadge.updateMany({
      where: { id: params.id, shop: session.shop },
      data: {
        text: data.text,
        shape: data.shape,
        badgeColor: data.badgeColor,
        textColor: data.textColor,
        position: data.position,
        targeting: JSON.stringify(data.targeting),
        isActive: data.isActive,
      },
    });
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to update product badge" }, { status: 500 });
  }
};

export default function EditProductBadge() {
  const { badge } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const [text, setText] = useState(badge.text);
  const [shape, setShape] = useState(badge.shape);
  const [badgeColor, setBadgeColor] = useState(badge.badgeColor);
  const [textColor, setTextColor] = useState(badge.textColor);
  const [position, setPosition] = useState(badge.position);
  const [targetType, setTargetType] = useState(badge.targeting.type);
  const [targetValue, setTargetValue] = useState(badge.targeting.value || "");
  const [isActive, setIsActive] = useState(badge.isActive);

  const handleSave = () => {
    const data = {
      text, shape, badgeColor, textColor, position,
      targeting: { type: targetType, value: targetValue },
      isActive,
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const shapeStyles: Record<string, React.CSSProperties> = {
    circle: { borderRadius: "50%", width: 60, height: 60 },
    rectangle: { borderRadius: "4px", padding: "4px 10px" },
    ribbon: { borderRadius: "0 4px 4px 0", padding: "4px 12px 4px 8px" },
    star: { borderRadius: "4px", width: 60, height: 60, clipPath: "polygon(50% 0%, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)" },
    square: { borderRadius: "2px", width: 60, height: 60 },
  };

  return (
    <Page>
      <TitleBar title="Edit Product Badge">
        <button onClick={() => navigate("/app/product-badge")}>Back</button>
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.success && <Banner tone="success">Product badge saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Badge Text</Text>
                <TextField label="Text" value={text} onChange={setText} autoComplete="off" />
                <Text as="p" variant="bodyMd" tone="subdued">Quick presets:</Text>
                <InlineGrid columns={{ xs: 3, sm: 5 }} gap="200">
                  {PRESET_BADGES.map((preset) => (
                    <Button key={preset} size="slim" pressed={text === preset} onClick={() => setText(preset)}>{preset}</Button>
                  ))}
                </InlineGrid>
                <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Appearance</Text>
                <Select
                  label="Shape"
                  options={[
                    { label: "Circle", value: "circle" },
                    { label: "Rectangle", value: "rectangle" },
                    { label: "Ribbon", value: "ribbon" },
                    { label: "Star", value: "star" },
                    { label: "Square", value: "square" },
                  ]}
                  value={shape}
                  onChange={setShape}
                />
                <InlineGrid columns={2} gap="400">
                  <TextField label="Badge Color" value={badgeColor} onChange={setBadgeColor} autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: badgeColor, borderRadius: 4, border: "1px solid #ccc" }} />} />
                  <TextField label="Text Color" value={textColor} onChange={setTextColor} autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: textColor, borderRadius: 4, border: "1px solid #ccc" }} />} />
                </InlineGrid>
                <Select
                  label="Position on Image"
                  options={[
                    { label: "Top Left", value: "top-left" },
                    { label: "Top Right", value: "top-right" },
                    { label: "Bottom Left", value: "bottom-left" },
                    { label: "Bottom Right", value: "bottom-right" },
                  ]}
                  value={position}
                  onChange={setPosition}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Targeting</Text>
                <Select
                  label="Apply to"
                  options={[
                    { label: "All Products", value: "all" },
                    { label: "Specific Products", value: "products" },
                    { label: "By Collection", value: "collection" },
                    { label: "By Tag", value: "tag" },
                  ]}
                  value={targetType}
                  onChange={setTargetType}
                />
                {targetType !== "all" && (
                  <TextField
                    label={targetType === "products" ? "Product IDs (comma-separated)" : targetType === "collection" ? "Collection handle" : "Product tag"}
                    value={targetValue}
                    onChange={setTargetValue}
                    autoComplete="off"
                  />
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Preview</Text>
              <Box padding="400" background="bg-surface" borderWidth="025" borderRadius="200" borderColor="border">
                <div style={{ position: "relative", width: "100%", paddingTop: "100%", backgroundColor: "#f5f5f5", borderRadius: "8px", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Text as="p" variant="bodyMd" tone="subdued">Product Image</Text>
                  </div>
                  <div style={{
                    position: "absolute",
                    ...(position.includes("top") ? { top: 8 } : { bottom: 8 }),
                    ...(position.includes("left") ? { left: 8 } : { right: 8 }),
                    backgroundColor: badgeColor, color: textColor,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: "12px", fontWeight: 700,
                    ...shapeStyles[shape],
                  }}>
                    {text}
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
