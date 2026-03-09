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
  Button,
  InlineGrid,
  Box,
  Checkbox,
  Banner,
  ChoiceList,
  InlineStack,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

interface BarMessage {
  text: string;
  emoji: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const bar = await prisma.announcementBar.findFirst({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return json({
    bar: bar
      ? {
          ...bar,
          messages: JSON.parse(bar.messages) as BarMessage[],
          pages: JSON.parse(bar.pages) as string[],
          schedule: JSON.parse(bar.schedule) as Record<string, string>,
        }
      : null,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const data = JSON.parse(formData.get("data") as string);

  try {
    const existing = await prisma.announcementBar.findFirst({
      where: { shop: session.shop },
    });

    if (existing) {
      await prisma.announcementBar.update({
        where: { id: existing.id },
        data: {
          messages: JSON.stringify(data.messages),
          bgColor: data.bgColor,
          textColor: data.textColor,
          isActive: data.isActive,
          showClose: data.showClose,
          pages: JSON.stringify(data.pages),
          schedule: JSON.stringify(data.schedule),
        },
      });
    } else {
      await prisma.announcementBar.create({
        data: {
          shop: session.shop,
          messages: JSON.stringify(data.messages),
          bgColor: data.bgColor,
          textColor: data.textColor,
          isActive: data.isActive,
          showClose: data.showClose,
          pages: JSON.stringify(data.pages),
          schedule: JSON.stringify(data.schedule),
        },
      });
    }
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save announcement bar" }, { status: 500 });
  }
};

export default function AnnouncementBarSettings() {
  const { bar } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();

  const [messages, setMessages] = useState<BarMessage[]>(
    bar?.messages || [{ text: "Welcome to our store!", emoji: "" }]
  );
  const [bgColor, setBgColor] = useState(bar?.bgColor || "#000000");
  const [textColor, setTextColor] = useState(bar?.textColor || "#ffffff");
  const [isActive, setIsActive] = useState(bar?.isActive ?? true);
  const [showClose, setShowClose] = useState(bar?.showClose ?? true);
  const [pages, setPages] = useState<string[]>(bar?.pages || ["all"]);
  const [startDate, setStartDate] = useState(bar?.schedule?.startDate || "");
  const [endDate, setEndDate] = useState(bar?.schedule?.endDate || "");

  const handleSave = () => {
    const data = {
      messages,
      bgColor,
      textColor,
      isActive,
      showClose,
      pages,
      schedule: { startDate, endDate },
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const addMessage = () => {
    setMessages([...messages, { text: "", emoji: "" }]);
  };

  const removeMessage = (index: number) => {
    setMessages(messages.filter((_, i) => i !== index));
  };

  const updateMessage = (index: number, field: keyof BarMessage, value: string) => {
    const updated = [...messages];
    updated[index] = { ...updated[index], [field]: value };
    setMessages(updated);
  };

  return (
    <Page>
      <TitleBar title="Announcement Bar">
        <button variant="primary" onClick={handleSave}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {actionData?.success && <Banner tone="success">Announcement bar saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">General</Text>
                </InlineStack>
                <Checkbox label="Enable announcement bar" checked={isActive} onChange={setIsActive} />
                <Checkbox label="Show close button" checked={showClose} onChange={setShowClose} />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between">
                  <Text as="h2" variant="headingMd">Messages</Text>
                  <Button size="slim" onClick={addMessage}>Add Message</Button>
                </InlineStack>
                {messages.map((msg, index) => (
                  <InlineGrid key={index} columns={{ xs: 1, sm: "1fr auto auto" }} gap="200" alignItems="end">
                    <TextField
                      label={`Message ${index + 1}`}
                      value={msg.text}
                      onChange={(v) => updateMessage(index, "text", v)}
                      autoComplete="off"
                    />
                    <TextField
                      label="Emoji"
                      value={msg.emoji}
                      onChange={(v) => updateMessage(index, "emoji", v)}
                      autoComplete="off"
                      maxLength={4}
                    />
                    {messages.length > 1 && (
                      <Button tone="critical" size="slim" onClick={() => removeMessage(index)}>
                        Remove
                      </Button>
                    )}
                  </InlineGrid>
                ))}
                {messages.length > 1 && (
                  <Text as="p" variant="bodyMd" tone="subdued">
                    Messages will auto-rotate on the storefront.
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Colors</Text>
                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Background Color"
                    value={bgColor}
                    onChange={setBgColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: bgColor, borderRadius: 4, border: "1px solid #ccc" }} />}
                  />
                  <TextField
                    label="Text Color"
                    value={textColor}
                    onChange={setTextColor}
                    autoComplete="off"
                    prefix={<div style={{ width: 20, height: 20, backgroundColor: textColor, borderRadius: 4, border: "1px solid #ccc" }} />}
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
                    { label: "All Pages", value: "all" },
                    { label: "Home Page", value: "home" },
                    { label: "Product Pages", value: "product" },
                    { label: "Collection Pages", value: "collection" },
                    { label: "Cart Page", value: "cart" },
                  ]}
                  selected={pages}
                  onChange={setPages}
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Schedule</Text>
                <InlineGrid columns={2} gap="400">
                  <TextField
                    label="Start Date"
                    type="date"
                    value={startDate}
                    onChange={setStartDate}
                    autoComplete="off"
                  />
                  <TextField
                    label="End Date"
                    type="date"
                    value={endDate}
                    onChange={setEndDate}
                    autoComplete="off"
                  />
                </InlineGrid>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Leave empty for no scheduling restrictions.
                </Text>
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
                  padding: "10px 16px",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: "8px",
                  fontSize: "14px",
                  position: "relative",
                }}>
                  <span>
                    {messages[0]?.emoji && <span style={{ marginRight: 4 }}>{messages[0].emoji}</span>}
                    {messages[0]?.text || "Your announcement here"}
                  </span>
                  {showClose && (
                    <span style={{ position: "absolute", right: 12, cursor: "pointer", opacity: 0.7, fontSize: 16 }}>
                      &times;
                    </span>
                  )}
                </div>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
