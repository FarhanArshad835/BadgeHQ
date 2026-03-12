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
  const timer = await prisma.countdownTimer.findFirst({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return json({
    timer: timer
      ? {
          ...timer,
          endDate: timer.endDate.toISOString().slice(0, 16),
          messages: JSON.parse(timer.messages) as Record<string, string>,
          colors: JSON.parse(timer.colors) as Record<string, string>,
          pages: JSON.parse(timer.pages) as string[],
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    const existing = await prisma.countdownTimer.findFirst({
      where: { shop: session.shop },
    });

    const saveData = {
      endDate: new Date(data.endDate),
      style: data.style,
      messages: JSON.stringify(data.messages),
      colors: JSON.stringify(data.colors),
      isActive: data.isActive,
      pages: JSON.stringify(data.pages),
    };

    if (existing) {
      await prisma.countdownTimer.update({ where: { id: existing.id }, data: saveData });
    } else {
      await prisma.countdownTimer.create({ data: { shop: session.shop, ...saveData } });
    }
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save countdown timer" }, { status: 500 });
  }
};

export default function CountdownTimerSettings() {
  const { timer } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const defaultEnd = new Date();
  defaultEnd.setDate(defaultEnd.getDate() + 7);
  const defaultEndStr = defaultEnd.toISOString().slice(0, 16);

  const initial = {
    endDate: timer?.endDate || defaultEndStr,
    style: timer?.style || "full",
    aboveMsg: timer?.messages?.above || "Hurry! Sale ends in:",
    belowMsg: timer?.messages?.below || "Don't miss out!",
    bgColor: timer?.colors?.bg || "#000000",
    textColor: timer?.colors?.text || "#ffffff",
    accentColor: timer?.colors?.accent || "#e74c3c",
    isActive: timer?.isActive ?? false,
    pages: timer?.pages || ["product"],
  };

  const [endDate, setEndDate] = useState(initial.endDate);
  const [style, setStyle] = useState(initial.style);
  const [aboveMsg, setAboveMsg] = useState(initial.aboveMsg);
  const [belowMsg, setBelowMsg] = useState(initial.belowMsg);
  const [bgColor, setBgColor] = useState(initial.bgColor);
  const [textColor, setTextColor] = useState(initial.textColor);
  const [accentColor, setAccentColor] = useState(initial.accentColor);
  const [isActive, setIsActive] = useState(initial.isActive);
  const [pages, setPages] = useState<string[]>(initial.pages);
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    endDate !== initial.endDate ||
    style !== initial.style ||
    aboveMsg !== initial.aboveMsg ||
    belowMsg !== initial.belowMsg ||
    bgColor !== initial.bgColor ||
    textColor !== initial.textColor ||
    accentColor !== initial.accentColor ||
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
    setEndDate(initial.endDate);
    setStyle(initial.style);
    setAboveMsg(initial.aboveMsg);
    setBelowMsg(initial.belowMsg);
    setBgColor(initial.bgColor);
    setTextColor(initial.textColor);
    setAccentColor(initial.accentColor);
    setIsActive(initial.isActive);
    setPages(initial.pages);
  };

  const handleSave = () => {
    const data = {
      endDate,
      style,
      messages: { above: aboveMsg, below: belowMsg },
      colors: { bg: bgColor, text: textColor, accent: accentColor },
      isActive,
      pages,
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Countdown Timer">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Countdown timer saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">General</Text>
                <Checkbox label="Enable countdown timer" checked={isActive} onChange={setIsActive} />
                <TextField
                  label="End Date & Time"
                  type="datetime-local"
                  value={endDate}
                  onChange={setEndDate}
                  autoComplete="off"
                  helpText="Timer auto-hides when expired"
                />
                <Select
                  label="Display Style"
                  options={[
                    { label: "Full (days, hours, minutes, seconds)", value: "full" },
                    { label: "Compact (hours, minutes, seconds)", value: "compact" },
                  ]}
                  value={style}
                  onChange={setStyle}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Messages</Text>
                <TextField
                  label="Message Above Timer"
                  value={aboveMsg}
                  onChange={setAboveMsg}
                  autoComplete="off"
                />
                <TextField
                  label="Message Below Timer"
                  value={belowMsg}
                  onChange={setBelowMsg}
                  autoComplete="off"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Colors</Text>
                <InlineGrid columns={3} gap="400">
                  <TextField
                    label="Background"
                    value={bgColor}
                    onChange={setBgColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: bgColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                  <TextField
                    label="Text"
                    value={textColor}
                    onChange={setTextColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: textColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                  <TextField
                    label="Accent"
                    value={accentColor}
                    onChange={setAccentColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: accentColor, borderRadius: 4, border: "1px solid #ccc" }} />}
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
                    { label: "Product Pages", value: "product" },
                    { label: "Cart Page", value: "cart" },
                    { label: "Home Page", value: "home" },
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
              <Box padding="0" borderWidth="025" borderRadius="200" borderColor="border" overflowX="clip">
                <div style={{
                  backgroundColor: bgColor,
                  color: textColor,
                  padding: "16px",
                  textAlign: "center",
                }}>
                  <p style={{ margin: "0 0 12px", fontSize: "14px" }}>{aboveMsg}</p>
                  <div style={{ display: "flex", justifyContent: "center", gap: "8px" }}>
                    {(style === "full" ? ["Days", "Hours", "Min", "Sec"] : ["Hours", "Min", "Sec"]).map((label) => (
                      <div key={label} style={{ textAlign: "center" }}>
                        <div style={{
                          backgroundColor: accentColor,
                          color: textColor,
                          padding: "8px 12px",
                          borderRadius: "6px",
                          fontSize: "20px",
                          fontWeight: 700,
                          minWidth: "48px",
                        }}>
                          {label === "Days" ? "03" : label === "Hours" ? "12" : label === "Min" ? "45" : "30"}
                        </div>
                        <div style={{ fontSize: "10px", marginTop: "4px", opacity: 0.7 }}>{label}</div>
                      </div>
                    ))}
                  </div>
                  <p style={{ margin: "12px 0 0", fontSize: "12px", opacity: 0.8 }}>{belowMsg}</p>
                </div>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
