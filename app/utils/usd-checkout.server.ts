/**
 * "Pay in USD" checkout for six-by-eleven — charges real USD via Razorpay
 * International, OUTSIDE Shopify's native checkout (Razorpay can't be the Shopify
 * gateway for USD). India customers are untouched (they keep using Shopflo); only
 * US customers get this flow.
 *
 * Pricing rule (confirmed): the customer pays the INR base price × markup (×4 by
 * default — "₹1000 item ⇒ ₹4000"), converted to USD at the live rate. So
 *   usdMinorCents = round( (inrBasePaise/100 × markup) × (USD per 1 INR) × 100 ).
 *
 * All money math is integer (paise in, cents out) — no float drift on the charge.
 * Secrets (Razorpay keys, Shopify token) are server-side only.
 */
import prisma from "../db.server";

const RATE_TTL_MS = 6 * 60 * 60 * 1000; // refresh the INR→USD rate at most every 6h

export async function getUsdConfig() {
  const existing = await prisma.usdCheckout.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return prisma.usdCheckout.create({ data: { id: "default" } });
}

/**
 * Live INR→USD rate (USD per 1 INR), cached in the config row so we don't hit the
 * rate API on every checkout. Free source, no key. Falls back to the last cached
 * value if the fetch fails (never blocks a checkout on a rate hiccup).
 */
export async function getInrToUsdRate(): Promise<number> {
  const cfg = await getUsdConfig();
  const fresh =
    cfg.inrToUsdRate > 0 &&
    cfg.rateFetchedAt &&
    Date.now() - cfg.rateFetchedAt.getTime() < RATE_TTL_MS;
  if (fresh) return cfg.inrToUsdRate;

  try {
    const res = await fetch("https://open.er-api.com/v6/latest/INR", { signal: AbortSignal.timeout(8000) });
    const body = await res.json();
    const rate = Number(body?.rates?.USD);
    if (rate && rate > 0) {
      await prisma.usdCheckout.update({
        where: { id: "default" },
        data: { inrToUsdRate: rate, rateFetchedAt: new Date() },
      });
      return rate;
    }
  } catch {
    // fall through to cached value
  }
  return cfg.inrToUsdRate > 0 ? cfg.inrToUsdRate : 0;
}

/**
 * Convert an INR base amount (in paise) to the USD charge in CENTS, applying the
 * markup and live rate. Integer math throughout.
 *   inrBasePaise=100000 (₹1000), markupBps=40000 (×4), rate=0.0104 →
 *   ₹4000 × 0.0104 = $41.6 → 4160 cents.
 */
export function inrPaiseToUsdCents(inrBasePaise: bigint, markupBps: number, inrToUsdRate: number): number {
  if (!inrToUsdRate || inrToUsdRate <= 0) return 0;
  // markedUpInrPaise = base × markupBps/10000  (40000 = ×4)
  const markedUpPaise = (inrBasePaise * BigInt(markupBps)) / 10000n;
  // USD cents = (markedUpPaise/100 INR) × rate(USD/INR) × 100 cents
  //           = markedUpPaise × rate   (paise→INR ÷100, then ×100 cents cancel)
  const cents = Number(markedUpPaise) * inrToUsdRate;
  return Math.round(cents);
}

export type UsdLineItem = {
  variantId: string; // Shopify variant id (numeric or gid)
  quantity: number;
  inrBasePaise: bigint; // the item's INR base price in paise (unit price)
  title?: string;
};

/** Total USD cents for a cart of line items. */
export function cartUsdCents(items: UsdLineItem[], markupBps: number, rate: number): number {
  let cents = 0;
  for (const li of items) {
    cents += inrPaiseToUsdCents(li.inrBasePaise, markupBps, rate) * (li.quantity || 1);
  }
  return cents;
}

// ── Razorpay ────────────────────────────────────────────────────────────────

/** Create a Razorpay Order in USD. amountCents is the total USD charge in cents. */
export async function createRazorpayUsdOrder(opts: {
  keyId: string;
  keySecret: string;
  amountCents: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<{ ok: true; orderId: string; amount: number } | { ok: false; reason: string }> {
  const { keyId, keySecret, amountCents, receipt, notes } = opts;
  if (!keyId || !keySecret) return { ok: false, reason: "Razorpay keys not configured." };
  if (!amountCents || amountCents < 50) return { ok: false, reason: "Amount too small." };

  try {
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString("base64");
    const res = await fetch("https://api.razorpay.com/v1/orders", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ amount: amountCents, currency: "USD", receipt, notes: notes ?? {} }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body?.id) {
      const msg = body?.error?.description || `Razorpay HTTP ${res.status}`;
      return { ok: false, reason: String(msg).slice(0, 200) };
    }
    return { ok: true, orderId: body.id, amount: body.amount };
  } catch (e: any) {
    return { ok: false, reason: "Couldn't reach Razorpay: " + String(e?.message || e).slice(0, 160) };
  }
}

/** Verify a Razorpay payment signature (HMAC-SHA256 of `${orderId}|${paymentId}`
 *  with the key secret). Prevents a forged success callback. */
export function verifyRazorpaySignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  try {
    const crypto = require("node:crypto");
    const expected = crypto.createHmac("sha256", keySecret).update(`${orderId}|${paymentId}`).digest("hex");
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  } catch {
    return false;
  }
}
