/**
 * Gemini client for the storefront AI chat ("Automated replies").
 *
 * The merchant supplies their own API key, so every call spends THEIR quota —
 * hence the hard input caps in the route. The key is read only here and in the
 * admin page; it never reaches /api/widgets or the browser.
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

/**
 * Wrap the merchant's knowledge text in guardrails. The bot must answer only
 * from what the merchant wrote — inventing a returns window or a discount is
 * worse than saying "I don't know".
 */
export function buildSystemPrompt(s: AiSettings): string {
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
    s.knowledge || "(The merchant has not provided any store information yet.)",
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
    "Reply in plain text. Do not use markdown formatting, EXCEPT links.",
    "For any link, always use markdown with a short human label — [Returns portal](https://example.com/returns), never a bare URL and never 'click here'. Only link to URLs that appear in the store information above.",
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
          maxOutputTokens: 1024,
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
      const error =
        res.status === 404
          ? "bad-model"
          : res.status === 400 || res.status === 403
          ? "bad-key"
          : "upstream";
      return { ok: false, error };
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text || !String(text).trim()) {
      // Usually a safety block or an empty candidate.
      console.error("[ai-replies] empty candidate:", JSON.stringify(data).slice(0, 300));
      return { ok: false, error: "no-answer" };
    }
    return { ok: true, text: String(text).trim() };
  } catch (e: any) {
    console.error("[ai-replies] threw:", String(e?.message || e).slice(0, 200));
    return { ok: false, error: e?.name === "TimeoutError" ? "timeout" : "network" };
  }
}
