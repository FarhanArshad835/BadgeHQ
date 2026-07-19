/**
 * WhatsApp template clients — Interakt and DoubleTick.
 *
 * The merchant supplies their own provider API key, so sends spend THEIR quota.
 * The key is read only here and in the admin page — it never reaches
 * /api/widgets or the browser, exactly like the Delhivery token.
 *
 * Both providers only accept pre-approved templates, and Meta rejects a send
 * whose body variables are empty — callers must pass non-empty values (see the
 * clean() helper in back-in-stock.server.ts).
 *
 * Use sendWhatsAppTemplate() to route by the merchant's chosen provider.
 */

const INTERAKT_URL = "https://api.interakt.ai/v1/public/message/";
const TIMEOUT_MS = 8000;

/**
 * Normalise an Indian mobile to the bare 10 digits Interakt expects.
 * Accepts "+91 98765 43210", "098765 43210", "9876543210". Returns "" when the
 * result isn't a valid Indian mobile (must start 6-9).
 */
export function toIndianTenDigit(input: unknown): string {
  let d = String(input ?? "").replace(/\D/g, "");
  if (d.length > 10 && d.startsWith("91")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  return /^[6-9]\d{9}$/.test(d) ? d : "";
}

export type InteraktResult = { ok: true; messageId?: string } | { ok: false; error: string };

const DOUBLETICK_URL = "https://public.doubletick.io/whatsapp/message/template";

/**
 * Send one approved template via DoubleTick.
 *
 * Differs from Interakt: the key goes in Authorization verbatim (no "Basic"),
 * numbers are international format (+91…), body variables are
 * templateData.body.placeholders, and a `from` sender number is required.
 */
export async function sendDoubleTickTemplate(opts: {
  apiKey: string;
  phone: string;
  fromNumber: string;
  templateName: string;
  languageCode?: string;
  bodyValues: string[];
  headerImageUrl?: string;
  buttonUrlSuffix?: string;
}): Promise<InteraktResult> {
  const ten = toIndianTenDigit(opts.phone);
  if (!ten) return { ok: false, error: "invalid-phone" };
  if (!opts.apiKey) return { ok: false, error: "no-api-key" };
  if (!opts.templateName) return { ok: false, error: "no-template" };
  if (!opts.fromNumber) return { ok: false, error: "no-sender-number" };

  const to = "+91" + ten;
  const from = opts.fromNumber.startsWith("+")
    ? opts.fromNumber
    : "+" + opts.fromNumber.replace(/\D/g, "");

  const payload = {
    messages: [
      {
        content: {
          language: opts.languageCode || "en",
          templateName: opts.templateName,
          templateData: {
            ...(opts.headerImageUrl
              ? { header: { type: "IMAGE", mediaUrl: opts.headerImageUrl } }
              : {}),
            body: { placeholders: opts.bodyValues.map((v) => (v == null ? "" : String(v))) },
            ...(opts.buttonUrlSuffix
              ? { buttons: [{ type: "URL", parameter: opts.buttonUrlSuffix }] }
              : {}),
          },
        },
        from,
        to,
      },
    ],
  };

  try {
    const res = await fetch(DOUBLETICK_URL, {
      method: "POST",
      headers: {
        Authorization: opts.apiKey, // raw key, no scheme prefix
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error page */
    }

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        console.error("[doubletick] auth", res.status, text.slice(0, 200));
        return { ok: false, error: "auth-failed (check the DoubleTick API key)" };
      }
      const detail = String(body?.message || body?.error || text || `http-${res.status}`).slice(0, 300);
      console.error("[doubletick] send failed", res.status, detail);
      return { ok: false, error: detail };
    }

    // A 2xx can still carry a per-message failure.
    const first = Array.isArray(body?.messages) ? body.messages[0] : null;
    const status = String(first?.status || body?.status || "").toUpperCase();
    if (status && status !== "SENT" && status !== "QUEUED" && status !== "ACCEPTED") {
      const detail = String(first?.reason || first?.error || status).slice(0, 300);
      console.error("[doubletick] rejected", detail);
      return { ok: false, error: detail };
    }

    return { ok: true, messageId: first?.messageId ?? body?.messageId };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? "timeout" : String(e?.message || e).slice(0, 200);
    console.error("[doubletick] threw", msg);
    return { ok: false, error: msg };
  }
}

/** WhatsApp caps a text body at 4096 chars; leave room rather than be truncated by Meta. */
const MAX_TEXT_CHARS = 4000;

/**
 * Send a free-text (non-template) WhatsApp message via Interakt.
 *
 * Unlike a template this needs no Meta pre-approval, but it is only allowed
 * inside the 24-hour customer service window — i.e. when the shopper has
 * messaged us in the last 24h. That is exactly the AI-reply case, and such
 * messages are free of charge. Sending outside the window is rejected upstream;
 * we surface that rather than silently falling back to a paid template.
 */
export async function sendInteraktText(opts: {
  apiKey: string;
  phone: string;
  message: string;
  callbackData?: string;
}): Promise<InteraktResult> {
  const phoneNumber = toIndianTenDigit(opts.phone);
  if (!phoneNumber) return { ok: false, error: "invalid-phone" };
  if (!opts.apiKey) return { ok: false, error: "no-api-key" };

  const message = String(opts.message ?? "").trim().slice(0, MAX_TEXT_CHARS);
  if (!message) return { ok: false, error: "empty-message" };

  const payload = {
    countryCode: "+91",
    phoneNumber,
    callbackData: opts.callbackData ?? "badgehq-ai",
    type: "Text",
    data: { message },
  };

  try {
    const res = await fetch(INTERAKT_URL, {
      method: "POST",
      headers: {
        // Already base64 — send verbatim, never re-encode.
        Authorization: `Basic ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error page — keep the raw text for the log
    }

    // Interakt can return HTTP 200 carrying result:false.
    if (!res.ok || body?.result === false) {
      if (res.status === 401 || res.status === 403) {
        console.error("[interakt] text auth", res.status, text.slice(0, 200));
        return { ok: false, error: "auth-failed (check the Interakt API key)" };
      }
      const detail = String(body?.message || text || `http-${res.status}`).slice(0, 300);
      // Outside the 24h window is expected-ish, so name it rather than logging
      // it as a generic failure.
      const outsideWindow = /24\s*hour|session|window|expired/i.test(detail);
      console.error("[interakt] text send failed", res.status, detail);
      return { ok: false, error: outsideWindow ? `outside-window: ${detail}` : detail };
    }

    return { ok: true, messageId: body?.id ?? body?.messageId };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? "timeout" : String(e?.message || e).slice(0, 200);
    console.error("[interakt] text threw", msg);
    return { ok: false, error: msg };
  }
}

/** Provider-agnostic send. Routes to whichever provider the merchant configured. */
export async function sendWhatsAppTemplate(opts: {
  provider: string;
  apiKey: string;
  phone: string;
  templateName: string;
  languageCode?: string;
  fromNumber?: string;
  bodyValues: string[];
  headerImageUrl?: string;
  buttonUrlSuffix?: string;
  callbackData?: string;
}): Promise<InteraktResult> {
  if (opts.provider === "doubletick") {
    return sendDoubleTickTemplate({
      apiKey: opts.apiKey,
      phone: opts.phone,
      fromNumber: opts.fromNumber || "",
      templateName: opts.templateName,
      languageCode: opts.languageCode,
      bodyValues: opts.bodyValues,
      headerImageUrl: opts.headerImageUrl,
      buttonUrlSuffix: opts.buttonUrlSuffix,
    });
  }
  return sendInteraktTemplate({
    apiKey: opts.apiKey,
    phone: opts.phone,
    templateName: opts.templateName,
    languageCode: opts.languageCode,
    bodyValues: opts.bodyValues,
    headerImageUrl: opts.headerImageUrl,
    buttonUrlSuffix: opts.buttonUrlSuffix,
    callbackData: opts.callbackData,
  });
}

/**
 * Send one approved template. Never throws — always resolves to a result, so a
 * messaging outage can never take down a webhook or a shopper request.
 */
export async function sendInteraktTemplate(opts: {
  apiKey: string;
  phone: string;
  templateName: string;
  languageCode?: string;
  bodyValues: string[];
  headerImageUrl?: string;
  /** Value for a dynamic URL button's {{1}} — the suffix after the template's
   *  fixed prefix, NOT a whole URL. */
  buttonUrlSuffix?: string;
  callbackData?: string;
}): Promise<InteraktResult> {
  const phoneNumber = toIndianTenDigit(opts.phone);
  if (!phoneNumber) return { ok: false, error: "invalid-phone" };
  if (!opts.apiKey) return { ok: false, error: "no-api-key" };
  if (!opts.templateName) return { ok: false, error: "no-template" };

  const payload = {
    countryCode: "+91",
    phoneNumber,
    callbackData: opts.callbackData ?? opts.templateName,
    type: "Template",
    template: {
      name: opts.templateName,
      languageCode: opts.languageCode || "en",
      // Interakt requires strings; a null/undefined would be rejected by Meta.
      bodyValues: opts.bodyValues.map((v) => (v == null ? "" : String(v))),
      // Media header (image): a single-element list holding the media URL.
      ...(opts.headerImageUrl ? { headerValues: [opts.headerImageUrl] } : {}),
      // Dynamic URL button. Keys are 0-based button indexes; we only ever have
      // one button, so index "0".
      ...(opts.buttonUrlSuffix ? { buttonValues: { "0": [opts.buttonUrlSuffix] } } : {}),
    },
  };

  try {
    const res = await fetch(INTERAKT_URL, {
      method: "POST",
      headers: {
        // The Interakt secret is ALREADY base64 — send it verbatim, never re-encode.
        Authorization: `Basic ${opts.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const text = await res.text().catch(() => "");
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error page — keep the raw text for the log
    }

    if (!res.ok || body?.result === false) {
      if (res.status === 401 || res.status === 403) {
        console.error("[interakt] auth", res.status, text.slice(0, 200));
        return {
          ok: false,
          error: "auth-failed (check the API key; API access needs Interakt's Growth plan or above)",
        };
      }
      const detail = String(body?.message || text || `http-${res.status}`).slice(0, 300);
      console.error("[interakt] send failed", res.status, detail);
      return { ok: false, error: detail };
    }

    return { ok: true, messageId: body?.id ?? body?.messageId };
  } catch (e: any) {
    const msg = e?.name === "TimeoutError" ? "timeout" : String(e?.message || e).slice(0, 200);
    console.error("[interakt] threw", msg);
    return { ok: false, error: msg };
  }
}
