/**
 * Public wishlist-event endpoint. Called from the storefront (widget.js) the
 * moment a shopper saves a product:
 *   POST /api/wishlist-event  { shop, handle, productId?, value?, currency?,
 *                               customerId?, fbp?, fbc?, eventId, pageUrl? }
 *
 * Why here and not the app-proxy sync route: /apps/badgehq/wishlist-sync hard
 * rejects anyone without logged_in_customer_id, so it never sees a GUEST — and
 * guests are most wishlist activity. This endpoint accepts both, and records
 * the event either way.
 *
 * Two independent jobs, deliberately ordered:
 *   1. Record the event (history for the CSV export).
 *   2. Forward it to Meta if the shop has CAPI configured.
 * A Meta failure must NEVER surface to the shopper — their wishlist already
 * worked client-side before this request was made.
 *
 * Responses:
 *   200 { ok: true }
 *   200 { enabled: false }   — wishlist off for this shop; widget stays quiet
 *   400 { error: "..." }     — bad input
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { sendWishlistEvent } from "../utils/meta-capi.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const NO_STORE = { ...CORS_HEADERS, "Cache-Control": "no-store" };

// Same shape the sync route enforces, so a handle can't arrive here in a form
// the rest of the wishlist would reject.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * OPTIONS is answered HERE as well as in the action: Remix/Vercel can route a
 * preflight to the loader, and answering it with 405 makes the browser silently
 * block the real POST. (Exactly the bug that broke the USD checkout.)
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  return json({ error: "Method not allowed" }, { status: 405, headers: NO_STORE });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405, headers: NO_STORE });
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad-request" }, { status: 400, headers: NO_STORE });
  }

  const shop = String(body?.shop || "").trim();
  const handle = String(body?.handle || "").trim().toLowerCase();
  const productId = String(body?.productId || "").replace(/\D/g, "");
  const customerId = String(body?.customerId || "").replace(/\D/g, "");
  const action = body?.action === "remove" ? "remove" : "add";

  if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
    return json({ error: "bad-shop" }, { status: 400, headers: NO_STORE });
  }
  if (!handle || handle.length > 255 || !HANDLE_RE.test(handle)) {
    return json({ error: "bad-handle" }, { status: 400, headers: NO_STORE });
  }

  const settings = await prisma.wishlistSettings.findUnique({ where: { shop } });
  if (!settings?.isEnabled) {
    return json({ enabled: false }, { status: 200, headers: NO_STORE });
  }

  // Only adds are worth sending to Meta — there is no "un-wishlist" event, and a
  // remove shouldn't retarget anyone. Removes are still recorded for the export.
  const capiConfigured = settings.capiEnabled && Boolean(settings.capiDatasetId && settings.capiAccessToken);
  const willSend = capiConfigured && action === "add";

  let row;
  try {
    row = await prisma.wishlistEvent.create({
      data: {
        shop,
        customerId,
        handle,
        productId,
        action,
        // "skipped" is a settled state, not a failure: nothing to retry when the
        // shop hasn't configured CAPI or the event is a remove.
        metaStatus: willSend ? "pending" : "skipped",
      },
    });
  } catch {
    return json({ error: "save-failed" }, { status: 500, headers: NO_STORE });
  }

  if (willSend) {
    // IP and user agent come from the REQUEST — a client-supplied IP would let
    // anyone poison another shopper's match data.
    const clientIp =
      (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
      request.headers.get("x-real-ip") ||
      undefined;
    const clientUserAgent = request.headers.get("user-agent") || undefined;

    const result = await sendWishlistEvent({
      datasetId: settings.capiDatasetId,
      accessToken: settings.capiAccessToken,
      handle,
      productId: productId || undefined,
      value: Number(body?.value) > 0 ? Number(body.value) : undefined,
      currency: String(body?.currency || "").trim().toUpperCase() || undefined,
      customerId: customerId || undefined,
      fbp: String(body?.fbp || "").trim() || undefined,
      fbc: String(body?.fbc || "").trim() || undefined,
      clientIp,
      clientUserAgent,
      eventId: row.id, // shared with the browser pixel so Meta can dedupe
      eventSourceUrl: String(body?.pageUrl || "").trim() || undefined,
    });

    await prisma.wishlistEvent
      .update({
        where: { id: row.id },
        data: result.ok
          ? { metaStatus: "sent", attempts: 1, metaError: "" }
          : {
              // A permanent failure (bad token, unmatched shopper) must not be
              // retried forever — mark it failed so the cron leaves it alone.
              metaStatus: result.permanent ? "failed" : "pending",
              attempts: 1,
              metaError: result.reason.slice(0, 300),
            },
      })
      .catch(() => {
        /* bookkeeping only — never fail the shopper's request over it */
      });
  }

  // Always 200 to the storefront: the wishlist itself already succeeded locally.
  return json({ ok: true }, { headers: NO_STORE });
};
