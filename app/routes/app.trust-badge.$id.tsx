import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useSubmit,
} from "@remix-run/react";
import { useState, useCallback, useMemo, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  TextField,
  Select,
  Button,
  InlineStack,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
  Tabs,
  RangeSlider,
  ButtonGroup,
  DropZone,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  badgeCategories,
  filterBadges,
  getBadgesByIds,
  type BadgeCategory,
} from "../data/badgeLibrary";

interface TrustBadgeSettings {
  showHeader?: boolean;
  headerText?: string;
  fontFamily?: string;
  textColor?: string;
  fontWeight?: string;
  fontSize?: number;
  colorScheme?: "light" | "dark";
  align?: "left" | "center" | "right";
  animation?: string;
  badgeSize?: number;
  showBorder?: boolean;
  showSpacing?: boolean;
  showPadding?: boolean;
  position?: string;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const badge = await prisma.trustBadge.findFirst({
    where: { id: params.id, shop: session.shop },
  });
  if (!badge) throw new Response("Not found", { status: 404 });
  return json({
    badge: {
      id: badge.id,
      name: badge.name,
      isEnabled: badge.isEnabled,
      badgeIds: JSON.parse(badge.badgeIds) as string[],
      settings: JSON.parse(badge.settings) as TrustBadgeSettings,
    },
  });
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    await prisma.trustBadge.updateMany({
      where: { id: params.id, shop: session.shop },
      data: {
        name: data.name,
        isEnabled: data.isEnabled,
        badgeIds: JSON.stringify(data.badgeIds),
        settings: JSON.stringify(data.settings),
      },
    });
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to update trust badge" }, { status: 500 });
  }
};

const FONT_OPTIONS = [
  { label: "DM Sans", value: "'DM Sans', sans-serif" },
  { label: "Inter", value: "'Inter', sans-serif" },
  { label: "Roboto", value: "'Roboto', sans-serif" },
  { label: "Open Sans", value: "'Open Sans', sans-serif" },
  { label: "Lato", value: "'Lato', sans-serif" },
  { label: "Montserrat", value: "'Montserrat', sans-serif" },
];

const WEIGHT_OPTIONS = [
  { label: "Regular (400)", value: "400" },
  { label: "Medium (500)", value: "500" },
  { label: "Semi Bold (600)", value: "600" },
  { label: "Bold (700)", value: "700" },
];

const ANIMATION_OPTIONS = [
  { label: "None", value: "none" },
  { label: "Fade In", value: "fadeIn" },
  { label: "Slide Up", value: "slideUp" },
  { label: "Bounce", value: "bounce" },
];

const POSITION_OPTIONS = [
  { label: "Below The 'Add To Cart' Button (Product Page)", value: "below-atc" },
  { label: "Above The 'Add To Cart' Button", value: "above-atc" },
  { label: "Below Product Description", value: "below-description" },
  { label: "Cart Page", value: "cart-page" },
];

export default function EditTrustBadge() {
  const { badge } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const s = badge.settings;

  // Wizard step
  const [step, setStep] = useState(1); // Start on settings by default for edit

  // Step 1: Choose badges
  const [selectedTab, setSelectedTab] = useState(0);
  const [selectedBadgeIds, setSelectedBadgeIds] = useState<string[]>(badge.badgeIds);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<BadgeCategory | "all">("all");

  // Step 2: Settings
  const [name, setName] = useState(badge.name);
  const [isEnabled, setIsEnabled] = useState(badge.isEnabled);
  const [showHeader, setShowHeader] = useState(s.showHeader ?? true);
  const [headerText, setHeaderText] = useState(s.headerText || "Guaranteed Safe Checkout");
  const [fontFamily, setFontFamily] = useState(s.fontFamily || "'DM Sans', sans-serif");
  const [textColor, setTextColor] = useState(s.textColor || "#242D35");
  const [fontWeight, setFontWeight] = useState(s.fontWeight || "600");
  const [fontSize, setFontSize] = useState(String(s.fontSize ?? 16));
  const [colorScheme, setColorScheme] = useState<"light" | "dark">(s.colorScheme || "light");
  const [align, setAlign] = useState<"left" | "center" | "right">(s.align || "center");
  const [animation, setAnimation] = useState(s.animation || "none");
  const [badgeSize, setBadgeSize] = useState(s.badgeSize ?? 60);
  const [badgeSizePreset, setBadgeSizePreset] = useState<"small" | "medium" | "large">(
    (s.badgeSize ?? 60) <= 45 ? "small" : (s.badgeSize ?? 60) <= 75 ? "medium" : "large"
  );
  const [showBorder, setShowBorder] = useState(s.showBorder ?? false);
  const [showSpacing, setShowSpacing] = useState(s.showSpacing ?? true);
  const [showPadding, setShowPadding] = useState(s.showPadding ?? true);
  const [position, setPosition] = useState(s.position || "below-atc");

  const toggleBadge = useCallback((badgeId: string) => {
    setSelectedBadgeIds((prev) =>
      prev.includes(badgeId)
        ? prev.filter((id) => id !== badgeId)
        : [...prev, badgeId]
    );
  }, []);

  const filteredBadges = useMemo(
    () => filterBadges(categoryFilter, searchQuery),
    [categoryFilter, searchQuery]
  );

  const selectedBadgeItems = useMemo(
    () => getBadgesByIds(selectedBadgeIds),
    [selectedBadgeIds]
  );

  const handleSizePreset = useCallback((preset: "small" | "medium" | "large") => {
    setBadgeSizePreset(preset);
    setBadgeSize(preset === "small" ? 40 : preset === "medium" ? 60 : 90);
  }, []);

  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    name !== badge.name ||
    isEnabled !== badge.isEnabled ||
    JSON.stringify(selectedBadgeIds) !== JSON.stringify(badge.badgeIds) ||
    showHeader !== (s.showHeader ?? true) ||
    headerText !== (s.headerText || "Guaranteed Safe Checkout") ||
    fontFamily !== (s.fontFamily || "'DM Sans', sans-serif") ||
    textColor !== (s.textColor || "#242D35") ||
    fontWeight !== (s.fontWeight || "600") ||
    fontSize !== String(s.fontSize ?? 16) ||
    colorScheme !== (s.colorScheme || "light") ||
    align !== (s.align || "center") ||
    animation !== (s.animation || "none") ||
    badgeSize !== (s.badgeSize ?? 60) ||
    showBorder !== (s.showBorder ?? false) ||
    showSpacing !== (s.showSpacing ?? true) ||
    showPadding !== (s.showPadding ?? true) ||
    position !== (s.position || "below-atc");

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleSave = () => {
    const data = {
      name,
      isEnabled,
      badgeIds: selectedBadgeIds,
      settings: {
        showHeader,
        headerText,
        fontFamily,
        textColor,
        fontWeight,
        fontSize: parseInt(fontSize, 10),
        colorScheme,
        align,
        animation,
        badgeSize,
        showBorder,
        showSpacing,
        showPadding,
        position,
      },
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const previewBgColor = colorScheme === "dark" ? "#1a1a2e" : "#ffffff";
  const previewBorderColor = colorScheme === "dark" ? "#333" : "#e5e5e5";
  const previewTextColor = colorScheme === "dark" ? "#ffffff" : textColor;

  const renderPreview = () => (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">Live Preview</Text>
        <Box padding="400" background="bg-surface" borderWidth="025" borderRadius="200" borderColor="border">
          <div style={{
            backgroundColor: previewBgColor,
            border: `1px solid ${previewBorderColor}`,
            borderRadius: "8px",
            padding: showPadding ? "20px" : "8px",
            textAlign: align,
          }}>
            {showHeader && (
              <p style={{
                margin: "0 0 12px",
                fontFamily,
                fontWeight: parseInt(fontWeight, 10),
                fontSize: `${fontSize}px`,
                color: previewTextColor,
              }}>
                {headerText}
              </p>
            )}
            <div style={{
              display: "flex",
              flexWrap: "wrap",
              gap: showSpacing ? "10px" : "4px",
              justifyContent: align === "left" ? "flex-start" : align === "right" ? "flex-end" : "center",
            }}>
              {selectedBadgeItems.length === 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">No badges selected</Text>
              ) : (
                selectedBadgeItems.map((b) => (
                  <img key={b.id} src={b.imageUrl} alt={b.name} style={{
                    width: badgeSize,
                    height: "auto",
                    border: showBorder ? `1px solid ${colorScheme === "dark" ? "#555" : "#ddd"}` : "none",
                    borderRadius: "4px",
                  }} />
                ))
              )}
            </div>
          </div>
        </Box>
      </BlockStack>
    </Card>
  );

  const renderStep1 = () => (
    <Layout>
      <Layout.Section>
        <Card>
          <BlockStack gap="400">
            <Tabs
              tabs={[
                { id: "library", content: "Library" },
                { id: "upload", content: "Upload" },
              ]}
              selected={selectedTab}
              onSelect={setSelectedTab}
            />
            {selectedTab === 0 ? (
              <BlockStack gap="400">
                <InlineGrid columns={{ xs: 1, sm: "2fr 1fr" }} gap="300">
                  <TextField
                    label="Search badges"
                    labelHidden
                    placeholder="Search badges..."
                    value={searchQuery}
                    onChange={setSearchQuery}
                    autoComplete="off"
                    clearButton
                    onClearButtonClick={() => setSearchQuery("")}
                  />
                  <Select
                    label="Category"
                    labelHidden
                    options={badgeCategories.map((c) => ({ label: c.label, value: c.value }))}
                    value={categoryFilter}
                    onChange={(v) => setCategoryFilter(v as BadgeCategory | "all")}
                  />
                </InlineGrid>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "12px" }}>
                  {filteredBadges.map((b) => {
                    const isSelected = selectedBadgeIds.includes(b.id);
                    return (
                      <div key={b.id} onClick={() => toggleBadge(b.id)} style={{
                        border: isSelected ? "2px solid #2c6ecb" : "2px solid #e5e5e5",
                        borderRadius: "8px",
                        padding: "12px",
                        cursor: "pointer",
                        textAlign: "center",
                        backgroundColor: isSelected ? "#f0f6ff" : "#ffffff",
                        transition: "all 0.15s ease",
                      }}>
                        <img src={b.imageUrl} alt={b.name} style={{ width: "80px", height: "auto", marginBottom: "6px" }} />
                        <div style={{ fontSize: "11px", color: "#666", lineHeight: 1.3 }}>{b.name}</div>
                      </div>
                    );
                  })}
                </div>
                {filteredBadges.length === 0 && (
                  <Box padding="800">
                    <Text as="p" variant="bodyMd" tone="subdued" alignment="center">
                      No badges found matching your search.
                    </Text>
                  </Box>
                )}
              </BlockStack>
            ) : (
              <BlockStack gap="400">
                <DropZone accept="image/*" type="image" onDrop={() => {}} label="Upload custom badge images">
                  <DropZone.FileUpload actionTitle="Add image" actionHint="or drop files to upload" />
                </DropZone>
                <Text as="p" variant="bodySm" tone="subdued">
                  Accepted formats: SVG, PNG, JPG. Recommended size: 120x40px.
                </Text>
              </BlockStack>
            )}
          </BlockStack>
        </Card>
      </Layout.Section>
      <Layout.Section variant="oneThird">{renderPreview()}</Layout.Section>
    </Layout>
  );

  const renderStep2 = () => (
    <Layout>
      <Layout.Section>
        <BlockStack gap="400">
          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">General</Text>
              <TextField label="Trust Badge Name" value={name} onChange={setName} autoComplete="off" />
              <Checkbox label="Enabled" checked={isEnabled} onChange={setIsEnabled} />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Header</Text>
              <Checkbox label="Show Header" checked={showHeader} onChange={setShowHeader} />
              {showHeader && (
                <>
                  <TextField label="Header Text" value={headerText} onChange={setHeaderText} autoComplete="off" />
                  <InlineGrid columns={2} gap="400">
                    <Select label="Font Family" options={FONT_OPTIONS} value={fontFamily} onChange={setFontFamily} />
                    <Select label="Font Weight" options={WEIGHT_OPTIONS} value={fontWeight} onChange={setFontWeight} />
                  </InlineGrid>
                  <InlineGrid columns={2} gap="400">
                    <TextField label="Text Color" value={textColor} onChange={setTextColor} autoComplete="off"
                      prefix={<div style={{ width: 20, height: 20, backgroundColor: textColor, borderRadius: 4, border: "1px solid #ccc" }} />} />
                    <TextField label="Font Size" type="number" value={fontSize} onChange={setFontSize} autoComplete="off" suffix="px" min={10} max={32} />
                  </InlineGrid>
                </>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Appearance</Text>
              <Text as="p" variant="bodyMd">Color Scheme</Text>
              <InlineStack gap="300">
                <div onClick={() => setColorScheme("light")} style={{
                  width: 80, height: 50, backgroundColor: "#ffffff",
                  border: colorScheme === "light" ? "3px solid #2c6ecb" : "2px solid #ddd",
                  borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}>
                  <div style={{ width: 16, height: 12, backgroundColor: "#1a1f71", borderRadius: 2 }} />
                  <div style={{ width: 16, height: 12, backgroundColor: "#eb001b", borderRadius: 2 }} />
                  <div style={{ width: 16, height: 12, backgroundColor: "#003087", borderRadius: 2 }} />
                </div>
                <div onClick={() => setColorScheme("dark")} style={{
                  width: 80, height: 50, backgroundColor: "#1a1a2e",
                  border: colorScheme === "dark" ? "3px solid #2c6ecb" : "2px solid #555",
                  borderRadius: 8, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}>
                  <div style={{ width: 16, height: 12, backgroundColor: "#4a5078", borderRadius: 2 }} />
                  <div style={{ width: 16, height: 12, backgroundColor: "#6a4050", borderRadius: 2 }} />
                  <div style={{ width: 16, height: 12, backgroundColor: "#304070", borderRadius: 2 }} />
                </div>
              </InlineStack>

              <Text as="p" variant="bodyMd">Alignment</Text>
              <ButtonGroup>
                <Button pressed={align === "left"} onClick={() => setAlign("left")} size="slim">Left</Button>
                <Button pressed={align === "center"} onClick={() => setAlign("center")} size="slim">Center</Button>
                <Button pressed={align === "right"} onClick={() => setAlign("right")} size="slim">Right</Button>
              </ButtonGroup>

              <Select label="Animation" options={ANIMATION_OPTIONS} value={animation} onChange={setAnimation} />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Badge Size</Text>
              <ButtonGroup>
                <Button pressed={badgeSizePreset === "small"} onClick={() => handleSizePreset("small")} size="slim">Small</Button>
                <Button pressed={badgeSizePreset === "medium"} onClick={() => handleSizePreset("medium")} size="slim">Medium</Button>
                <Button pressed={badgeSizePreset === "large"} onClick={() => handleSizePreset("large")} size="slim">Large</Button>
              </ButtonGroup>
              <RangeSlider
                label={`Custom size: ${badgeSize}px`}
                value={badgeSize}
                min={20}
                max={120}
                onChange={(v) => {
                  setBadgeSize(v as number);
                  setBadgeSizePreset((v as number) <= 45 ? "small" : (v as number) <= 75 ? "medium" : "large");
                }}
                output
              />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Options</Text>
              <Checkbox label="Badges Border" helpText="Add a subtle border around each badge" checked={showBorder} onChange={setShowBorder} />
              <Checkbox label="Badges Spacing" helpText="Add spacing between badges" checked={showSpacing} onChange={setShowSpacing} />
              <Checkbox label="Box Padding" helpText="Add padding around the badge container" checked={showPadding} onChange={setShowPadding} />
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="400">
              <Text as="h2" variant="headingMd">Placement</Text>
              <Select label="Badge Position" options={POSITION_OPTIONS} value={position} onChange={setPosition} />
            </BlockStack>
          </Card>
        </BlockStack>
      </Layout.Section>
      <Layout.Section variant="oneThird">{renderPreview()}</Layout.Section>
    </Layout>
  );

  return (
    <Page>
      <TitleBar title={step === 0 ? "Edit Badges" : "Edit Settings"}>
        <button onClick={() => navigate("/app/trust-badge")}>Cancel</button>
        {step === 0 ? (
          <button variant="primary" onClick={() => setStep(1)}>Next</button>
        ) : (
          <>
            <button onClick={() => setStep(0)}>Edit Badges</button>
            <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
          </>
        )}
      </TitleBar>
      <BlockStack gap="400">
        {showSuccess && <Banner tone="success">Trust badge saved successfully.</Banner>}
        {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

        <Card>
          <InlineStack gap="400" align="center">
            <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: step === 0 ? 1 : 0.5 }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                backgroundColor: step === 0 ? "#2c6ecb" : "#e5e5e5",
                color: step === 0 ? "#fff" : "#666",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 600,
              }}>1</div>
              <Text as="span" variant="bodyMd" fontWeight={step === 0 ? "bold" : "regular"}>Choose Badges</Text>
            </div>
            <div style={{ width: 40, height: 2, backgroundColor: "#e5e5e5" }} />
            <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: step === 1 ? 1 : 0.5 }}>
              <div style={{
                width: 28, height: 28, borderRadius: "50%",
                backgroundColor: step === 1 ? "#2c6ecb" : "#e5e5e5",
                color: step === 1 ? "#fff" : "#666",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, fontWeight: 600,
              }}>2</div>
              <Text as="span" variant="bodyMd" fontWeight={step === 1 ? "bold" : "regular"}>Settings</Text>
            </div>
          </InlineStack>
        </Card>

        {step === 0 ? renderStep1() : renderStep2()}
      </BlockStack>
    </Page>
  );
}
