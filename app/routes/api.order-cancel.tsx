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

// The extension sends the session token in the query string (GET) or JSON
// body (POST) rather than the Authorization header, so the fetch stays a CORS
// "simple" request with no preflight (the preflighted form is blocked by the
// extension network sandbox -> "Failed to fetch"). authenticate.public.checkout
// only reads the Authorization header, so we rebuild the request with the
// header populated from wherever the token actually came in.
async function withAuthHeader(request: Request): Promise<Request> {
  if (request.headers.get("Authorization")) return request;

  let token = new URL(request.url).searchParams.get("token") || "";
  let rebuiltBody: string | undefined;
  if (!token && request.method === "POST") {
    const raw = await request.text();
    rebuiltBody = raw;
    try {
      token = String(JSON.parse(raw)?.token || "");
    } catch {
      /* not JSON — leave token empty */
    }
  }
  if (!token) return request;

  const headers = new Headers(request.headers);
  headers.set("Authorization", "Bearer " + token);
  return new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === "POST" ? rebuiltBody : undefined,
  });
}

// authenticate.public.checkout THROWS a Response (e.g. 401/410) when the
// session token is missing/expired, and that thrown response has NO CORS
// headers — so the browser reports "Failed to fetch" instead of the real
// status. Wrap it so auth failures come back as a CORS-safe JSON error.
async function authOrCorsError(request: Request) {
  try {
    const ctx = await authenticate.public.checkout(request);
    return { ctx };
  } catch (e) {
    const status = e instanceof Response ? e.status : 401;
    return {
      errorResponse: json(
        { error: "auth-failed", status },
        { status: 200, headers: { ...CORS_PREFLIGHT_HEADERS, "Cache-Control": "no-store" } },
      ),
    };
  }
}

// GET ?orderId=gid -> eligibility for THIS order, so the extension can show a
// greyed-out disabled Cancel button on cancelled/fulfilled/prepaid orders
// instead of hiding it. Also serves the CORS preflight when no orderId given.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const pre = preflightIfOptions(request);
  if (pre) return pre;

  const authed = await withAuthHeader(request);
  const auth = await authOrCorsError(authed);
  if ("errorResponse" in auth) return auth.errorResponse;
  const { cors, sessionToken } = auth.ctx;

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
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const pre = preflightIfOptions(request);
  if (pre) return pre;

  const authed = await withAuthHeader(request);

  // Read orderId from a clone BEFORE auth (auth may consume the body).
  // The body is JSON sent with a text/plain content-type, so parse manually.
  let orderId = "";
  try {
    const body = JSON.parse(await authed.clone().text());
    orderId = String(body?.orderId || "");
  } catch {
    orderId = "";
  }

  const auth = await authOrCorsError(authed);
  if ("errorResponse" in auth) return auth.errorResponse;
  const { cors, sessionToken } = auth.ctx;

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
