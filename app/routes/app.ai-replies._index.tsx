import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
  Button,
  List,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { buildSystemPrompt, callGemini } from "../utils/ai-replies.server";

const POSITIONS = ["bottom-right", "bottom-left"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await prisma.aiReplySettings.findUnique({ where: { shop: session.shop } });
  return json({
    isEnabled: s?.isEnabled ?? false,
    // The key itself never leaves the server — only whether one is saved.
    hasKey: Boolean(s?.apiKey),
    keyPreview: s?.apiKey ? s.apiKey.slice(-4) : "",
    knowledge: s?.knowledge ?? "",
    botName: s?.botName ?? "Support",
    greeting: s?.greeting ?? "Hi! Ask me about shipping, returns or sizing.",
    supportEmail: s?.supportEmail ?? "",
    supportUrl: s?.supportUrl ?? "",
    accentColor: s?.accentColor ?? "#111111",
    position: s?.position ?? "bottom-right",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const shop = session.shop;

  // "Test" uses the SAVED key so the merchant can verify setup without
  // pasting the key again or visiting the storefront.
  if (formData.get("intent") === "test") {
    const s = await prisma.aiReplySettings.findUnique({ where: { shop } });
    if (!s?.apiKey) return json({ testError: "Save your Gemini API key first." });
    const question = String(formData.get("testQuestion") || "").trim() || "What is your return policy?";
    const result = await callGemini({
      apiKey: s.apiKey,
      system: buildSystemPrompt(s),
      history: [],
      message: question.slice(0, 1000),
    });
    if (result.ok) return json({ testResult: result.text });
    return json({
      testError:
        result.error === "bad-key"
          ? "Gemini rejected the API key. Check it's a valid key from Google AI Studio."
          : result.error === "timeout"
          ? "Gemini didn't respond in time. Try again."
          : "Couldn't reach Gemini. Check the key and try again.",
    });
  }

  const data = JSON.parse(formData.get("data") as string);
  const text = (v: unknown, fallback: string, max = 300) => {
    const str = String(v ?? "").trim();
    return str ? str.slice(0, max) : fallback;
  };

  const accentColor = String(data.accentColor || "").trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(accentColor)) {
    return json({ error: "Accent colour must be a hex value like #111111." }, { status: 400 });
  }

  const newKey = String(data.apiKey || "").trim();

  try {
    const values = {
      isEnabled: Boolean(data.isEnabled),
      knowledge: String(data.knowledge ?? "").slice(0, 20000),
      botName: text(data.botName, "Support", 60),
      greeting: text(data.greeting, "Hi! Ask me about shipping, returns or sizing.", 300),
      supportEmail: text(data.supportEmail, "", 200),
      supportUrl: text(data.supportUrl, "", 300),
      accentColor,
      position: POSITIONS.includes(data.position) ? data.position : "bottom-right",
    };
    await prisma.aiReplySettings.upsert({
      where: { shop },
      // Empty key field means "keep the saved key".
      create: { shop, apiKey: newKey, ...values },
      update: { ...(newKey ? { apiKey: newKey } : {}), ...values },
    });
    await bumpConfigVersion(shop);
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

type ActionData = {
  success?: boolean;
  error?: string;
  testResult?: string;
  testError?: string;
};

export default function AiRepliesPage() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state === "submitting";

  const initial = {
    enabled: d.isEnabled,
    apiKey: "",
    knowledge: d.knowledge,
    botName: d.botName,
    greeting: d.greeting,
    supportEmail: d.supportEmail,
    supportUrl: d.supportUrl,
    accentColor: d.accentColor,
    position: d.position,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [apiKey, setApiKey] = useState(initial.apiKey);
  const [knowledge, setKnowledge] = useState(initial.knowledge);
  const [botName, setBotName] = useState(initial.botName);
  const [greeting, setGreeting] = useState(initial.greeting);
  const [supportEmail, setSupportEmail] = useState(initial.supportEmail);
  const [supportUrl, setSupportUrl] = useState(initial.supportUrl);
  const [accentColor, setAccentColor] = useState(initial.accentColor);
  const [position, setPosition] = useState(initial.position);
  const [testQuestion, setTestQuestion] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    apiKey !== initial.apiKey ||
    knowledge !== initial.knowledge ||
    botName !== initial.botName ||
    greeting !== initial.greeting ||
    supportEmail !== initial.supportEmail ||
    supportUrl !== initial.supportUrl ||
    accentColor !== initial.accentColor ||
    position !== initial.position;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      setApiKey("");
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setEnabled(initial.enabled);
    setApiKey(initial.apiKey);
    setKnowledge(initial.knowledge);
    setBotName(initial.botName);
    setGreeting(initial.greeting);
    setSupportEmail(initial.supportEmail);
    setSupportUrl(initial.supportUrl);
    setAccentColor(initial.accentColor);
    setPosition(initial.position);
  };

  const handleSave = () => {
    submit(
      {
        data: JSON.stringify({
          isEnabled: enabled,
          apiKey,
          knowledge,
          botName,
          greeting,
          supportEmail,
          supportUrl,
          accentColor,
          position,
        }),
      },
      { method: "POST" },
    );
  };

  const handleTest = () => submit({ intent: "test", testQuestion }, { method: "POST" });

  return (
    <Page>
      <TitleBar title="Automated Replies">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Banner tone="info" title="How it works">
              <BlockStack gap="200">
                <Text as="p">
                  A chat bubble appears on your storefront. Shoppers ask questions and the
                  assistant answers <strong>only</strong> from the store information you
                  write below — it's told never to invent policies, prices or delivery dates.
                </Text>
                <List type="number">
                  <List.Item>
                    Get a free Gemini API key from Google AI Studio (aistudio.google.com/apikey).
                  </List.Item>
                  <List.Item>Paste it below and write your store information.</List.Item>
                  <List.Item>Use <strong>Test</strong> to check a question, then enable.</List.Item>
                </List>
                <Text as="p" tone="subdued">
                  Replies are billed to your own Google account. Your key is stored securely
                  and never sent to the storefront. Conversations aren't saved.
                </Text>
              </BlockStack>
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Automated Replies</Text>
                <Checkbox
                  label="Enable the chat assistant"
                  helpText="Needs an API key. When disabled, the bubble disappears from your storefront."
                  checked={enabled}
                  onChange={setEnabled}
                />
                <TextField
                  label="Gemini API key"
                  value={apiKey}
                  onChange={setApiKey}
                  autoComplete="off"
                  placeholder={
                    d.hasKey
                      ? `Saved key ending in ${d.keyPreview} — enter a new key to replace it`
                      : "Paste your Gemini API key"
                  }
                  helpText="From Google AI Studio. Stored securely — never sent to your storefront."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Store information</Text>
                <Text as="p" tone="subdued">
                  Everything the assistant is allowed to answer from: shipping times, returns
                  and exchanges, sizing, payment methods, current offers, contact details.
                  Anything not written here, it will decline to answer.
                </Text>
                <TextField
                  label="Knowledge"
                  labelHidden
                  value={knowledge}
                  onChange={setKnowledge}
                  autoComplete="off"
                  multiline={14}
                  placeholder={
                    "SHIPPING\nFree shipping across India. Metro cities 1-3 business days...\n\n" +
                    "RETURNS\n7 day return window. Items must be unused with tags attached...\n\n" +
                    "SIZING\nSee our size chart at /pages/size-chart..."
                  }
                  helpText="Plain text. Keep it accurate — the assistant repeats what you write here."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Test</Text>
                <Text as="p" tone="subdued">
                  Asks the assistant a question using your saved key and store information.
                  Save your changes first.
                </Text>
                {actionData?.testResult && (
                  <Banner tone="success" title="Reply">{actionData.testResult}</Banner>
                )}
                {actionData?.testError && <Banner tone="warning">{actionData.testError}</Banner>}
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flexGrow: 1 }}>
                    <TextField
                      label="Question"
                      labelHidden
                      value={testQuestion}
                      onChange={setTestQuestion}
                      autoComplete="off"
                      placeholder="What is your return policy?"
                    />
                  </div>
                  <Button onClick={handleTest} loading={busy}>Test</Button>
                </InlineStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Appearance &amp; contact</Text>
                <TextField
                  label="Assistant name"
                  value={botName}
                  onChange={setBotName}
                  autoComplete="off"
                />
                <TextField
                  label="Greeting"
                  value={greeting}
                  onChange={setGreeting}
                  autoComplete="off"
                  helpText="Shown when a shopper opens the chat."
                />
                <TextField
                  label="Support email"
                  value={supportEmail}
                  onChange={setSupportEmail}
                  autoComplete="off"
                  placeholder="support@yourstore.com"
                  helpText="Offered when the assistant can't help — e.g. order problems or complaints."
                />
                <TextField
                  label="Support link (optional)"
                  value={supportUrl}
                  onChange={setSupportUrl}
                  autoComplete="off"
                  placeholder="https://wa.me/919999999999"
                  helpText="WhatsApp or any contact page."
                />
                <TextField
                  label="Accent colour"
                  value={accentColor}
                  onChange={setAccentColor}
                  autoComplete="off"
                  placeholder="#111111"
                />
                <Select
                  label="Bubble position"
                  options={[
                    { label: "Bottom right", value: "bottom-right" },
                    { label: "Bottom left", value: "bottom-left" },
                  ]}
                  value={position}
                  onChange={setPosition}
                />
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
