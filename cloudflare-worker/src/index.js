// Cloudflare Worker that serves widget.js from the global edge.
// Replaces Vercel's serving of /widget.js for the storefront, eliminating
// ~30-40% of the app's Vercel edge-request count once the theme app
// extension is updated to point here.
//
// The widget.js source is embedded into the bundle by build.js (see
// widget-source.generated.js). To deploy a new widget.js version:
//   cd cloudflare-worker && npm run deploy
// (which runs `npm run build` first to re-embed the latest source).

import { WIDGET_SOURCE, WIDGET_HASH, WIDGET_BUILT_AT } from "./widget-source.generated.js";

const HEADERS_JS = {
  "Content-Type": "application/javascript; charset=utf-8",
  // Browser caches for 1 hour, Cloudflare edge caches for 1 day.
  // Storefronts get widget updates within an hour of a deploy.
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Source": "cloudflare-worker",
  "X-Widget-Hash": WIDGET_HASH,
  "X-Widget-Built-At": WIDGET_BUILT_AT,
};

const HEADERS_HEALTH = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // OPTIONS preflight (defensive; widget.js shouldn't trigger CORS preflight
    // when loaded via <script src> but a misconfigured theme might fetch() it)
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    // Health/version probe — useful for diagnostics
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          widget_hash: WIDGET_HASH,
          widget_built_at: WIDGET_BUILT_AT,
          widget_bytes: WIDGET_SOURCE.length,
        }),
        { status: 200, headers: HEADERS_HEALTH }
      );
    }

    // Serve widget.js — accept any path that ends in widget.js so we can use
    // a versioned URL like /widget.js?v=abc123 if needed for cache-busting.
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/widget.js" || url.pathname.endsWith("/widget.js")) {
        return new Response(request.method === "HEAD" ? null : WIDGET_SOURCE, {
          status: 200,
          headers: HEADERS_JS,
        });
      }
    }

    return new Response("Not found", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  },
};
