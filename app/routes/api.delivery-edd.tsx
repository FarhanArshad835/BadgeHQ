/**
 * Public delivery-estimate endpoint (Delhivery Expected TAT).
 * Called from the storefront via the Cloudflare Worker proxy:
 *   /api/delivery-edd?shop={shop}.myshopify.com&pincode=NNNNNN
 *
 * Responses (widget contract):
 *   200 { serviceable: true, etaDate: "2026-07-17", etaText: "Fri, 17 Jul" }
 *   200 { serviceable: false }
 *   404 { error: "not-configured" }  — widget stays silent
 *   502 { error: "upstream" }        — widget shows "try again"
 *
 * The merchant's Delhivery token lives only in Postgres and this server —
 * never in the response, the worker, or the browser.
 */
import type { LoaderFunctionArgs, ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import {
  DELHIVERY_BASES,
  computeEtaDate,
  fetchDelhiveryTat,
  formatEta,
} from "../utils/delivery-eta.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle CORS preflight
export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json({ error: "Method not allowed" }, { status: 405, headers: CORS_HEADERS });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "";
  const pincode = (url.searchParams.get("pincode") || "").trim();

  if (!shop) {
    return json({ error: "missing-shop" }, { status: 400, headers: CORS_HEADERS });
  }
  if (!/^\d{6}$/.test(pincode)) {
    return json({ error: "invalid-pincode" }, { status: 400, headers: CORS_HEADERS });
  }

  const settings = await prisma.deliverySettings.findUnique({ where: { shop } });
  if (
    !settings ||
    !settings.isEnabled ||
    !settings.apiToken ||
    !/^\d{6}$/.test(settings.originPin)
  ) {
    // Setup pending — 404 keeps the widget silent. The worker caches 4xx
    // for only 5s, so enabling in admin takes effect almost immediately.
    return json({ error: "not-configured" }, { status: 404, headers: CORS_HEADERS });
  }

  let data: any;
  try {
    data = await fetchDelhiveryTat({
      base: DELHIVERY_BASES[settings.environment] || DELHIVERY_BASES.staging,
      token: settings.apiToken,
      originPin: settings.originPin,
      destinationPin: pincode,
    });
  } catch {
    // Upstream failure — 502 is never cached by the worker.
    return json({ error: "upstream" }, { status: 502, headers: CORS_HEADERS });
  }

  const tat = data && data.success && data.data ? data.data.tat : null;
  const payload =
    typeof tat === "number" && tat >= 0
      ? { serviceable: true, ...formatEta(computeEtaDate(tat, settings.bufferDays)) }
      : { serviceable: false };

  return json(payload, {
    headers: {
      ...CORS_HEADERS,
      // 6h edge cache per shop+pincode URL — the worker fronts this, so
      // Vercel only sees cache misses.
      "Cache-Control": "public, max-age=3600, s-maxage=21600, stale-while-revalidate=600",
    },
  });
};
