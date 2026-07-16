/**
 * Buyer-facing order-cancel endpoint for the checkout / customer-account UI
 * extension (extensions/order-actions-ui). Unlike the app-proxy route
 * order-actions.tsx (classic theme account page), this surface is reached by a
 * Shopify UI extension, which authenticates with a SESSION TOKEN (JWT), not the
 * app proxy + logged_in_customer_id.
 *
 * Auth: authenticate.public.checkout(request) verifies the JWT and gives us
 *   sessionToken.dest = shop, sessionToken.sub = customer gid (present ONLY
 *   when the buyer is logged in; absent for guests on the thank-you page).
 *
 * Authorization for the cancel:
 *   - Logged-in buyer  -> checkOwnership(order, sub) must be "owner".
 *   - Guest (thank-you) -> allow only a FRESH (<= GUEST_WINDOW_MS), unfulfilled,
 *     cancelScope-eligible order. A stranger is very unlikely to know a fresh
 *     order's gid, and only already-cancellable orders qualify.
 *
 * The Delhivery/PCD address path is untouched; this only cancels.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import {
  cancelOrder,
  checkOwnership,
  findOrderById,
  getEligibility,
} from "../utils/order-actions.server";

const UNPAID_STATUSES = ["PENDING", "AUTHORIZED", "EXPIRED"];

// Guests may only cancel very recently created orders (limits abuse from a
// leaked/guessed order gid).
const GUEST_WINDOW_MS = 60 * 60 * 1000; // 60 minutes

// CORS preflight for the checkout/customer-account extension. The browser
// sends an unauthenticated OPTIONS before the real POST/GET (because of the
// Authorization + Content-Type headers). authenticate.public.checkout throws
// 410 on a tokenless request, which fails the preflight and makes the real
// request "Failed to fetch" — so we answer OPTIONS ourselves, first.
const CORS_PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

function preflightIfOptions(request: Request): Response | null {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS });
  }
  return null;
}

// One endpoint serves BOTH the thank-you page (checkout session token) and the
// new-customer-accounts order page (customer-account session token). The two
// tokens verify with different helpers, so try each. Whichever succeeds gives
// { sessionToken, cors }. authenticate.public.* THROWS a Response (401/410)
// with NO CORS headers on a bad token — surfacing as "Failed to fetch" — so we
// catch and return a CORS-safe JSON error instead.
async function authOrCorsError(request: Request) {
  const customerAccount = (authenticate.public as any)["customer-account"];
  const attempts = [
    () => authenticate.public.checkout(request.clone()),
    ...(typeof customerAccount === "function" ? [() => customerAccount(request.clone())] : []),
  ];

  let lastStatus = 401;
  for (const attempt of attempts) {
    try {
      const ctx = await attempt();
      return { ctx };
    } catch (e) {
      if (e instanceof Response) lastStatus = e.status;
    }
  }
  return {
    errorResponse: json(
      { error: "auth-failed", status: lastStatus },
      { status: 200, headers: { ...CORS_PREFLIGHT_HEADERS, "Cache-Control": "no-store" } },
    ),
  };
}

// TEMP: any unhandled exception becomes a Remix 500 with NO CORS headers,
// which the extension can only see as "Failed to fetch". Catch everything and
// return the real message (CORS-safe) so the crash is diagnosable on-screen.
async function corsSafe(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (e: any) {
    // Put the message in `error` itself — that's what the extension displays.
    // `enabled:false` makes the eligibility GET parse as "unknown" (button
    // stays active) instead of "blocked", so the POST can run and surface
    // this same message on click.
    return json(
      { enabled: false, error: "server: " + String(e?.message || e).slice(0, 160) },
      { status: 200, headers: { ...CORS_PREFLIGHT_HEADERS, "Cache-Control": "no-store" } },
    );
  }
}

// GET ?orderId=gid -> eligibility for THIS order, so the extension can show a
// greyed-out disabled Cancel button on cancelled/fulfilled/prepaid orders
// instead of hiding it. Also serves the CORS preflight when no orderId given.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const pre = preflightIfOptions(request);
  if (pre) return pre;
  return corsSafe(() => loaderImpl(request));
};

async function loaderImpl(request: Request): Promise<Response> {
  const auth = await authOrCorsError(request);
  if (auth.errorResponse) return auth.errorResponse;
  const { cors, sessionToken } = auth.ctx!;

  const url = new URL(request.url);
  const orderId = url.searchParams.get("orderId") || "";
  if (!orderId) return cors(json({ ok: true })); // no-op

  const shop = String(sessionToken.dest || "").replace(/^https?:\/\//, "");
  const customerGid = sessionToken.sub ? String(sessionToken.sub) : null;
  if (!shop) return cors(json({ error: "no-shop" }, { status: 400 }));

  const settings = await prisma.orderManageSettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled) return cors(json({ enabled: false }));

  const { admin } = await unauthenticated.admin(shop);
  const order = await findOrderById(admin, orderId);
  if (!order) return cors(json({ error: "order-not-found" }, { status: 404 }));

  // Same authorization as the cancel action.
  if (customerGid) {
    const bareId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");
    if (checkOwnership(order, bareId) !== "owner") {
      return cors(json({ error: "not-owner" }, { status: 403 }));
    }
  } else {
    const created = order.createdAt ? Date.parse(order.createdAt) : NaN;
    const fresh = Number.isFinite(created) && Date.now() - created <= GUEST_WINDOW_MS;
    if (!fresh) return cors(json({ error: "not-authorized" }, { status: 403 }));
  }

  const { cancellable, reason } = getEligibility(order, settings);
  return cors(
    json({ enabled: true, allowCancel: settings.allowCancel, cancellable, reason }),
  );
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const pre = preflightIfOptions(request);
  if (pre) return pre;
  return corsSafe(() => actionImpl(request));
};

async function actionImpl(request: Request): Promise<Response> {
  // Read orderId from a clone so auth (which also reads the request) is unaffected.
  let orderId = "";
  try {
    const body = await request.clone().json();
    orderId = String(body?.orderId || "");
  } catch {
    orderId = "";
  }

  const auth = await authOrCorsError(request);
  if (auth.errorResponse) return auth.errorResponse;
  const { cors, sessionToken } = auth.ctx!;

  const shop = String(sessionToken.dest || "").replace(/^https?:\/\//, "");
  const customerGid = sessionToken.sub ? String(sessionToken.sub) : null;
  if (!shop) return cors(json({ error: "no-shop" }, { status: 400 }));
  if (!orderId) return cors(json({ error: "bad-request" }, { status: 400 }));

  const settings = await prisma.orderManageSettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled || !settings.allowCancel) {
    return cors(json({ error: "not-enabled" }, { status: 403 }));
  }

  const { admin } = await unauthenticated.admin(shop);
  const order = await findOrderById(admin, orderId);
  if (!order) return cors(json({ error: "order-not-found" }, { status: 404 }));

  // Authorization.
  if (customerGid) {
    // Logged-in buyer — must own the order. checkOwnership compares the order's
    // customer gid tail against the bare numeric id, so pass just the number.
    const bareId = customerGid.replace(/^gid:\/\/shopify\/Customer\//, "");
    if (checkOwnership(order, bareId) !== "owner") {
      return cors(json({ error: "not-owner" }, { status: 403 }));
    }
  } else {
    // Guest — only a fresh order qualifies.
    const created = order.createdAt ? Date.parse(order.createdAt) : NaN;
    const fresh = Number.isFinite(created) && Date.now() - created <= GUEST_WINDOW_MS;
    if (!fresh) return cors(json({ error: "not-authorized" }, { status: 403 }));
  }

  // Eligibility (fulfilled / cancelled / prepaid-scope) — same rules everywhere.
  const { cancellable } = getEligibility(order, settings);
  if (!cancellable) return cors(json({ error: "not-cancellable" }, { status: 403 }));

  const refund = !UNPAID_STATUSES.includes(order.displayFinancialStatus);
  const result = await cancelOrder(admin, order.id, refund);
  return cors(json(result, { status: result.ok ? 200 : 422 }));
};
