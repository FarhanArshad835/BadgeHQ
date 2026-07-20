/**
 * Public AI chat endpoint for the storefront widget.
 *   POST /api/ai-reply  { shop, message, history }
 *
 * The merchant's Gemini key stays server-side; the widget only ever learns
 * whether the feature is on. Input is capped here (not in the browser) because
 * every call spends the merchant's quota.
 *
 * Responses:
 *   200 { ok: true, text }
 *   200 { enabled: false }   — feature off / no key; widget stays quiet
 *   200 { ok: false, text }  — friendly fallback, never a raw upstream error
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  MAX_MESSAGE_CHARS,
  buildSystemPrompt,
  callAi,
  trimHistory,
} from "../utils/ai-replies.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const NO_STORE = { ...CORS_HEADERS, "Cache-Control": "no-store" };

const FALLBACK =
  "Sorry — I can't answer that right now. Please try again in a moment.";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json({ error: "Method not allowed" }, { status: 405, headers: NO_STORE });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: NO_STORE });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }

  const shop = String(body?.shop || "").trim();
  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
    return json({ error: "bad-shop" }, { status: 400, headers: NO_STORE });
  }

  const message = String(body?.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) {
    return json({ error: "empty-message" }, { status: 400, headers: NO_STORE });
  }

  const settings = await prisma.aiReplySettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled || !settings.apiKey) {
    return json({ enabled: false }, { status: 200, headers: NO_STORE });
  }

  const result = await callAi({
    provider: settings.aiProvider,
    apiKey: settings.apiKey,
    system: buildSystemPrompt(settings),
    history: trimHistory(body?.history),
    message,
  });

  if (!result.ok) {
    // Deliberately generic: upstream errors can contain the API key.
    const text =
      settings.supportEmail || settings.supportUrl
        ? `Sorry — I can't answer that right now. Please contact us${
            settings.supportEmail ? ` at ${settings.supportEmail}` : ""
          }.`
        : FALLBACK;
    return json({ ok: false, text }, { headers: NO_STORE });
  }

  return json({ ok: true, text: result.text }, { headers: NO_STORE });
};
