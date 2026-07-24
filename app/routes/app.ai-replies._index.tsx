import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
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
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { buildSystemPrompt, callAi } from "../utils/ai-replies.server";
import { CLAUDE_MODELS } from "../utils/ai-models";
import { generateWebhookToken, registerDoubleTickWebhook } from "../utils/whatsapp-ai.server";

const POSITIONS = ["bottom-right", "bottom-left"];

/** Parse a numeric setting, falling back on anything unparseable and clamping
 *  to a sane range — these fields spend the merchant's LLM quota. */
function intIn(v: unknown, fallback: number, min: number, max: number): number {
  const n = parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Turn a job's internal state into what actually happened to the customer.
 *
 * The raw status is about the queue, not the person: a rate-limited message is
 * stored as "pending" because the cron will retry it, which read as "on its
 * way" next to an error saying rate-limited. If the daily quota is gone that
 * message may wait hours, so "pending" was actively misleading.
 */
function outcomeOf(status: string, error: string): { label: string; tone: "success" | "critical" | "attention" | "warning" } {
  if (status === "done") return { label: "answered", tone: "success" };

  const throttled = error.includes("rate-limited") || error.includes("quota-exhausted");
  if (throttled) {
    // Distinguishable because the fix differs: one clears in a minute, the
    // other needs a bigger plan or tomorrow.
    return error.includes("quota-exhausted")
      ? { label: "waiting — daily quota used up", tone: "warning" }
      : { label: "waiting — AI rate limit", tone: "warning" };
  }
  if (status === "failed") {
    if (error.includes("outside-window")) return { label: "too late (24h window closed)", tone: "critical" };
    if (error.includes("opted-out")) return { label: "not sent — thread muted", tone: "attention" };
    if (error.includes("human-replied")) return { label: "not sent — your team replied", tone: "attention" };
    if (error.includes("too-old")) return { label: "not sent — too old to be useful", tone: "attention" };
    if (error.includes("bad-key")) return { label: "not sent — API key rejected", tone: "critical" };
    if (error.includes("daily-limit")) return { label: "not sent — your daily cap", tone: "attention" };
    return { label: "not sent", tone: "critical" };
  }
  if (status === "claimed") return { label: "sending…", tone: "attention" };
  return { label: "queued", tone: "attention" };
}

/** Explicit "empty the knowledge base" signal, since blank now means "keep". */
const CLEAR_KNOWLEDGE = "__badgehq_clear_knowledge__";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const [s, replied, skipped] = await Promise.all([
    prisma.aiReplySettings.findUnique({ where: { shop } }),
    // Who the bot actually answered, newest first.
    prisma.whatsAppReplyJob.findMany({
      where: { shop },
      orderBy: { updatedAt: "desc" },
      take: 60,
      select: { phone: true, message: true, status: true, error: true, updatedAt: true },
    }),
    // And who it deliberately did not — the more useful half.
    prisma.whatsAppSkip.findMany({
      where: { shop },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { phone: true, reason: true, preview: true, createdAt: true },
    }),
  ]);

  // Stored as bare 10 digits (see toIndianTenDigit); shown with +91 so the
  // number can be copied straight into a provider search or a dialler.
  const fmtPhone = (p: string) => (p.length === 10 ? `+91 ${p}` : p);

  // Group by number rather than listing every message. One customer sending
  // seven messages produced seven rows scattered among other people's, which
  // made it hard to see that a single person was being failed repeatedly.
  //
  // The row carries the WORST status of the thread (failed beats pending beats
  // done): a customer whose first five messages failed should not look
  // resolved because the sixth happened to succeed.
  const RANK: Record<string, number> = { failed: 3, claimed: 2, pending: 2, done: 1 };
  const byPhone = new Map<
    string,
    { phone: string; count: number; status: string; error: string; last: string; at: Date }
  >();
  for (const j of replied) {
    const key = j.phone;
    const row = byPhone.get(key);
    if (!row) {
      byPhone.set(key, {
        phone: fmtPhone(j.phone),
        count: 1,
        status: j.status,
        error: j.error,
        last: j.message.slice(0, 60),
        at: j.updatedAt,
      });
      continue;
    }
    row.count++;
    // `replied` is newest-first, so the first message seen is the latest one
    // and must stay as `last`; only the status escalates.
    if ((RANK[j.status] ?? 0) > (RANK[row.status] ?? 0)) {
      row.status = j.status;
      row.error = j.error;
    }
  }

  return json({
    activity: {
      // Every message, so an expanded row can show the individual history.
      messages: replied.map((j) => ({
        phone: fmtPhone(j.phone),
        message: j.message.slice(0, 60),
        status: j.status,
        error: j.error,
        at: j.updatedAt,
      })),
      replied: Array.from(byPhone.values()),
      skipped: skipped.map((k) => ({
        phone: fmtPhone(k.phone),
        reason: k.reason,
        preview: k.preview,
        at: k.createdAt,
      })),
    },
    isEnabled: s?.isEnabled ?? false,
    aiProvider: s?.aiProvider ?? "gemini",
    aiModel: s?.aiModel ?? "",
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
    // Live parcel tracking. The Shiprocket password is write-only like every
    // other secret — the client only learns whether one is saved.
    waTrackingEnabled: s?.waTrackingEnabled ?? false,
    waShiprocketEmail: s?.waShiprocketEmail ?? "",
    hasShiprocketPassword: Boolean(s?.waShiprocketPassword),
    waHandoffNotifyNumber: s?.waHandoffNotifyNumber ?? "",
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
      model: s.aiModel,
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
          : result.error === "quota-exhausted"
          ? isGroq
            ? "Groq's DAILY token quota is used up (free tier: 100,000 tokens, roughly 40 replies at current settings). It resets at 00:00 UTC. Queued replies are held and sent automatically once it does — enable billing at console.groq.com for a higher ceiling."
            : "Gemini's daily quota is used up. It resets at 00:00 Pacific. Enable billing in Google AI Studio for a higher ceiling."
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
  const newShiprocketPassword = String(data.waShiprocketPassword || "").trim();
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
      aiProvider:
        data.aiProvider === "groq"
          ? "groq"
          : data.aiProvider === "claude"
          ? "claude"
          : "gemini",
      // Only Claude has selectable models; store the id only when it's a known
      // Claude model, otherwise "" so the provider uses its own default.
      aiModel:
        data.aiProvider === "claude" &&
        CLAUDE_MODELS.some((m) => m.id === data.aiModel)
          ? data.aiModel
          : "",
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
      // Live parcel tracking. Email isn't a secret, so it's stored plainly; the
      // password follows the write-only rule below (blank keeps the saved one).
      waTrackingEnabled: Boolean(data.waTrackingEnabled),
      waShiprocketEmail: text(data.waShiprocketEmail, "", 200),
      // Team number pinged on handoff. Digits/+ only, like the sender number.
      waHandoffNotifyNumber: String(data.waHandoffNotifyNumber || "")
        .trim()
        .replace(/[^\d+]/g, "")
        .slice(0, 20),
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
      create: {
        shop,
        apiKey: newKey,
        waApiKey: newWaKey,
        waWebhookSecret: newWaSecret,
        waShiprocketPassword: newShiprocketPassword,
        ...values,
      },
      update: {
        ...(newKey ? { apiKey: newKey } : {}),
        ...(newWaKey ? { waApiKey: newWaKey } : {}),
        ...(newWaSecret ? { waWebhookSecret: newWaSecret } : {}),
        ...(newShiprocketPassword ? { waShiprocketPassword: newShiprocketPassword } : {}),
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
  // Re-runs the loader in place: refreshes the activity list without a full
  // page reload, so unsaved edits in the settings fields survive.
  const revalidator = useRevalidator();
  const busy = nav.state === "submitting";

  const initial = {
    enabled: d.isEnabled,
    aiProvider: d.aiProvider,
    aiModel: d.aiModel,
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
    waTrackingEnabled: d.waTrackingEnabled,
    waShiprocketEmail: d.waShiprocketEmail,
    waShiprocketPassword: "",
    waHandoffNotifyNumber: d.waHandoffNotifyNumber,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [aiProvider, setAiProvider] = useState(initial.aiProvider);
  const [aiModel, setAiModel] = useState(initial.aiModel);
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
  const [waTrackingEnabled, setWaTrackingEnabled] = useState(initial.waTrackingEnabled);
  const [waShiprocketEmail, setWaShiprocketEmail] = useState(initial.waShiprocketEmail);
  const [waShiprocketPassword, setWaShiprocketPassword] = useState(initial.waShiprocketPassword);
  const [waHandoffNotifyNumber, setWaHandoffNotifyNumber] = useState(initial.waHandoffNotifyNumber);
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
  // Which grouped number is expanded to show its individual messages.
  const [expanded, setExpanded] = useState<string | null>(null);

  const isDirty =
    enabled !== initial.enabled ||
    aiProvider !== initial.aiProvider ||
    aiModel !== initial.aiModel ||
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
    waFromNumber !== initial.waFromNumber ||
    waTrackingEnabled !== initial.waTrackingEnabled ||
    waShiprocketEmail !== initial.waShiprocketEmail ||
    waShiprocketPassword !== initial.waShiprocketPassword ||
    waHandoffNotifyNumber !== initial.waHandoffNotifyNumber;

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
    setAiModel(initial.aiModel);
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
    setWaTrackingEnabled(initial.waTrackingEnabled);
    setWaShiprocketEmail(initial.waShiprocketEmail);
    setWaShiprocketPassword(initial.waShiprocketPassword);
    setWaHandoffNotifyNumber(initial.waHandoffNotifyNumber);
  };

  const handleSave = () => {
    submit(
      {
        data: JSON.stringify({
          isEnabled: enabled,
          aiProvider,
          aiModel,
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
          waTrackingEnabled,
          waShiprocketEmail,
          waShiprocketPassword,
          waHandoffNotifyNumber,
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
                    { label: "Anthropic Claude — paid, most capable", value: "claude" },
                  ]}
                  value={aiProvider}
                  onChange={setAiProvider}
                  helpText="Each provider needs its own key. Changing this means pasting a new one."
                />

                {aiProvider === "claude" && (
                  <Select
                    label="Claude model"
                    options={CLAUDE_MODELS.map((m) => ({ label: m.label, value: m.id }))}
                    value={aiModel || CLAUDE_MODELS[0].id}
                    onChange={setAiModel}
                    helpText="Haiku is the cheapest and handles most support chat; step up for harder questions."
                  />
                )}

                {aiProvider === "gemini" && (
                  <Banner tone="warning">
                    Gemini&apos;s free tier allows only <strong>20 requests per day</strong>, which a
                    storefront uses up almost immediately. Either enable billing in Google AI Studio,
                    or switch to Groq, whose free tier handles far more.
                  </Banner>
                )}

                {aiProvider === "claude" && (
                  <Banner tone="info">
                    Claude has <strong>no free tier</strong> — your Anthropic key needs credit.
                    It&apos;s the most capable option; Groq stays free if cost matters more than nuance.
                  </Banner>
                )}

                <TextField
                  label={
                    aiProvider === "groq"
                      ? "Groq API key"
                      : aiProvider === "claude"
                      ? "Anthropic API key"
                      : "Gemini API key"
                  }
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
                      : aiProvider === "claude"
                      ? "From console.anthropic.com (needs billing set up). Stored securely — never sent to your storefront."
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

                <Divider />
                <Text as="h3" variant="headingSm">Handoff alert</Text>
                <TextField
                  label="Notify this number on handoff"
                  value={waHandoffNotifyNumber}
                  onChange={setWaHandoffNotifyNumber}
                  autoComplete="off"
                  placeholder="+919999999999"
                  helpText="Whenever the bot hands a chat to a human — a complaint, a 'talk to agent' request, or a tracking question it couldn't answer — it sends a WhatsApp alert here with the customer's number and last message. Leave blank for no alert. Use a team member's or a WhatsApp group's number."
                />

                {isDoubleTick && (
                  <>
                    <Divider />
                    <Text as="h3" variant="headingSm">Live order tracking</Text>
                    <Checkbox
                      label="Answer 'where's my order?' with live courier status"
                      helpText="When a customer asks about their order, the bot reads the AWB from the conversation and checks Shiprocket or Delhivery for the live status, then answers in their own words. If no AWB is in the thread, it hands over as usual."
                      checked={waTrackingEnabled}
                      onChange={setWaTrackingEnabled}
                    />
                    <TextField
                      label="Shiprocket email"
                      value={waShiprocketEmail}
                      onChange={setWaShiprocketEmail}
                      autoComplete="off"
                      placeholder="you@yourstore.com"
                      helpText="The login email for your Shiprocket panel — used only to read tracking status."
                    />
                    <TextField
                      label="Shiprocket password"
                      value={waShiprocketPassword}
                      onChange={setWaShiprocketPassword}
                      autoComplete="off"
                      type="password"
                      placeholder={d.hasShiprocketPassword ? "••••••••" : "Your Shiprocket password"}
                      helpText={
                        d.hasShiprocketPassword
                          ? "A password is saved — enter a new one to replace it. Stored securely, never sent to your storefront."
                          : "Stored securely, server-side only. Needed to read Shiprocket tracking."
                      }
                    />
                    <Text as="p" tone="subdued" variant="bodySm">
                      Delhivery tracking reuses the API key from your{" "}
                      <strong>Delivery Estimate</strong> settings — nothing to add here. Leave
                      Shiprocket blank if you only ship Delhivery.
                    </Text>
                  </>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Recent WhatsApp activity</Text>
                  <Button
                    onClick={() => revalidator.revalidate()}
                    loading={revalidator.state === "loading"}
                    variant="tertiary"
                  >
                    Sync
                  </Button>
                </InlineStack>
                <Text as="p" tone="subdued">
                  A snapshot from when this page loaded — press Sync for the latest.
                  Search a number in your provider's inbox to open the full conversation.
                </Text>

                {d.activity.replied.length === 0 && d.activity.skipped.length === 0 ? (
                  <Banner tone="info">
                    No inbound WhatsApp messages yet. Once customers message your business
                    number, replies and skips both appear here.
                  </Banner>
                ) : (
                  <BlockStack gap="500">
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Customers ({d.activity.replied.length}) ·{" "}
                        {d.activity.messages.length} messages
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        {d.activity.replied.filter((r) => r.status === "done").length} answered ·{" "}
                        {d.activity.replied.filter((r) => r.error.includes("rate-limited") || r.error.includes("quota-exhausted")).length}{" "}
                        waiting on the AI limit ·{" "}
                        {d.activity.replied.filter((r) => r.status === "failed" && !r.error.includes("rate-limited") && !r.error.includes("quota-exhausted")).length}{" "}
                        not sent. The badge shows a customer's WORST outcome, so a thread that
                        failed earlier stays visible. Click a row with several messages to
                        expand it. <strong>Waiting</strong> rows retry by themselves — a
                        per-minute limit clears in about a minute, a daily quota at midnight.
                      </Text>
                      {d.activity.replied.length === 0 ? (
                        <Text as="p" tone="subdued" variant="bodySm">Nothing yet.</Text>
                      ) : (
                        // Scrolls within the card rather than pushing the
                        // settings below it off the page — 60 rows is normal.
                        <div style={{ maxHeight: 280, overflowY: "auto", paddingRight: 8 }}>
                        <BlockStack gap="200">
                        {d.activity.replied.map((r) => {
                          const open = expanded === r.phone;
                          const thread = d.activity.messages.filter((m) => m.phone === r.phone);
                          return (
                            <BlockStack key={r.phone} gap="100">
                              <div
                                onClick={() => setExpanded(open ? null : r.phone)}
                                style={{ cursor: r.count > 1 ? "pointer" : "default" }}
                              >
                                <InlineStack gap="200" blockAlign="center" wrap={false}>
                                  <div style={{ minWidth: 130 }}>
                                    <Text as="span" variant="bodySm" fontWeight="semibold">
                                      {r.phone}
                                    </Text>
                                  </div>
                                  <Badge tone={outcomeOf(r.status, r.error).tone}>
                                    {outcomeOf(r.status, r.error).label}
                                  </Badge>
                                  {r.count > 1 && (
                                    <Text as="span" variant="bodySm" tone="subdued">
                                      {open ? "▾" : "▸"} {r.count} messages
                                    </Text>
                                  )}
                                  <Text as="span" variant="bodySm" tone="subdued">
                                    {r.last}
                                  </Text>
                                </InlineStack>
                              </div>

                              {open &&
                                thread.map((m, j) => (
                                  <div key={j} style={{ paddingLeft: 24 }}>
                                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                                      <Badge tone={outcomeOf(m.status, m.error).tone}>
                                        {outcomeOf(m.status, m.error).label}
                                      </Badge>
                                      <Text as="span" variant="bodySm" tone="subdued">
                                        {m.message}
                                      </Text>
                                    </InlineStack>
                                  </div>
                                ))}
                            </BlockStack>
                          );
                        })}
                        </BlockStack>
                        </div>
                      )}
                    </BlockStack>

                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">
                        Not replied ({d.activity.skipped.length})
                      </Text>
                      <Text as="p" tone="subdued" variant="bodySm">
                        <strong>muted</strong> — your team took the thread over (after a
                        handoff, or the customer sent stop/agent). Clears automatically 12
                        hours after an automatic handoff; a customer's own stop lasts until
                        they send start.{" "}
                        <strong>rate-limited</strong> — more than 20 messages from that
                        number in an hour.{" "}
                        <strong>non-indian</strong> — only +91 numbers are supported.
                      </Text>
                      {d.activity.skipped.length === 0 ? (
                        <Text as="p" tone="subdued" variant="bodySm">Nothing skipped.</Text>
                      ) : (
                        <div style={{ maxHeight: 220, overflowY: "auto", paddingRight: 8 }}>
                        <BlockStack gap="200">
                        {d.activity.skipped.map((k, i) => (
                          <InlineStack key={i} gap="200" blockAlign="center" wrap={false}>
                            <div style={{ minWidth: 120 }}>
                              <Text as="span" variant="bodySm" fontWeight="semibold">{k.phone}</Text>
                            </div>
                            <Badge tone="attention">{k.reason}</Badge>
                            <Text as="span" variant="bodySm" tone="subdued">{k.preview}</Text>
                          </InlineStack>
                        ))}
                        </BlockStack>
                        </div>
                      )}
                    </BlockStack>
                  </BlockStack>
                )}
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
