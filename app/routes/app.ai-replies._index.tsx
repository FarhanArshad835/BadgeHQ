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
  Badge,
  List,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { buildSystemPrompt, callAi } from "../utils/ai-replies.server";
import { generateWebhookToken, registerDoubleTickWebhook } from "../utils/whatsapp-ai.server";

const POSITIONS = ["bottom-right", "bottom-left"];

/** Parse a numeric setting, falling back on anything unparseable and clamping
 *  to a sane range — these fields spend the merchant's LLM quota. */
function intIn(v: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Explicit "empty the knowledge base" signal, since blank now means "keep". */
const CLEAR_KNOWLEDGE = "__badgehq_clear_knowledge__";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const s = await prisma.aiReplySettings.findUnique({ where: { shop: session.shop } });
  return json({
    isEnabled: s?.isEnabled ?? false,
    aiProvider: s?.aiProvider ?? "gemini",
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
    // What is actually STORED, so the page can state plainly whether WhatsApp
    // replies are live. Without this a merchant who ticked everything has no way
    // to tell a saved config from one the server refused.
    waReplyEnabled: s?.waReplyEnabled ?? false,
    waProvider: s?.waProvider ?? "interakt",
    // Cost controls. Sent as strings so the number fields stay editable while
    // the merchant is mid-typing (a bare number would coerce "" back to 0).
    waDailyLimit: String(s?.waDailyLimit ?? 2000),
    waThreadRecent: String(s?.waThreadRecent ?? 20),
    waThreadOpening: String(s?.waThreadOpening ?? 4),
    waThreadLineChars: String(s?.waThreadLineChars ?? 400),
    waThreadTotalChars: String(s?.waThreadTotalChars ?? 4000),
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
    if (!s?.apiKey) return json({ testError: "Save your API key first." });
    const question = String(formData.get("testQuestion") || "").trim() || "What is your return policy?";
    const result = await callAi({
      provider: s.aiProvider,
      apiKey: s.apiKey,
      system: buildSystemPrompt(s, "web", question),
      history: [],
      message: question.slice(0, 1000),
    });
    if (result.ok) return json({ testResult: result.text });
    const isGroq = s.aiProvider === "groq";
    const name = isGroq ? "Groq" : "Gemini";
    return json({
      testError:
        result.error === "bad-key"
          ? `${name} rejected the API key. Check it's a valid key from ${
              isGroq ? "console.groq.com" : "Google AI Studio"
            }.`
          : result.error === "bad-model"
          ? `${name} no longer offers the model this app requests (providers retire older models). This needs an app update — your API key is fine.`
          : result.error === "rate-limited"
          ? isGroq
            ? "Groq is rate-limiting this key. The free tier allows 30 requests a minute — wait a moment and try again."
            : "Gemini is rate-limiting this key. The free tier allows only 20 requests PER DAY, which a storefront exhausts almost immediately — switch to Groq above, or enable billing in Google AI Studio."
          : result.error === "timeout"
          ? `${name} didn't respond in time. Try again.`
          : `Couldn't reach ${name}. Check the key and try again.`,
    });
  }

  // The only way to empty the knowledge base, now that a blank field means
  // "keep". Confirmed in the UI before it gets here.
  if (formData.get("intent") === "clear-knowledge") {
    await prisma.aiReplySettings.update({
      where: { shop },
      data: { knowledge: "" },
    });
    await bumpConfigVersion(shop);
    return json({ success: true });
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
  //
  // Registered ONCE, not on every save. DoubleTick's register endpoint creates a
  // new webhook per call — it does not replace by URL — so re-saving used to pile
  // up duplicates that each deliver the same message. (Harmless downstream,
  // since the unique (shop, providerMessageId) collapses them to one reply, but
  // it wasted a request per duplicate and cluttered their dashboard.)
  //
  // waWebhookAuth is the marker: it exists only after a successful registration.
  // Changing the sender number needs a re-register, so that forces one too.
  let waWebhookToken = existing?.waWebhookToken || "";
  let waWebhookAuth = existing?.waWebhookAuth || "";
  const alreadyRegistered =
    Boolean(existing?.waWebhookAuth) &&
    existing?.waProvider === "doubletick" &&
    existing?.waFromNumber === waFromNumber;
  if (wantsWa && !waBlocked && waProvider === "doubletick" && !alreadyRegistered) {
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
      aiProvider: data.aiProvider === "groq" ? "groq" : "gemini",
      // Never store "on" when it can't work — the cron would drop every job as
      // permanently failed and the merchant would just see silence.
      waReplyEnabled: wantsWa && !waBlocked,
      waProvider,
      waFromNumber,
      waWebhookToken,
      waWebhookAuth,
      // Cost controls, clamped server-side: a stray keystroke here spends the
      // merchant's LLM quota, and 0 in a thread field would send no context at
      // all, which reads to a shopper as a bot that ignores them.
      waDailyLimit: intIn(data.waDailyLimit, 2000, 0, 100000),
      waThreadRecent: intIn(data.waThreadRecent, 20, 1, 100),
      waThreadOpening: intIn(data.waThreadOpening, 4, 0, 20),
      waThreadLineChars: intIn(data.waThreadLineChars, 400, 40, 2000),
      waThreadTotalChars: intIn(data.waThreadTotalChars, 4000, 200, 20000),
      // Blank means "keep what's saved", the same rule the API keys follow.
      // Without this, one save submitted from a stale or not-yet-hydrated form
      // silently wiped the whole knowledge base, and the bot kept answering
      // "I don't have that detail" with no indication why. Clearing it
      // deliberately is done with the Clear button, which sends a sentinel.
      knowledge:
        data.knowledge === CLEAR_KNOWLEDGE
          ? ""
          : String(data.knowledge ?? "").trim()
          ? String(data.knowledge).slice(0, 20000)
          : existing?.knowledge ?? "",
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
    aiProvider: d.aiProvider,
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
    waDailyLimit: d.waDailyLimit,
    waThreadRecent: d.waThreadRecent,
    waThreadOpening: d.waThreadOpening,
    waThreadLineChars: d.waThreadLineChars,
    waThreadTotalChars: d.waThreadTotalChars,
    waApiKey: "",
    waWebhookSecret: "",
    waFromNumber: d.waFromNumber,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [aiProvider, setAiProvider] = useState(initial.aiProvider);
  const [waReplyEnabled, setWaReplyEnabled] = useState(initial.waReplyEnabled);
  const [waProvider, setWaProvider] = useState(initial.waProvider);
  const [waDailyLimit, setWaDailyLimit] = useState(initial.waDailyLimit);
  const [waThreadRecent, setWaThreadRecent] = useState(initial.waThreadRecent);
  const [waThreadOpening, setWaThreadOpening] = useState(initial.waThreadOpening);
  const [waThreadLineChars, setWaThreadLineChars] = useState(initial.waThreadLineChars);
  const [waThreadTotalChars, setWaThreadTotalChars] = useState(initial.waThreadTotalChars);
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
    aiProvider !== initial.aiProvider ||
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
    waDailyLimit !== initial.waDailyLimit ||
    waThreadRecent !== initial.waThreadRecent ||
    waThreadOpening !== initial.waThreadOpening ||
    waThreadLineChars !== initial.waThreadLineChars ||
    waThreadTotalChars !== initial.waThreadTotalChars ||
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
    setAiProvider(initial.aiProvider);
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
    setWaDailyLimit(initial.waDailyLimit);
    setWaThreadRecent(initial.waThreadRecent);
    setWaThreadOpening(initial.waThreadOpening);
    setWaThreadLineChars(initial.waThreadLineChars);
    setWaThreadTotalChars(initial.waThreadTotalChars);
    setWaApiKey(initial.waApiKey);
    setWaWebhookSecret(initial.waWebhookSecret);
    setWaFromNumber(initial.waFromNumber);
  };

  const handleSave = () => {
    submit(
      {
        data: JSON.stringify({
          isEnabled: enabled,
          aiProvider,
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
          waDailyLimit,
          waThreadRecent,
          waThreadOpening,
          waThreadLineChars,
          waThreadTotalChars,
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
                    Get a free API key from console.groq.com (no card needed), or from Google AI
                    Studio if you prefer Gemini.
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
                <Select
                  label="AI provider"
                  options={[
                    { label: "Groq — free, recommended", value: "groq" },
                    { label: "Google Gemini", value: "gemini" },
                  ]}
                  value={aiProvider}
                  onChange={setAiProvider}
                  helpText="Each provider needs its own key. Changing this means pasting a new one."
                />

                {aiProvider === "gemini" && (
                  <Banner tone="warning">
                    Gemini&apos;s free tier allows only <strong>20 requests per day</strong>, which a
                    storefront uses up almost immediately. Either enable billing in Google AI Studio,
                    or switch to Groq, whose free tier handles far more.
                  </Banner>
                )}

                <TextField
                  label={aiProvider === "groq" ? "Groq API key" : "Gemini API key"}
                  value={apiKey}
                  onChange={setApiKey}
                  autoComplete="off"
                  type="password"
                  placeholder={
                    d.hasKey
                      ? `Saved key ending in ${d.keyPreview} — enter a new key to replace it`
                      : "Paste your API key"
                  }
                  helpText={
                    aiProvider === "groq"
                      ? "Free from console.groq.com — no card needed. Stored securely, never sent to your storefront."
                      : "From Google AI Studio. Stored securely — never sent to your storefront."
                  }
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Store information</Text>
                  {/* From the loader, so it reflects what's actually stored —
                      the one signal that the bot has anything to answer from. */}
                  <Badge tone={d.knowledge.length ? "success" : "critical"}>
                    {d.knowledge.length
                      ? `${d.knowledge.length} characters saved`
                      : "Empty — the assistant can't answer anything"}
                  </Badge>
                </InlineStack>
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
                  helpText="Plain text. Keep it accurate — the assistant repeats what you write here. Leaving this blank keeps your saved text; use Clear to empty it."
                />
                {d.knowledge.length > 0 && (
                  <InlineStack gap="200" blockAlign="center">
                    <Button
                      tone="critical"
                      variant="plain"
                      onClick={() => {
                        if (window.confirm("Delete all saved store information? The assistant will stop answering questions.")) {
                          submit({ intent: "clear-knowledge" }, { method: "POST" });
                        }
                      }}
                    >
                      Clear saved store information
                    </Button>
                  </InlineStack>
                )}
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

                {/* Reads from what's SAVED, never from the form state — the
                    point is to show what the server actually has. */}
                <Banner tone={d.waReplyEnabled ? "success" : "warning"}>
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="semibold">
                      {d.waReplyEnabled
                        ? "WhatsApp replies are live."
                        : "WhatsApp replies are not running."}
                    </Text>
                    <Text as="p" variant="bodySm">
                      Saved: {d.waProvider === "doubletick" ? "DoubleTick" : "Interakt"}
                      {" · "}
                      API key {d.hasWaKey ? `ending ${d.waKeyPreview}` : "not saved"}
                      {d.waProvider === "doubletick"
                        ? ` · sender ${d.waFromNumber || "not saved"} · webhook ${
                            d.hasWaAuth ? "registered" : "not registered"
                          }`
                        : ` · webhook secret ${d.hasWaSecret ? "saved" : "not saved"}`}
                    </Text>
                  </BlockStack>
                </Banner>

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
                      Webhook registered with DoubleTick. It's registered once, not on
                      every save — changing your sender number registers a new one.
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
                <Text as="h2" variant="headingMd">Cost controls</Text>
                <Text as="p" tone="subdued">
                  Every reply sends your store information plus recent conversation history to
                  the AI, and that history is what stops the bot asking things the customer has
                  already answered. These limits cap what one reply can cost. Raise them for
                  better answers, lower them to stretch a free tier.
                </Text>

                <TextField
                  label="Maximum replies per day"
                  type="number"
                  value={waDailyLimit}
                  onChange={setWaDailyLimit}
                  autoComplete="off"
                  helpText="Counts replies, not conversations — one thread often runs 8 to 20 replies. 2000 covers roughly 250 conversations a day. Set 0 for no limit."
                />

                <InlineStack gap="400" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Recent messages to include"
                      type="number"
                      value={waThreadRecent}
                      onChange={setWaThreadRecent}
                      autoComplete="off"
                      helpText="Newest messages sent with each reply."
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Opening messages to keep"
                      type="number"
                      value={waThreadOpening}
                      onChange={setWaThreadOpening}
                      autoComplete="off"
                      helpText="From the start of a long thread, where the order number usually is. 0 to skip."
                    />
                  </div>
                </InlineStack>

                <InlineStack gap="400" wrap={false}>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Characters per message"
                      type="number"
                      value={waThreadLineChars}
                      onChange={setWaThreadLineChars}
                      autoComplete="off"
                      helpText="Longer messages are trimmed to this."
                    />
                  </div>
                  <div style={{ flex: 1 }}>
                    <TextField
                      label="Total history characters"
                      type="number"
                      value={waThreadTotalChars}
                      onChange={setWaThreadTotalChars}
                      autoComplete="off"
                      helpText="Overall ceiling. ~3.6 characters is 1 token."
                    />
                  </div>
                </InlineStack>

                <Banner tone="info">
                  Roughly{" "}
                  <strong>
                    {Math.round(
                      (Number(waThreadTotalChars) || 0) / 3.6 +
                        (d.knowledge.length || 0) / 3.6 +
                        580,
                    )}{" "}
                    tokens
                  </strong>{" "}
                  per reply at these settings, with your {d.knowledge.length}-character store
                  information. A thread with {waThreadRecent} replies costs roughly{" "}
                  {Math.round(
                    ((Number(waThreadTotalChars) || 0) / 3.6 +
                      (d.knowledge.length || 0) / 3.6 +
                      580) *
                      (Number(waThreadRecent) || 1) *
                      0.6,
                  ).toLocaleString()}{" "}
                  tokens — history grows as the thread does, so later replies cost more than
                  the first.
                </Banner>
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
