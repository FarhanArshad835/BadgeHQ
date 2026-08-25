/**
 * Public read-only endpoint: the current INR->USD rate the USD checkout uses, so
 * the storefront can DISPLAY the same $ figure it will CHARGE. Returns the exact
 * rate (USD per 1 INR) and the markup, so on-page display and the Razorpay charge
 * never drift. Cached rate (6h TTL) — cheap, safe to call on every page.
 */
import { json } from "@remix-run/node";
import { getInrToUsdRate, getUsdConfig } from "../utils/usd-checkout.server";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "public, max-age=1800", // 30 min at the edge; rate moves slowly
};

export const loader = async ({ request }: { request: Request }) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  const cfg = await getUsdConfig();
  const rate = await getInrToUsdRate();
  return json(
    {
      ok: rate > 0,
      inrToUsdRate: rate, // USD per 1 INR, e.g. 0.01044
      markupBps: cfg.markupBps, // 40000 = x4
    },
    { headers: CORS },
  );
};
