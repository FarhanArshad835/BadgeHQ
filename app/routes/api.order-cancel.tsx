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

// Preflight — authenticate.public.checkout handles the CORS/OPTIONS response.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { cors } = await authenticate.public.checkout(request);
  return cors(json({ ok: true }));
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { cors, sessionToken } = await authenticate.public.checkout(request);

  const shop = String(sessionToken.dest || "").replace(/^https?:\/\//, "");
  const customerGid = sessionToken.sub ? String(sessionToken.sub) : null;
  if (!shop) return cors(json({ error: "no-shop" }, { status: 400 }));

  let orderId = "";
  try {
    const body = await request.json();
    orderId = String(body?.orderId || "");
  } catch {
    return cors(json({ error: "bad-request" }, { status: 400 }));
  }

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
