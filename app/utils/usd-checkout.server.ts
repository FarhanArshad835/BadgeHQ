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

// ── Order persistence + Shopify write-back ────────────────────────────────────

/** Remember a USD checkout attempt (cart snapshot) at Razorpay-order time, so the
 *  return handler can write the Shopify order without re-pricing. */
export async function recordUsdOrder(opts: {
  razorpayOrderId: string;
  amountUsdCents: number;
  inrToUsdRate: number;
  lineItems: Array<{ variantId: string; quantity: number; inrBasePaise: bigint; title?: string }>;
}) {
  const lineItemsJson = JSON.stringify(
    opts.lineItems.map((li) => ({
      variantId: li.variantId,
      quantity: li.quantity,
      inrBasePaise: li.inrBasePaise.toString(), // BigInt -> string for JSON
      title: li.title,
    })),
  );
  await prisma.usdOrder.upsert({
    where: { razorpayOrderId: opts.razorpayOrderId },
    create: {
      razorpayOrderId: opts.razorpayOrderId,
      amountUsdCents: opts.amountUsdCents,
      inrToUsdRate: opts.inrToUsdRate,
      lineItemsJson,
      status: "created",
    },
    update: { amountUsdCents: opts.amountUsdCents, inrToUsdRate: opts.inrToUsdRate, lineItemsJson },
  });
}

/**
 * On a verified USD payment, create the matching order in Shopify so it shows in
 * Orders (inventory decrements, fulfillment works). The money actually moved
 * through Razorpay, not Shopify — so we mark the order PAID and stamp the Razorpay
 * payment id + USD total in the order note. Idempotent: if we already wrote a
 * Shopify order for this Razorpay order, we return it without creating a duplicate.
 */
export async function writeShopifyOrderForPayment(opts: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
}): Promise<{ ok: true; orderName: string | null; duplicate: boolean } | { ok: false; reason: string }> {
  const rec = await prisma.usdOrder.findUnique({ where: { razorpayOrderId: opts.razorpayOrderId } });
  if (!rec) return { ok: false, reason: "No record for this order." };
  if (rec.status === "shopify_written" && rec.shopifyOrderId) {
    return { ok: true, orderName: rec.shopifyOrderName, duplicate: true };
  }

  const cfg = await getUsdConfig();
  if (!cfg.shopDomain || !cfg.shopifyAdminToken) {
    await prisma.usdOrder.update({
      where: { razorpayOrderId: opts.razorpayOrderId },
      data: { status: "failed", errorNote: "Shopify not configured." },
    });
    return { ok: false, reason: "Shopify not configured." };
  }

  let parsed: Array<{ variantId: string; quantity: number }> = [];
  try {
    parsed = JSON.parse(rec.lineItemsJson);
  } catch {
    parsed = [];
  }
  const lineItems = parsed
    .map((li) => ({ variantId: li.variantId, quantity: Math.max(1, Number(li.quantity) || 1) }))
    .filter((li) => li.variantId);
  if (!lineItems.length) {
    await prisma.usdOrder.update({
      where: { razorpayOrderId: opts.razorpayOrderId },
      data: { status: "failed", errorNote: "No line items to write." },
    });
    return { ok: false, reason: "No line items to write." };
  }

  const usd = (rec.amountUsdCents / 100).toFixed(2);
  const note =
    `Paid in USD via Razorpay International (outside Shopify checkout).\n` +
    `USD charged: $${usd}\n` +
    `Razorpay order: ${opts.razorpayOrderId}\n` +
    `Razorpay payment: ${opts.razorpayPaymentId}`;

  const mutation = `
    mutation UsdOrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }`;
  const variables = {
    order: {
      lineItems: lineItems.map((li) => ({ variantId: li.variantId, quantity: li.quantity })),
      financialStatus: "PAID",
      currency: "USD",
      note,
      tags: ["usd-checkout", "razorpay-international"],
    },
    // Don't email the customer from Shopify — Razorpay already confirmed payment.
    options: { sendReceipt: false, sendFulfillmentReceipt: false },
  };

  try {
    const url = `https://${cfg.shopDomain}/admin/api/2025-01/graphql.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": cfg.shopifyAdminToken },
      body: JSON.stringify({ query: mutation, variables }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({} as any));
    const errs = body?.data?.orderCreate?.userErrors ?? [];
    const created = body?.data?.orderCreate?.order;
    if (!res.ok || errs.length || !created?.id) {
      const reason =
        (errs.length ? errs.map((e: any) => e.message).join("; ") : null) ||
        body?.errors?.[0]?.message ||
        `Shopify HTTP ${res.status}`;
      await prisma.usdOrder.update({
        where: { razorpayOrderId: opts.razorpayOrderId },
        data: { status: "failed", errorNote: String(reason).slice(0, 300) },
      });
      return { ok: false, reason: String(reason).slice(0, 300) };
    }
    await prisma.usdOrder.update({
      where: { razorpayOrderId: opts.razorpayOrderId },
      data: {
        status: "shopify_written",
        razorpayPaymentId: opts.razorpayPaymentId,
        shopifyOrderId: created.id,
        shopifyOrderName: created.name ?? null,
        errorNote: null,
      },
    });
    return { ok: true, orderName: created.name ?? null, duplicate: false };
  } catch (e: any) {
    await prisma.usdOrder.update({
      where: { razorpayOrderId: opts.razorpayOrderId },
      data: { status: "failed", errorNote: String(e?.message || e).slice(0, 300) },
    });
    return { ok: false, reason: "Couldn't reach Shopify: " + String(e?.message || e).slice(0, 200) };
  }
}
