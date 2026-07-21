/**
 * LLM clients for the storefront AI chat ("Automated replies").
 *
 * The merchant supplies their own API key, so every call spends THEIR quota —
 * hence the hard input caps in the route. The key is read only here and in the
 * admin page; it never reaches /api/widgets or the browser.
 *
 * Two providers, because Gemini's free tier cannot run a support bot: it allows
 * 20 requests PER DAY, which one shopper exhausts in an afternoon. Groq's free
 * tier is 30 RPM / 1000 RPD / 12K TPM — in practice ~100+ replies a day once the
 * ~700-token system prompt is counted, which is 5x Gemini and actually usable.
 * Gemini stays supported for merchants who already have a key or pay for one.
 */

// gemini-2.0-flash was shut down on 2026-06-01 and now 404s. 2.5-flash is the
// current stable best-price-performance model. If this ever 404s again the
// error surfaces as "bad-model" so the cause is obvious in the admin Test.
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Caps are enforced server-side; the widget also trims, but never trust it.
export const MAX_MESSAGE_CHARS = 1000;
export const MAX_HISTORY_TURNS = 10;
export const MAX_HISTORY_CHARS = 4000;

export type ChatTurn = { role: "user" | "model"; text: string };

export type AiSettings = {
  knowledge: string;
  botName: string;
  supportEmail: string;
  supportUrl: string;
};

/** Where the answer will be rendered. Only the formatting rules differ. */
export type AiChannel = "web" | "whatsapp";

/**
 * Wrap the merchant's knowledge text in guardrails. The bot must answer only
 * from what the merchant wrote — inventing a returns window or a discount is
 * worse than saying "I don't know".
 *
 * `channel` changes ONLY the closing formatting rules: the web widget parses
 * markdown links into anchors, but WhatsApp has no markdown, so the same
 * instruction there would render a literal "[Returns](https://…)".
 */
/**
 * Pick the knowledge-base sections worth sending for this question.
 *
 * The knowledge base is the single biggest token cost: it rides on EVERY call,
 * and at ~2.4k chars it was ~670 of the ~1580 tokens a reply consumed — more
 * than the conversation history. Most of it is irrelevant to any one question:
 * a shopper asking about sizing does not need the returns process.
 *
 * Keyword match, not AI — an extra model call to save model calls would be
 * self-defeating. Sections are split on markdown headings, which is how these
 * knowledge bases are already written.
 *
 * Deliberately generous: any section that MIGHT be relevant is kept, and if
 * nothing matches (or the text has no headings) the whole thing is sent.
 *
 * Measured caveat: on paraphrased questions ("the shoes dont fit me",
 * "kitne din lagenge") no keyword matches and the FULL text is sent, so the
 * real-world saving is small. That is the correct trade — a partial
 * knowledge base produces wrong answers, which cost far more than tokens.
 * This only pays off on very large knowledge bases, hence the 4k floor.
 */
export function selectKnowledge(knowledge: string, question: string): string {
  const text = String(knowledge || "");
  // Only worth it for large knowledge bases. Below this the saving is small
  // and the risk of dropping a relevant section is not worth taking.
  if (text.length < 4000) return text;

  // Split on markdown headings, keeping the heading with its body.
  const parts = text.split(/\n(?=#{1,3}\s)/);
  if (parts.length < 3) return text;

  const q = question.toLowerCase();
  const words = q.match(/[a-z]{4,}/g) || [];
  if (!words.length) return text;

  // Always keep the preamble (anything before the first heading) — it usually
  // holds the brand rules and contact details that apply to every answer.
  const preamble = /^#{1,3}\s/.test(parts[0]) ? "" : parts.shift() || "";

  const scored = parts.map((section) => {
    const lower = section.toLowerCase();
    let score = 0;
    for (const w of words) if (lower.includes(w)) score++;
    return { section, score };
  });

  const hits = scored.filter((x) => x.score > 0);
  // No section matched: the question may be phrased unlike the source text, so
  // send everything rather than answer from a partial view.
  if (!hits.length) return text;

  hits.sort((a, b) => b.score - a.score);
  // Keep generously — a missed section produces a wrong answer, which costs
  // far more than the tokens saved.
  const kept = hits.slice(0, 8).map((x) => x.section);

  const out = [preamble, ...kept].filter(Boolean).join("\n").trim();
  // Never let "trimming" produce something larger than the original.
  return out.length < text.length ? out : text;
}

export function buildSystemPrompt(
  s: AiSettings,
  channel: AiChannel = "web",
  question?: string,
): string {
  const contact = [
    s.supportEmail ? `email ${s.supportEmail}` : "",
    s.supportUrl ? `or use ${s.supportUrl}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return [
    `You are ${s.botName || "Support"}, a customer support assistant for this online store.`,
    "",
    "=== STORE INFORMATION (your only source of truth) ===",
    (question ? selectKnowledge(s.knowledge, question) : s.knowledge) ||
      "(The merchant has not provided any store information yet.)",
    "",
    "=== RULES ===",
    "1. Answer ONLY from the store information above.",
    "2. If the answer isn't there, say you don't have that detail and point the shopper to support. Never guess or invent policies, prices, delivery dates, discount codes or stock levels.",
    "3. Keep replies short and conversational — two or three sentences where possible.",
    "4. Be warm and polite. If the shopper is upset, acknowledge it first.",
    "5. Never ask for payment card details, passwords or any sensitive personal information.",
    "6. Don't discuss competitors, and don't offer discounts that aren't listed above.",
    contact
      ? `7. For order-specific problems, complaints, payment issues or anything you cannot answer, tell them to contact the team: ${contact}.`
      : "7. For order-specific problems, complaints or payment issues, tell them to contact the store's support team.",
    "",
    ...(channel === "whatsapp"
      ? [
          "You are replying on WhatsApp. Reply in plain text with no markdown at all — markdown is not rendered there and would show as literal characters.",
          "Write any link as a bare URL on its own, e.g. https://example.com/returns. Only use URLs that appear in the store information above.",
          "Keep it to a few short lines; this is a phone screen.",
          "",
          "ESCALATION — you cannot see live order status, tracking events or courier updates, so you cannot resolve order-specific problems. When the customer has one (delayed or failed delivery, missing or damaged items, refund status) or is clearly frustrated:",
          "- Do NOT keep asking questions. At most ONE clarifying question in the whole conversation, and only if genuinely needed.",
          "- Never ask for anything already visible in the conversation — order numbers, tracking status, things they already told you. Re-asking reads as not listening and makes upset customers angrier.",
          "- Apologize once, say the team will take it from here, and end your reply with the exact token [HANDOFF] — nothing after it. This silences you for this customer so a human can take over without you interrupting.",
          "- Prefer escalating on the FIRST message of a complaint rather than after a back-and-forth. A fast handoff satisfies; an interrogation does not.",
        ]
      : [
          "Reply in plain text. Do not use markdown formatting, EXCEPT links.",
          "For any link, always use markdown with a short human label — [Returns portal](https://example.com/returns), never a bare URL and never 'click here'. Only link to URLs that appear in the store information above.",
        ]),
  ].join("\n");
}

/** Clamp history to the configured limits, newest turns kept. */
export function trimHistory(history: unknown): ChatTurn[] {
  if (!Array.isArray(history)) return [];
  const clean: ChatTurn[] = [];
  for (const raw of history) {
    const role = (raw as any)?.role === "model" ? "model" : "user";
    const text = String((raw as any)?.text || "").slice(0, MAX_MESSAGE_CHARS);
    if (text.trim()) clean.push({ role, text });
  }
  const recent = clean.slice(-MAX_HISTORY_TURNS);
  // Drop oldest turns until under the character budget.
  let total = recent.reduce((n, t) => n + t.text.length, 0);
  while (recent.length && total > MAX_HISTORY_CHARS) {
    total -= recent[0].text.length;
    recent.shift();
  }
  return recent;
}

const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export type AiProvider = "gemini" | "groq";
export type AiResult = { ok: true; text: string } | { ok: false; error: string };

/**
 * Groq (OpenAI-compatible chat completions).
 *
 * No thinking-token problem here — unlike Gemini 2.5, Llama emits its answer
 * directly, so max_tokens is purely reply length. 400 is generous for the two
 * or three lines the prompt asks for.
 */
export async function callGroq(opts: {
  apiKey: string;
  system: string;
  history: ChatTurn[];
  message: string;
}): Promise<AiResult> {
  const messages = [
    { role: "system", content: opts.system },
    // Gemini calls the assistant turn "model"; OpenAI-shaped APIs call it
    // "assistant". Same conversation, different vocabulary.
    ...opts.history.map((t) => ({
      role: t.role === "model" ? "assistant" : "user",
      content: t.text,
    })),
    { role: "user", content: opts.message },
  ];

  try {
    const res = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 400,
        top_p: 0.95,
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      // Log server-side only — an upstream body can echo the key back.
      const detail = await res.text().catch(() => "");
      console.error("[ai-replies] groq", GROQ_MODEL, res.status, detail.slice(0, 300));
      const error =
        res.status === 401 || res.status === 403
          ? "bad-key"
          : res.status === 429
          ? "rate-limited"
          : res.status === 404
          ? "bad-model"
          : "upstream";
      return { ok: false, error };
    }

    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text || !String(text).trim()) {
      console.error("[ai-replies] groq empty:", JSON.stringify(data).slice(0, 200));
      return { ok: false, error: "no-answer" };
    }
    return { ok: true, text: String(text).trim() };
  } catch (e: any) {
    console.error("[ai-replies] groq threw:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}

/** Provider-agnostic entry point. Every caller should use this, not the two above. */
export async function callAi(opts: {
  provider: string;
  apiKey: string;
  system: string;
  history: ChatTurn[];
  message: string;
}): Promise<AiResult> {
  const { provider, ...rest } = opts;
  return provider === "groq" ? callGroq(rest) : callGemini(rest);
}

export async function callGemini(opts: {
  apiKey: string;
  system: string;
  history: ChatTurn[];
  message: string;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const contents = [
    ...opts.history.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
    { role: "user", parts: [{ text: opts.message }] },
  ];

  try {
    const res = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(opts.apiKey)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        system_instruction: { parts: [{ text: opts.system }] },
        generationConfig: {
          temperature: 0.7,
          // 2.5-flash is a REASONING model: internal thinking is billed against
          // this budget before a single reply token is emitted. Measured ~350
          // thinking tokens for a simple question against a 2.4k-char knowledge
          // base, so 1024 left little headroom — a harder question exhausted it
          // and Gemini returned HTTP 200 with an EMPTY candidate and
          // finishReason MAX_TOKENS, which surfaced to shoppers as a generic
          // failure. Replies are capped at a few lines by the prompt, so the
          // extra budget is spent on thinking, not length.
          maxOutputTokens: 3072,
          // Cap the thinking itself so it can never crowd out the answer.
          thinkingConfig: { thinkingBudget: 1024 },
          topP: 0.95,
          topK: 40,
        },
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      // Log server-side only — the upstream body can echo the key back.
      const detail = await res.text().catch(() => "");
      console.error("[ai-replies] gemini", GEMINI_MODEL, res.status, detail.slice(0, 300));
      // 404 = the model id is gone/renamed (Google retires these). Distinct
      // from a key problem so the admin Test points at the real cause.
      // 429 and quota-exhausted 400s are NOT key problems — reporting them as
      // "bad-key" sent merchants hunting for a broken key when the real cause
      // was Gemini's free-tier rate limit, which clears on its own.
      const quota = /quota|rate.?limit|RESOURCE_EXHAUSTED|exceeded/i.test(detail);
      const error =
        res.status === 404
          ? "bad-model"
          : res.status === 429 || quota
          ? "rate-limited"
          : res.status === 400 || res.status === 403
          ? "bad-key"
          : "upstream";
      return { ok: false, error };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || !String(text).trim()) {
      // MAX_TOKENS with no text means thinking consumed the whole budget —
      // a config problem on our side, not a safety block, and worth telling
      // apart because the fix is different.
      const finish = data?.candidates?.[0]?.finishReason;
      console.error(
        "[ai-replies] empty candidate",
        finish,
        "thoughts=" + (data?.usageMetadata?.thoughtsTokenCount ?? "?"),
        JSON.stringify(data).slice(0, 200),
      );
      return { ok: false, error: finish === "MAX_TOKENS" ? "thinking-overflow" : "no-answer" };
    }
    return { ok: true, text: String(text).trim() };
  } catch (e: any) {
    console.error("[ai-replies] threw:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}
