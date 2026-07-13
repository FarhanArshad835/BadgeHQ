/**
 * Wishlist page, served through the Shopify App Proxy:
 *   storefront /apps/badgehq/wishlist -> this route.
 *
 * Returned as application/liquid via the appProxy liquid() helper, so Shopify
 * renders it INSIDE the store's theme layout (header/footer/styles). The app
 * embed loads widget.js on every theme-layout page, and widget.js spots the
 * [data-badgehq-wishlist-page] container and renders the saved items
 * client-side from localStorage / the synced list.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, liquid } = await authenticate.public.appProxy(request);
  if (!session || !liquid) {
    return new Response("unauthorized", { status: 401 });
  }

  const settings = await prisma.wishlistSettings.findUnique({
    where: { shop: session.shop },
  });

  if (!settings || !settings.isEnabled) {
    return liquid(
      `<div style="max-width:600px;margin:60px auto;padding:0 20px;text-align:center;">
        <h1>Wishlist</h1>
        <p>The wishlist is not available right now.</p>
        <p><a href="/">Continue shopping</a></p>
      </div>`,
    );
  }

  return liquid(
    `<div style="max-width:1200px;margin:0 auto;padding:24px 20px 60px;">
      <h1 style="margin-bottom:8px;">Wishlist</h1>
      <div id="badgehq-wishlist-page" data-badgehq-wishlist-page>
        <p data-wl-loading>Loading your wishlist…</p>
      </div>
    </div>`,
  );
};
