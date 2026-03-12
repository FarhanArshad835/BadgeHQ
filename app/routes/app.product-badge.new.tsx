import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { useState, useCallback } from "react";
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
  InlineStack,
  Box,
  Checkbox,
  Banner,
  RangeSlider,
  Divider,
  ChoiceList,
  Tag,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStoreCurrency } from "../utils/currency.server";

const PRESET_BADGES = [
  "Sale %", "New", "Best Seller", "Hot", "Low Stock",
  "Trending", "Limited", "Sold Out", "Free Shipping", "Exclusive",
];

const DYNAMIC_TEXT_PRESETS = [
  { label: "{{discount}}% OFF", description: "Shows discount percentage" },
  { label: "Save {{discount}}%", description: "Shows savings" },
  { label: "Only {{inventory}} left", description: "Shows stock count" },
  { label: "{{sold}} sold", description: "Shows units sold" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin } = await authenticate.admin(request);
  const { currencyCode, currencySymbol } = await getStoreCurrency(admin);
  return json({ currencyCode, currencySymbol });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    const badge = await prisma.productBadge.create({
      data: {
        shop: session.shop,
        text: data.text,
        badgeType: data.badgeType,
        shape: data.shape,
        badgeColor: data.badgeColor,
        textColor: data.textColor,
        position: data.position,
        targeting: JSON.stringify(data.targeting),
        isActive: data.isActive,
        condition: JSON.stringify(data.condition),
        pages: JSON.stringify(data.pages),
        schedule: JSON.stringify(data.schedule),
        priority: data.priority,
        imageUrl: data.imageUrl,
        fontSize: data.fontSize,
        opacity: data.opacity,
        rotation: data.rotation,
        gradient: data.gradient,
        borderColor: data.borderColor,
        borderWidth: data.borderWidth,
        customCSS: data.customCSS,
      },
    });
    return redirect(`/app/product-badge/${badge.id}`);
  } catch (error) {
    return json({ error: "Failed to create product badge" }, { status: 500 });
  }
};

export default function NewProductBadge() {
  const { currencyCode, currencySymbol } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const shopify = useAppBridge();

  // Basic fields
  const [text, setText] = useState("Sale");
  const [badgeType, setBadgeType] = useState("text");
  const [shape, setShape] = useState("rectangle");
  const [badgeColor, setBadgeColor] = useState("#e74c3c");
  const [textColor, setTextColor] = useState("#ffffff");
  const [position, setPosition] = useState("top-left");
  const [isActive, setIsActive] = useState(true);

  // Targeting
  const [targetType, setTargetType] = useState("all");
  const [targetValue, setTargetValue] = useState("");
  const [targetLabels, setTargetLabels] = useState<string[]>([]);

  // Automated conditions (ShineTrust-level)
  const [conditionType, setConditionType] = useState("none");
  const [conditionValue, setConditionValue] = useState("");
  const [conditionOperator, setConditionOperator] = useState("less_than");

  // Display pages
  const [pages, setPages] = useState<string[]>(["all"]);

  // Schedule
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleStart, setScheduleStart] = useState("");
  const [scheduleEnd, setScheduleEnd] = useState("");

  // Priority
  const [priority, setPriority] = useState(0);

  // Image badge
  const [imageUrl, setImageUrl] = useState("");

  // Advanced styling
  const [fontSize, setFontSize] = useState(11);
  const [opacity, setOpacity] = useState(1.0);
  const [rotation, setRotation] = useState(0);
  const [gradient, setGradient] = useState("");
  const [borderColor, setBorderColor] = useState("");
  const [borderWidth, setBorderWidth] = useState(0);
  const [customCSS, setCustomCSS] = useState("");

  const openProductPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({ type: "product", multiple: true, selectionIds: targetValue ? targetValue.split(",").map((id) => ({ id: "gid://shopify/Product/" + id.trim() })) : [] });
    if (selected) {
      setTargetValue(selected.map((p: any) => p.id.replace("gid://shopify/Product/", "")).join(","));
      setTargetLabels(selected.map((p: any) => p.title));
    }
  }, [shopify, targetValue]);

  const openCollectionPicker = useCallback(async () => {
    const selected = await shopify.resourcePicker({ type: "collection", multiple: false });
    if (selected && selected[0]) {
      const col = selected[0] as any;
      setTargetValue(col.handle || col.id.replace("gid://shopify/Collection/", ""));
      setTargetLabels([col.title]);
    }
  }, [shopify]);

  const handleSave = () => {
    const data = {
      text,
      badgeType,
      shape,
      badgeColor,
      textColor,
      position,
      targeting: { type: targetType, value: targetValue, labels: targetLabels },
      isActive,
      condition: {
        type: conditionType,
        value: conditionValue,
        operator: conditionOperator,
      },
      pages,
      schedule: scheduleEnabled
        ? { startDate: scheduleStart, endDate: scheduleEnd }
        : {},
      priority,
      imageUrl,
      fontSize,
      opacity,
      rotation,
      gradient,
      borderColor,
      borderWidth,
      customCSS,
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

  const previewBg = gradient || badgeColor;
  const previewStyle: React.CSSProperties = {
    position: "absolute",
    ...(position.includes("top") ? { top: 8 } : { bottom: 8 }),
    ...(position.includes("left") ? { left: 8 } : { right: 8 }),
    background: previewBg,
    color: textColor,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: `${fontSize}px`,
    fontWeight: 700,
    opacity,
    transform: rotation ? `rotate(${rotation}deg)` : undefined,
    border: borderWidth ? `${borderWidth}px solid ${borderColor || "#000"}` : undefined,
    ...shapeStyles[shape],
  };

  return (
    <Page>
      <TitleBar title="Create Product Badge">
        <button onClick={() => navigate("/app/product-badge")}>Back</button>
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            {/* Badge Type */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Badge Type</Text>
                <Select
                  label="Type"
                  options={[
                    { label: "Text Badge", value: "text" },
                    { label: "Image Badge", value: "image" },
                    { label: "Dynamic Badge (auto-generated)", value: "dynamic" },
                  ]}
                  value={badgeType}
                  onChange={setBadgeType}
                />

                {badgeType === "text" && (
                  <>
                    <TextField label="Badge Text" value={text} onChange={setText} autoComplete="off" />
                    <Text as="p" variant="bodyMd" tone="subdued">Quick presets:</Text>
                    <InlineGrid columns={{ xs: 3, sm: 5 }} gap="200">
                      {PRESET_BADGES.map((preset) => (
                        <Button key={preset} size="slim" pressed={text === preset} onClick={() => setText(preset)}>
                          {preset}
                        </Button>
                      ))}
                    </InlineGrid>
                  </>
                )}

                {badgeType === "image" && (
                  <TextField
                    label="Badge Image URL"
                    value={imageUrl}
                    onChange={setImageUrl}
                    autoComplete="off"
                    helpText="URL to a badge image (PNG, SVG, or GIF). Recommended size: 200x80px."
                    placeholder="https://example.com/badge.png"
                  />
                )}

                {badgeType === "dynamic" && (
                  <>
                    <TextField
                      label="Dynamic Text Template"
                      value={text}
                      onChange={setText}
                      autoComplete="off"
                      helpText="Use {{discount}}, {{inventory}}, {{sold}}, {{price}}, {{compare_price}} as placeholders."
                    />
                    <Text as="p" variant="bodyMd" tone="subdued">Template presets:</Text>
                    <InlineGrid columns={{ xs: 2, sm: 2 }} gap="200">
                      {DYNAMIC_TEXT_PRESETS.map((preset) => (
                        <Button key={preset.label} size="slim" pressed={text === preset.label} onClick={() => setText(preset.label)}>
                          {preset.label}
                        </Button>
                      ))}
                    </InlineGrid>
                  </>
                )}

                <Checkbox label="Active" checked={isActive} onChange={setIsActive} />
              </BlockStack>
            </Card>

            {/* Automated Conditions */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Automated Conditions</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Automatically show this badge when products match certain criteria. Leave as "None" for manual badges.
                </Text>
                <Select
                  label="Condition"
                  options={[
                    { label: "None (always show)", value: "none" },
                    { label: "On Sale (has compare-at price)", value: "on_sale" },
                    { label: "New Arrival (by date)", value: "new_arrival" },
                    { label: "Low Stock", value: "low_stock" },
                    { label: "Out of Stock", value: "out_of_stock" },
                    { label: "Discount Percentage", value: "discount_percent" },
                    { label: "Price Range", value: "price_range" },
                    { label: "Inventory Count", value: "inventory_count" },
                  ]}
                  value={conditionType}
                  onChange={setConditionType}
                />

                {conditionType === "new_arrival" && (
                  <TextField
                    label="Days since published"
                    type="number"
                    value={conditionValue}
                    onChange={setConditionValue}
                    autoComplete="off"
                    helpText="Show badge on products published within this many days (e.g., 30)"
                  />
                )}

                {conditionType === "low_stock" && (
                  <TextField
                    label="Stock threshold"
                    type="number"
                    value={conditionValue}
                    onChange={setConditionValue}
                    autoComplete="off"
                    helpText="Show badge when inventory is at or below this number (e.g., 10)"
                  />
                )}

                {conditionType === "discount_percent" && (
                  <InlineGrid columns={2} gap="400">
                    <Select
                      label="Operator"
                      options={[
                        { label: "Greater than", value: "greater_than" },
                        { label: "Less than", value: "less_than" },
                        { label: "Equal to", value: "equal_to" },
                        { label: "Between", value: "between" },
                      ]}
                      value={conditionOperator}
                      onChange={setConditionOperator}
                    />
                    <TextField
                      label="Discount %"
                      type="number"
                      value={conditionValue}
                      onChange={setConditionValue}
                      autoComplete="off"
                      helpText={conditionOperator === "between" ? "e.g., 10-50 for 10% to 50%" : "e.g., 20 for 20%"}
                    />
                  </InlineGrid>
                )}

                {conditionType === "price_range" && (
                  <TextField
                    label="Price range"
                    value={conditionValue}
                    onChange={setConditionValue}
                    autoComplete="off"
                    helpText={`Enter min-max (e.g., 0-25 for products under ${currencySymbol}25, or 100-999 for premium)`}
                  />
                )}

                {conditionType === "inventory_count" && (
                  <InlineGrid columns={2} gap="400">
                    <Select
                      label="Operator"
                      options={[
                        { label: "Less than", value: "less_than" },
                        { label: "Greater than", value: "greater_than" },
                        { label: "Equal to", value: "equal_to" },
                      ]}
                      value={conditionOperator}
                      onChange={setConditionOperator}
                    />
                    <TextField
                      label="Inventory count"
                      type="number"
                      value={conditionValue}
                      onChange={setConditionValue}
                      autoComplete="off"
                    />
                  </InlineGrid>
                )}
              </BlockStack>
            </Card>

            {/* Appearance */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Appearance</Text>

                {badgeType !== "image" && (
                  <Select
                    label="Shape"
                    options={[
                      { label: "Rectangle", value: "rectangle" },
                      { label: "Circle", value: "circle" },
                      { label: "Ribbon", value: "ribbon" },
                      { label: "Star", value: "star" },
                      { label: "Square", value: "square" },
                    ]}
                    value={shape}
                    onChange={setShape}
                  />
                )}

                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Badge Color"
                    value={badgeColor}
                    onChange={setBadgeColor}
                    autoComplete="off"
                    prefix={<input type="color" value={badgeColor} onChange={(e) => setBadgeColor(e.target.value)} style={{ width: 24, height: 24, padding: 0, border: "none", cursor: "pointer", borderRadius: 4 }} />}
                  />
                  {badgeType !== "image" && (
                    <TextField
                      label="Text Color"
                      value={textColor}
                      onChange={setTextColor}
                      autoComplete="off"
                      prefix={<input type="color" value={textColor} onChange={(e) => setTextColor(e.target.value)} style={{ width: 24, height: 24, padding: 0, border: "none", cursor: "pointer", borderRadius: 4 }} />}
                    />
                  )}
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

                <TextField
                  label="Gradient Background"
                  value={gradient}
                  onChange={setGradient}
                  autoComplete="off"
                  placeholder="linear-gradient(135deg, #ff6b6b, #ee5a24)"
                  helpText="CSS gradient. Overrides badge color when set."
                />

                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Font Size (px)"
                    type="number"
                    value={String(fontSize)}
                    onChange={(v) => setFontSize(Number(v) || 11)}
                    autoComplete="off"
                  />
                  <TextField
                    label="Priority"
                    type="number"
                    value={String(priority)}
                    onChange={(v) => setPriority(Number(v) || 0)}
                    autoComplete="off"
                    helpText="Higher = shown first. Badges with same priority all display."
                  />
                </InlineGrid>

                <RangeSlider
                  label={`Opacity: ${opacity}`}
                  value={opacity * 100}
                  onChange={useCallback((val: number) => setOpacity(Math.round(val) / 100), [])}
                  min={10}
                  max={100}
                  output
                />

                <RangeSlider
                  label={`Rotation: ${rotation}°`}
                  value={rotation}
                  onChange={useCallback((val: number) => setRotation(val), [])}
                  min={-45}
                  max={45}
                  output
                />

                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Border Color"
                    value={borderColor}
                    onChange={setBorderColor}
                    autoComplete="off"
                    placeholder="#000000"
                    prefix={<input type="color" value={borderColor || "#000000"} onChange={(e) => setBorderColor(e.target.value)} style={{ width: 24, height: 24, padding: 0, border: "none", cursor: "pointer", borderRadius: 4 }} />}
                  />
                  <TextField
                    label="Border Width (px)"
                    type="number"
                    value={String(borderWidth)}
                    onChange={(v) => setBorderWidth(Number(v) || 0)}
                    autoComplete="off"
                  />
                </InlineGrid>
              </BlockStack>
            </Card>

            {/* Targeting */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Product Targeting</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Choose which products this badge appears on.
                </Text>

                <Select
                  label="Apply to"
                  options={[
                    { label: "All Products", value: "all" },
                    { label: "Specific Products", value: "products" },
                    { label: "By Collection", value: "collection" },
                    { label: "By Tag", value: "tag" },
                    { label: "By Product Type", value: "product_type" },
                    { label: "By Vendor", value: "vendor" },
                  ]}
                  value={targetType}
                  onChange={(val) => { setTargetType(val); setTargetValue(""); setTargetLabels([]); }}
                />

                {targetType === "products" && (
                  <BlockStack gap="200">
                    <Button onClick={openProductPicker}>Browse products</Button>
                    {targetLabels.length > 0 ? (
                      <InlineStack gap="200" wrap>
                        {targetLabels.map((label, i) => (
                          <Tag key={i} onRemove={() => {
                            const newLabels = targetLabels.filter((_, j) => j !== i);
                            const ids = targetValue.split(",").filter((_, j) => j !== i);
                            setTargetLabels(newLabels);
                            setTargetValue(ids.join(","));
                          }}>{label}</Tag>
                        ))}
                      </InlineStack>
                    ) : (
                      <Text as="p" variant="bodySm" tone="subdued">No products selected. Click "Browse products" to pick from your store.</Text>
                    )}
                  </BlockStack>
                )}

                {targetType === "collection" && (
                  <BlockStack gap="200">
                    <Button onClick={openCollectionPicker}>Browse collections</Button>
                    {targetLabels.length > 0 ? (
                      <InlineStack gap="200">
                        {targetLabels.map((label, i) => (
                          <Tag key={i} onRemove={() => { setTargetLabels([]); setTargetValue(""); }}>{label}</Tag>
                        ))}
                      </InlineStack>
                    ) : (
                      <Text as="p" variant="bodySm" tone="subdued">No collection selected. Click "Browse collections" to pick one.</Text>
                    )}
                  </BlockStack>
                )}

                {(targetType === "tag" || targetType === "product_type" || targetType === "vendor") && (
                  <TextField
                    label={
                      targetType === "tag" ? "Product tag"
                        : targetType === "product_type" ? "Product type"
                        : "Vendor name"
                    }
                    value={targetValue}
                    onChange={setTargetValue}
                    autoComplete="off"
                    helpText={
                      targetType === "tag" ? "Exact tag to match (e.g., 'sale', 'new-arrival')"
                        : targetType === "product_type" ? "Product type to match (e.g., 'T-Shirts', 'Shoes')"
                        : "Vendor name to match (e.g., 'Nike', 'Apple')"
                    }
                  />
                )}
              </BlockStack>
            </Card>

            {/* Display Pages */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Display Pages</Text>
                <ChoiceList
                  title="Show badge on"
                  allowMultiple
                  choices={[
                    { label: "All Pages", value: "all" },
                    { label: "Home Page", value: "home" },
                    { label: "Collection Pages", value: "collection" },
                    { label: "Product Pages", value: "product" },
                    { label: "Search Results", value: "search" },
                    { label: "Cart Page", value: "cart" },
                  ]}
                  selected={pages}
                  onChange={setPages}
                />
              </BlockStack>
            </Card>

            {/* Schedule */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Schedule</Text>
                <Checkbox
                  label="Enable scheduling"
                  checked={scheduleEnabled}
                  onChange={setScheduleEnabled}
                  helpText="Only show this badge during a specific time period"
                />
                {scheduleEnabled && (
                  <InlineGrid columns={2} gap="400">
                    <TextField
                      label="Start Date"
                      type="date"
                      value={scheduleStart}
                      onChange={setScheduleStart}
                      autoComplete="off"
                    />
                    <TextField
                      label="End Date"
                      type="date"
                      value={scheduleEnd}
                      onChange={setScheduleEnd}
                      autoComplete="off"
                    />
                  </InlineGrid>
                )}
              </BlockStack>
            </Card>

            {/* Advanced / Custom CSS */}
            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Custom CSS</Text>
                <TextField
                  label="Custom CSS"
                  value={customCSS}
                  onChange={setCustomCSS}
                  autoComplete="off"
                  multiline={3}
                  placeholder="box-shadow: 0 2px 4px rgba(0,0,0,0.2); text-transform: uppercase;"
                  helpText="Additional CSS properties applied to the badge element."
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        {/* Preview */}
        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Preview</Text>
              <Box padding="400" background="bg-surface" borderWidth="025" borderRadius="200" borderColor="border">
                <div style={{ position: "relative", width: "100%", paddingTop: "100%", backgroundColor: "#f5f5f5", borderRadius: "8px", overflow: "hidden" }}>
                  <div style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                    <Text as="p" variant="bodyMd" tone="subdued">Product Image</Text>
                  </div>
                  {badgeType === "image" && imageUrl ? (
                    <img
                      src={imageUrl}
                      alt="Badge"
                      style={{
                        position: "absolute",
                        ...(position.includes("top") ? { top: 8 } : { bottom: 8 }),
                        ...(position.includes("left") ? { left: 8 } : { right: 8 }),
                        maxWidth: 80,
                        height: "auto",
                        opacity,
                        transform: rotation ? `rotate(${rotation}deg)` : undefined,
                      }}
                    />
                  ) : (
                    <div style={previewStyle}>
                      {badgeType === "dynamic" ? text.replace(/\{\{discount\}\}/g, "25").replace(/\{\{inventory\}\}/g, "3").replace(/\{\{sold\}\}/g, "142").replace(/\{\{price\}\}/g, `${currencySymbol}29.99`).replace(/\{\{compare_price\}\}/g, `${currencySymbol}39.99`) : text}
                    </div>
                  )}
                </div>
              </Box>

              {badgeType === "dynamic" && (
                <Banner tone="info">
                  Dynamic placeholders will be replaced with real product data on your storefront.
                </Banner>
              )}

              {conditionType !== "none" && (
                <Banner tone="info">
                  This badge will only appear on products matching the "{conditionType.replace(/_/g, " ")}" condition.
                </Banner>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
