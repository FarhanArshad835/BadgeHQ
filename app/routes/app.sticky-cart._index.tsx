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
  Select,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
  ChoiceList,
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
      textColor: data.textColor,
      buttonStyle: data.buttonStyle,
      buttonRadius: data.buttonRadius,
      showPrice: data.showPrice,
      showQuantity: data.showQuantity,
      alwaysShow: data.alwaysShow,
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

  const initial = {
    buttonText: cart?.buttonText || "Add to Cart",
    buttonColor: cart?.buttonColor || "#ffffff",
    bgColor: cart?.bgColor || "#000000",
    textColor: cart?.textColor || "#ffffff",
    buttonStyle: cart?.buttonStyle || "solid",
    buttonRadius: cart?.buttonRadius || "6",
    showPrice: cart?.showPrice ?? true,
    showQuantity: cart?.showQuantity ?? true,
    alwaysShow: cart?.alwaysShow ?? false,
    showMobile: cart?.showMobile ?? true,
    showDesktop: cart?.showDesktop ?? true,
    position: cart?.position || "bottom",
    isActive: cart?.isActive ?? true,
  };

  const [buttonText, setButtonText] = useState(initial.buttonText);
  const [buttonColor, setButtonColor] = useState(initial.buttonColor);
  const [bgColor, setBgColor] = useState(initial.bgColor);
  const [textColor, setTextColor] = useState(initial.textColor);
  const [buttonStyle, setButtonStyle] = useState(initial.buttonStyle);
  const [buttonRadius, setButtonRadius] = useState(initial.buttonRadius);
  const [showPrice, setShowPrice] = useState(initial.showPrice);
  const [showQuantity, setShowQuantity] = useState(initial.showQuantity);
  const [alwaysShow, setAlwaysShow] = useState(initial.alwaysShow);
  const [showMobile, setShowMobile] = useState(initial.showMobile);
  const [showDesktop, setShowDesktop] = useState(initial.showDesktop);
  const [position, setPosition] = useState(initial.position);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [previewQty, setPreviewQty] = useState(1);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setButtonText(initial.buttonText);
    setButtonColor(initial.buttonColor);
    setBgColor(initial.bgColor);
    setTextColor(initial.textColor);
    setButtonStyle(initial.buttonStyle);
    setButtonRadius(initial.buttonRadius);
    setShowPrice(initial.showPrice);
    setShowQuantity(initial.showQuantity);
    setAlwaysShow(initial.alwaysShow);
    setShowMobile(initial.showMobile);
    setShowDesktop(initial.showDesktop);
    setPosition(initial.position);
    setIsActive(initial.isActive);
  };

  const handleSave = () => {
    const data = {
      buttonText, buttonColor, bgColor, textColor,
      buttonStyle, buttonRadius, showPrice, showQuantity, alwaysShow,
      showMobile, showDesktop, position, isActive,
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const radiusPx = parseInt(buttonRadius) || 6;
  const isOutline = buttonStyle === "outline";

  return (
    <Page>
      <TitleBar title="Sticky Add to Cart">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Sticky cart settings saved successfully.</Banner>}
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
                  helpText="Text shown on the add to cart button"
                />
                <Checkbox label="Show product price" checked={showPrice} onChange={setShowPrice} />
                <Checkbox label="Show quantity selector" checked={showQuantity} onChange={setShowQuantity}
                  helpText="Native-style +/- quantity picker next to the button" />
                <Checkbox label="Always visible" checked={alwaysShow} onChange={setAlwaysShow}
                  helpText="Keep the bar on screen at all times, not just when the Add to Cart button scrolls out of view" />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Colors</Text>
                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Bar Background"
                    value={bgColor}
                    onChange={setBgColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: bgColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                    helpText="Background of the sticky bar"
                  />
                  <TextField
                    label="Title & Price Color"
                    value={textColor}
                    onChange={setTextColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: textColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                    helpText="Product name and price text"
                  />
                </InlineGrid>
                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Button Color"
                    value={buttonColor}
                    onChange={setButtonColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: buttonColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                    helpText={isOutline ? "Border & text color" : "Button background color"}
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Button Style</Text>
                <ChoiceList
                  title="Style"
                  choices={[
                    { label: "Solid", value: "solid" },
                    { label: "Outline", value: "outline" },
                  ]}
                  selected={[buttonStyle]}
                  onChange={(val) => setButtonStyle(val[0])}
                />
                <Select
                  label="Corner Radius"
                  options={[
                    { label: "Square (0px)", value: "0" },
                    { label: "Slight (4px)", value: "4" },
                    { label: "Rounded (8px)", value: "8" },
                    { label: "Large (16px)", value: "16" },
                    { label: "Pill (50px)", value: "50" },
                  ]}
                  value={buttonRadius}
                  onChange={setButtonRadius}
                />
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
                    gap: 8,
                    boxShadow: position === "top" ? "0 2px 8px rgba(0,0,0,0.15)" : "0 -2px 8px rgba(0,0,0,0.15)",
                  }}>
                    {/* Left: title + price */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: textColor, fontSize: 11, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>Product Name</div>
                      {showPrice && <div style={{ color: textColor, fontSize: 10, opacity: 0.75 }}>₹599.00</div>}
                    </div>

                    {/* Quantity selector */}
                    {showQuantity && (
                      <div style={{ display: "flex", alignItems: "center", border: `1px solid ${textColor}`, borderRadius: radiusPx, overflow: "hidden", flexShrink: 0 }}>
                        <button onClick={() => setPreviewQty(q => Math.max(1, q - 1))} style={{ background: "transparent", border: "none", color: textColor, padding: "6px 8px", cursor: "pointer", fontSize: 14, fontWeight: 700 }}>−</button>
                        <span style={{ color: textColor, fontSize: 12, fontWeight: 600, minWidth: 20, textAlign: "center" }}>{previewQty}</span>
                        <button onClick={() => setPreviewQty(q => q + 1)} style={{ background: "transparent", border: "none", color: textColor, padding: "6px 8px", cursor: "pointer", fontSize: 14, fontWeight: 700 }}>+</button>
                      </div>
                    )}

                    {/* ATC button */}
                    <div style={{
                      backgroundColor: isOutline ? "transparent" : buttonColor,
                      color: isOutline ? buttonColor : bgColor,
                      border: isOutline ? `2px solid ${buttonColor}` : "none",
                      padding: "7px 12px",
                      borderRadius: radiusPx,
                      fontSize: 11,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                      flexShrink: 0,
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
