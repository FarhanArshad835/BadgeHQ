/**
 * Return URL after a successful Razorpay USD payment. Verifies the payment
 * signature (proves the success is real, not forged), then shows a confirmation.
 *
 * TODO (next milestone): on verified payment, create the paid order in Shopify
 * via the Admin API so it's tracked / inventory decrements / fulfillment works.
 * For now it confirms the USD charge succeeded.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { getUsdConfig, verifyRazorpaySignature } from "../utils/usd-checkout.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const orderId = url.searchParams.get("order_id") || "";
  const paymentId = url.searchParams.get("payment_id") || "";
  const signature = url.searchParams.get("signature") || "";

  const cfg = await getUsdConfig();
  const valid =
    orderId && paymentId && signature &&
    verifyRazorpaySignature(orderId, paymentId, signature, cfg.razorpayKeySecret);

  const html = valid
    ? `<h1 style="font-family:system-ui">Payment received ✓</h1>
       <p style="font-family:system-ui">Your USD payment was successful. Order ${paymentId}.</p>
       <p style="font-family:system-ui"><a href="https://sixbyeleven.com">Back to store</a></p>`
    : `<h1 style="font-family:system-ui">Could not verify payment</h1>
       <p style="font-family:system-ui">If you were charged, contact support with reference ${paymentId || "N/A"}.</p>`;

  return new Response(
    `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="max-width:640px;margin:10vh auto;padding:0 20px">${html}</body>`,
    { status: valid ? 200 : 400, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
};
