/**
 * ACTUAL billed shipping cost from the carriers — for the P&L.
 *
 * This is deliberately SEPARATE from tracking.server.ts: tracking answers "where
 * is the parcel", this answers "what were we actually charged to ship it". They
 * hit different endpoints.
 *
 * ⚠️ VERIFY-FIRST — READ THIS BEFORE ENABLING:
 * The exact endpoint/field that returns the DEBITED freight (not a rate quote)
 * is not reliably documented for either carrier. Under the P&L's no-estimation
 * rule, until the real field is confirmed against the live account, these
 * functions return "pending" — NEVER a serviceability rate estimate. When you
 * verify the field (steps below), replace the marked bodies; the rest of the
 * P&L already consumes the { freightMinor, ... } | "pending" | null contract.
 *
 * How to verify (do this with a real, already-DELIVERED AWB on the live panel):
 *   Shiprocket: the freight is debited from the wallet at processing and shown
 *     in Wallet & Passbook. Candidate API sources to inspect:
 *       GET /v1/external/orders/show/{order_id}   → look for a `charges` /
 *         `freight_charges` block that equals the wallet DEBIT (not the rate).
 *       (or a passbook/transaction endpoint if exposed for your plan).
 *     Confirm the number matches the actual wallet debit before trusting it.
 *   Delhivery: billed freight appears in the invoice/billing API on
 *     one.delhivery.com (tier-dependent), not in /api/v1/packages/json (tracking
 *     only). Confirm the invoiced amount for a known AWB before trusting it.
 *
 * Every function returns paise (bigint) — never floats — via toMinor().
 */
import { toMinor } from "./pnl.server";

const SHIPROCKET_BASE_URL = "https://apiv2.shiprocket.in/v1/external";

export type Billing = {
  freightMinor: bigint;
  rtoMinor: bigint | null;
  codMinor: bigint | null;
  currency: string;
};

/** "pending" = shipment exists but not yet billed/verifiable → show Pending,
 *  never estimate. null = AWB not recognised by this carrier → try the next. */
export type BillingResult = Billing | "pending" | null;

/** Whether the actual-billed-freight lookup has been verified + enabled. Flip to
 *  true (per carrier) only after reconciling the returned figure against the
 *  real wallet debit / invoice. Until then the P&L shows shipping as "pending"
 *  rather than risk an estimate. */
const SHIPROCKET_BILLING_VERIFIED = false;
const DELHIVERY_BILLING_VERIFIED = false;

async function shiprocketToken(email: string, password: string): Promise<string | null> {
  try {
    const res = await fetch(`${SHIPROCKET_BASE_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && data?.token ? String(data.token) : null;
  } catch {
    return null;
  }
}

/**
 * Shiprocket billed freight for an AWB. Verify-gated: returns "pending" until
 * SHIPROCKET_BILLING_VERIFIED is turned on with a confirmed field mapping.
 */
export async function resolveShiprocketBilling(
  email: string,
  password: string,
  awb: string,
): Promise<BillingResult> {
  if (!SHIPROCKET_BILLING_VERIFIED) return "pending";
  if (!email || !password || !awb) return null;

  const token = await shiprocketToken(email, password);
  if (!token) return null;

  try {
    // ── VERIFY-FIRST: replace with the confirmed endpoint + field. ──────────
    // The AWB must first be resolved to a Shiprocket order/shipment id, then
    // the order-detail (or passbook) endpoint read for the DEBITED charge.
    // Example shape once confirmed:
    //   const res = await fetch(`${SHIPROCKET_BASE_URL}/orders/show/${orderId}`, {
    //     headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
    //   });
    //   const d = await res.json();
    //   const freight = d?.data?.charges?.freight_charges;  // <- CONFIRM this is the debit
    //   if (freight == null) return "pending";
    //   return {
    //     freightMinor: toMinor(freight),
    //     rtoMinor: d?.data?.charges?.rto_charges != null ? toMinor(d.data.charges.rto_charges) : null,
    //     codMinor: d?.data?.charges?.cod_charges != null ? toMinor(d.data.charges.cod_charges) : null,
    //     currency: "INR",
    //   };
    // ────────────────────────────────────────────────────────────────────────
    return "pending";
  } catch (e: any) {
    console.error("[carrier-billing] shiprocket:", String(e?.message || e).slice(0, 160));
    return null;
  }
}

/**
 * Delhivery billed freight for an AWB. Verify-gated the same way.
 */
export async function resolveDelhiveryBilling(
  apiToken: string,
  awb: string,
): Promise<BillingResult> {
  if (!DELHIVERY_BILLING_VERIFIED) return "pending";
  if (!apiToken || !awb) return null;

  try {
    // ── VERIFY-FIRST: replace with the confirmed invoice/billing endpoint. ──
    // /api/v1/packages/json is TRACKING only and must NOT be used for cost.
    // Use the one.delhivery.com invoice/billing API once confirmed, and map the
    // invoiced freight (not an estimate) through toMinor().
    // ────────────────────────────────────────────────────────────────────────
    return "pending";
  } catch (e: any) {
    console.error("[carrier-billing] delhivery:", String(e?.message || e).slice(0, 160));
    return null;
  }
}

/**
 * Resolve billed freight for an AWB, trying Shiprocket first (~70% of parcels),
 * then Delhivery. "pending" from either means known-but-not-billed-yet; null
 * from both means neither recognises the AWB.
 */
export async function resolveBilling(opts: {
  awb: string;
  carrierHint?: string;
  shiprocketEmail?: string;
  shiprocketPassword?: string;
  delhiveryApiKey?: string;
}): Promise<BillingResult> {
  const { awb, shiprocketEmail, shiprocketPassword, delhiveryApiKey } = opts;
  if (!awb) return null;

  const attempts: Array<() => Promise<BillingResult>> = [];
  if (shiprocketEmail && shiprocketPassword) {
    attempts.push(() => resolveShiprocketBilling(shiprocketEmail, shiprocketPassword, awb));
  }
  if (delhiveryApiKey) {
    attempts.push(() => resolveDelhiveryBilling(delhiveryApiKey, awb));
  }

  let sawPending = false;
  for (const attempt of attempts) {
    const r = await attempt();
    if (r && r !== "pending") return r; // an actual billed amount
    if (r === "pending") sawPending = true;
  }
  // Known to a carrier but not billed yet → pending; otherwise unrecognised.
  return sawPending ? "pending" : null;
}
