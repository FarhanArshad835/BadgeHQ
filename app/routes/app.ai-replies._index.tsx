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
import { generateWebhookToken, registerDoubleTickWebhook } from "../utils/whatsapp-ai.server";

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

    // WhatsApp inbound replies. Secrets follow the same rule as the Gemini key:
    // only ever "is one saved" plus the last 4 characters.
    waReplyEnabled: s?.waReplyEnabled ?? false,
    waProvider: s?.waProvider ?? "interakt",
    hasWaKey: Boolean(s?.waApiKey),
    waKeyPreview: s?.waApiKey ? s.waApiKey.slice(-4) : "",
    hasWaSecret: Boolean(s?.waWebhookSecret),
    waFromNumber: s?.waFromNumber ?? "",
    // Whether the DoubleTick webhook has been registered for this shop.
    hasWaAuth: Boolean(s?.waWebhookAuth),
    // Built from the app's own URL, never the request host — inside the Shopify
    // admin the request arrives on the embedded-app host, which would produce a
    // webhook URL that silently never receives anything.
    webhookUrl: s?.waWebhookToken
      ? `${(process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "")}/webhooks/${
          s.waProvider === "doubletick" ? "doubletick" : "interakt"
        }/${s.waWebhookToken}`
      : "",
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
          : result.error === "bad-model"
          ? "Gemini no longer offers the model this app requests (Google retires older models). This needs an app update — your API key is fine."
          : result.error === "timeout"
          ? "Gemini didn't respond in time. Try again."
          : "Couldn't reach Gemini. Check the key and try again.",
    });
  }

  // Generate or rotate the per-shop webhook token. Rotation immediately breaks
  // the old URL, so the UI warns before calling this.
  if (formData.get("intent") === "rotate-token") {
    const token = generateWebhookToken();
    await prisma.aiReplySettings.upsert({
      where: { shop },
      create: { shop, waWebhookToken: token },
      update: { waWebhookToken: token },
    });
    return json({ success: true, tokenRotated: true });
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
  const newWaKey = String(data.waApiKey || "").trim();
  const newWaSecret = String(data.waWebhookSecret || "").trim();
  const waProvider = data.waProvider === "doubletick" ? "doubletick" : "interakt";
  const waFromNumber = String(data.waFromNumber || "").trim().replace(/[^\d+]/g, "").slice(0, 20);

  const existing = await prisma.aiReplySettings.findUnique({ where: { shop } });
  const willHaveWaKey = newWaKey || existing?.waApiKey;

  // Whether WhatsApp replies can actually work. Checked, but NOT used to reject
  // the save: an earlier version returned 400 here, which threw away the whole
  // form — including the storefront chat toggle, which has nothing to do with
  // WhatsApp. The result was a save that appeared to do nothing at all. Now the
  // settings always persist and this only decides whether waReplyEnabled is
  // allowed to be on.
  const wantsWa = Boolean(data.waReplyEnabled);
  let waBlocked = "";
  if (wantsWa) {
    if (!willHaveWaKey) {
      waBlocked = `WhatsApp replies stayed off: add your ${
        waProvider === "doubletick" ? "DoubleTick" : "Interakt"
      } API key first.`;
    } else if (waProvider === "doubletick") {
      if (!waFromNumber) waBlocked = "WhatsApp replies stayed off: DoubleTick needs your sender number.";
    } else if (!(newWaSecret || existing?.waWebhookSecret)) {
      waBlocked = "WhatsApp replies stayed off: Interakt also needs the webhook secret.";
    } else if (!existing?.waWebhookToken) {
      waBlocked = "WhatsApp replies stayed off: generate the webhook URL and paste it into Interakt first.";
    }
  }

  // DoubleTick has no dashboard step for the merchant: we register the webhook
  // for them. It signs nothing, so we mint a bearer token here and it echoes
  // that back on every delivery — that token is what the route verifies.
  //
  // A registration failure must not lose the merchant's other edits, so it
  // downgrades to a warning and leaves waReplyEnabled off rather than aborting.
  // The token is reused once minted, so re-saving re-registers the same URL
  // rather than orphaning the previous one.
  let waWebhookToken = existing?.waWebhookToken || "";
  let waWebhookAuth = existing?.waWebhookAuth || "";
  if (wantsWa && !waBlocked && waProvider === "doubletick") {
    const base = (process.env.SHOPIFY_APP_URL || "").replace(/\/$/, "");
    if (!base) {
      waBlocked = "WhatsApp replies stayed off: the app URL isn't configured — contact support.";
    } else {
      if (!waWebhookToken) waWebhookToken = generateWebhookToken();
      if (!waWebhookAuth) waWebhookAuth = generateWebhookToken();

      const reg = await registerDoubleTickWebhook({
        apiKey: String(willHaveWaKey),
        url: `${base}/webhooks/doubletick/${waWebhookToken}`,
        authToken: waWebhookAuth,
        fromNumber: waFromNumber,
      });
      if (!reg.ok) {
        waBlocked = reg.error.startsWith("auth-failed")
          ? "WhatsApp replies stayed off: DoubleTick rejected the API key."
          : `WhatsApp replies stayed off — DoubleTick refused the webhook: ${reg.error}`;
      }
    }
  }

  try {
    const values = {
      isEnabled: Boolean(data.isEnabled),
      // Never store "on" when it can't work — the cron would drop every job as
      // permanently failed and the merchant would just see silence.
      waReplyEnabled: wantsWa && !waBlocked,
      waProvider,
      waFromNumber,
      waWebhookToken,
      waWebhookAuth,
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
      create: { shop, apiKey: newKey, waApiKey: newWaKey, waWebhookSecret: newWaSecret, ...values },
      update: {
        ...(newKey ? { apiKey: newKey } : {}),
        ...(newWaKey ? { waApiKey: newWaKey } : {}),
        ...(newWaSecret ? { waWebhookSecret: newWaSecret } : {}),
        ...values,
      },
    });
    await bumpConfigVersion(shop);
    return json({ success: true, warning: waBlocked || undefined });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

type ActionData = {
  success?: boolean;
  /** Saved, but WhatsApp replies could not be switched on — says why. */
  warning?: string;
  error?: string;
  testResult?: string;
  testError?: string;
  tokenRotated?: boolean;
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
    waReplyEnabled: d.waReplyEnabled,
    waProvider: d.waProvider,
    waApiKey: "",
    waWebhookSecret: "",
    waFromNumber: d.waFromNumber,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [waReplyEnabled, setWaReplyEnabled] = useState(initial.waReplyEnabled);
  const [waProvider, setWaProvider] = useState(initial.waProvider);
  const [waApiKey, setWaApiKey] = useState(initial.waApiKey);
  const [waWebhookSecret, setWaWebhookSecret] = useState(initial.waWebhookSecret);
  const [waFromNumber, setWaFromNumber] = useState(initial.waFromNumber);
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
    position !== initial.position ||
    waReplyEnabled !== initial.waReplyEnabled ||
    waProvider !== initial.waProvider ||
    waApiKey !== initial.waApiKey ||
    waWebhookSecret !== initial.waWebhookSecret ||
    waFromNumber !== initial.waFromNumber;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      setApiKey("");
      setWaApiKey("");
      setWaWebhookSecret("");
      // The server refused to store this as on — reflect that, or the ticked
      // box would claim WhatsApp is live when it isn't.
      if (actionData.warning) setWaReplyEnabled(false);
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
    setWaReplyEnabled(initial.waReplyEnabled);
    setWaProvider(initial.waProvider);
    setWaApiKey(initial.waApiKey);
    setWaWebhookSecret(initial.waWebhookSecret);
    setWaFromNumber(initial.waFromNumber);
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
          waReplyEnabled,
          waProvider,
          waApiKey,
          waWebhookSecret,
          waFromNumber,
        }),
      },
      { method: "POST" },
    );
  };

  const isDoubleTick = waProvider === "doubletick";

  const handleTest = () => submit({ intent: "test", testQuestion }, { method: "POST" });
  const handleRotateToken = () => submit({ intent: "rotate-token" }, { method: "POST" });

  return (
    <Page>
      <TitleBar title="Automated Replies">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && !actionData?.warning && (
              <Banner tone="success">Settings saved successfully.</Banner>
            )}
            {/* Deliberately not on the auto-dismiss timer — this is the only
                thing telling the merchant WhatsApp didn't switch on. */}
            {actionData?.warning && (
              <Banner tone="warning" title="Saved, but WhatsApp replies are off">
                {actionData.warning}
              </Banner>
            )}
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
                  and never sent to the storefront. Storefront chats aren't saved. WhatsApp
                  conversations are kept for 24 hours so the assistant can follow the thread,
                  then deleted automatically.
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
                <Text as="h2" variant="headingMd">Reply on WhatsApp</Text>
                <Text as="p" tone="subdued">
                  When a customer messages your WhatsApp number, the assistant answers using
                  the same store information as the storefront chat. Replies sent within 24
                  hours of the customer's message are free on WhatsApp — you only pay for
                  Gemini usage.
                </Text>

                <Select
                  label="WhatsApp provider"
                  options={[
                    { label: "Interakt", value: "interakt" },
                    { label: "DoubleTick", value: "doubletick" },
                  ]}
                  value={waProvider}
                  onChange={setWaProvider}
                  helpText="Set separately from Back in Stock — you can use a different provider for each."
                />

                {isDoubleTick ? (
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p">
                        We set the webhook up in DoubleTick for you — there's nothing to paste
                        into their dashboard.
                      </Text>
                      <List type="number">
                        <List.Item>Paste your DoubleTick API key and sender number below.</List.Item>
                        <List.Item>Turn on <strong>Reply to WhatsApp messages</strong> and Save.</List.Item>
                      </List>
                    </BlockStack>
                  </Banner>
                ) : (
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p">
                        <strong>Needs Interakt's Growth or Advanced plan</strong> — inbound
                        webhooks aren't available on lower plans.
                      </Text>
                      <List type="number">
                        <List.Item>Paste your Interakt API key and webhook secret below (Interakt → Settings → Developer Settings).</List.Item>
                        <List.Item>Generate the webhook URL, then add it in Interakt's Developer Settings.</List.Item>
                        <List.Item>Save, then turn on <strong>Reply to WhatsApp messages</strong>.</List.Item>
                      </List>
                    </BlockStack>
                  </Banner>
                )}

                <TextField
                  label={isDoubleTick ? "DoubleTick API key" : "Interakt API key"}
                  value={waApiKey}
                  onChange={setWaApiKey}
                  autoComplete="off"
                  type="password"
                  placeholder={d.hasWaKey ? "••••••••" : "Paste your API key"}
                  helpText={
                    d.hasWaKey
                      ? `Saved key ending in ${d.waKeyPreview} — enter a new key to replace it.`
                      : isDoubleTick
                      ? "From DoubleTick → Settings → API key."
                      : "From Interakt → Settings → Developer Settings."
                  }
                />

                {isDoubleTick ? (
                  <TextField
                    label="Sender number"
                    value={waFromNumber}
                    onChange={setWaFromNumber}
                    autoComplete="off"
                    placeholder="+919999999999"
                    helpText="Your DoubleTick WhatsApp business number — replies are sent from it."
                  />
                ) : (
                  <TextField
                    label="Webhook secret"
                    value={waWebhookSecret}
                    onChange={setWaWebhookSecret}
                    autoComplete="off"
                    type="password"
                    placeholder={d.hasWaSecret ? "••••••••" : "Paste the secret key from Interakt"}
                    helpText={
                      d.hasWaSecret
                        ? "A secret is saved — enter a new one to replace it. Used to verify messages really came from Interakt."
                        : "Set in Interakt when you add the webhook. Without it, messages are rejected."
                    }
                  />
                )}

                {isDoubleTick ? (
                  d.hasWaAuth && d.webhookUrl ? (
                    <Text as="p" tone="subdued" variant="bodySm">
                      Webhook registered with DoubleTick. Saving again re-registers it — do
                      that if you change your sender number.
                    </Text>
                  ) : (
                    <Text as="p" tone="subdued" variant="bodySm">
                      The webhook is registered automatically when you save with replies
                      turned on.
                    </Text>
                  )
                ) : d.webhookUrl ? (
                  <BlockStack gap="200">
                    <TextField
                      label="Webhook URL"
                      value={d.webhookUrl}
                      onChange={() => {}}
                      autoComplete="off"
                      readOnly
                      selectTextOnFocus
                      helpText="Paste this into Interakt → Developer Settings → Webhooks. Keep it private — anyone with this URL and your secret could message your customers."
                    />
                    <InlineStack gap="200">
                      <Button onClick={handleRotateToken} loading={busy}>
                        Generate a new URL
                      </Button>
                      <Text as="span" tone="subdued" variant="bodySm">
                        The old URL stops working immediately — you'd need to update Interakt.
                      </Text>
                    </InlineStack>
                  </BlockStack>
                ) : (
                  <InlineStack gap="200" blockAlign="center">
                    <Button onClick={handleRotateToken} loading={busy}>
                      Generate webhook URL
                    </Button>
                    <Text as="span" tone="subdued" variant="bodySm">
                      Create the address Interakt will send messages to.
                    </Text>
                  </InlineStack>
                )}

                <Checkbox
                  label="Reply to WhatsApp messages"
                  helpText={
                    isDoubleTick
                      ? "Needs the API key and sender number above. Replies usually arrive within a minute."
                      : "Needs the API key, webhook secret and webhook URL above. Replies usually arrive within a minute."
                  }
                  checked={waReplyEnabled}
                  onChange={setWaReplyEnabled}
                />

                <Text as="p" tone="subdued" variant="bodySm">
                  Customers can send <strong>stop</strong>, <strong>agent</strong> or{" "}
                  <strong>human</strong> to pause the assistant so your team can take over in
                  your provider's inbox; <strong>start</strong> resumes it. Replying yourself
                  does not pause it automatically. Photos and voice notes are ignored, and
                  only Indian (+91) numbers are supported.
                </Text>
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
