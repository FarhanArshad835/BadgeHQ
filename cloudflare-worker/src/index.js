// Cloudflare Worker that fronts the BadgeHQ widget infrastructure from
// the global edge:
//
//   /widget.js                 — static, embedded into the bundle at build time
//   /health                    — diagnostics: returns hash + build time
//   /api/widgets               — proxied from Vercel, cached at edge for 5 min
//   /api/products/inventory    — proxied from Vercel, cached at edge for 5 min
//
// Why proxy with cache instead of pointing the widget at Vercel directly:
// the storefront does ~134K pageviews/day for one merchant. With the
// proxy + cf.cacheTtl=300 (5 min), Vercel sees ~1 request per shop per 5
// minutes (~12/hour = 288/day) instead of one per pageview. That's a
// >99% reduction in Vercel edge requests for these dynamic endpoints.

import { WIDGET_SOURCE, WIDGET_HASH, WIDGET_BUILT_AT } from "./widget-source.generated.js";

// Where the actual Remix app + Postgres + Shopify Admin API integration lives.
// The worker only proxies; all data still comes from here, just cached.
const ORIGIN = "https://badge-hq.vercel.app";

// Edge cache TTLs per route. Tuned aggressively to keep Vercel function
// invocations under the free-tier compute cap (4 hours of Active CPU/month).
//
// Cloudflare's cf.cacheTtl is per-POP, not global — each edge POP fills
// its own cache. For high-traffic merchants whose visitors come from many
// regions, that means N times the invocation count vs theoretical.
// Solution: cache long enough that even per-POP invocations are tiny.
//
// Inventory (~385ms CPU/call): 6 hours. "Trending"/"low stock" badges
// don't need to update faster than that.
//
// Widgets (~50ms CPU/call): 1 hour. When merchant edits a badge in admin,
// storefront sees changes within 1 hour. Acceptable tradeoff for the
// invocation savings.
//
// To force-refresh after a merchant config change: redeploy the worker
// (hashes change → cache key changes → first request rebuilds cache).
const CACHE_TTL_BY_PATH = {
  "/api/widgets": 3600,                 // 1 hour
  "/api/products/inventory": 21600,     // 6 hours
  "/api/delivery-edd": 21600,           // 6 hours — TAT per shop+pincode barely changes intra-day
};
const DEFAULT_CACHE_TTL = 300;

const HEADERS_JS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "public, max-age=3600, s-maxage=86400",
  "Access-Control-Allow-Origin": "*",
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Source": "cloudflare-worker",
  "X-Widget-Hash": WIDGET_HASH,
  "X-Widget-Built-At": WIDGET_BUILT_AT,
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Proxy a request to the Vercel origin with edge caching. cf.cacheTtl
// makes Cloudflare cache the upstream response by URL — subsequent
// requests for the same URL within TTL serve from the edge POP without
// touching Vercel at all.
async function proxyWithCache(request, originPath) {
  const url = new URL(request.url);
  const ttl = CACHE_TTL_BY_PATH[originPath] || DEFAULT_CACHE_TTL;
  const target = `${ORIGIN}${originPath}?${url.searchParams.toString()}`;

  const upstream = await fetch(target, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Forwarded-For-Worker": "badgehq-widget",
    },
    cf: {
      cacheTtl: ttl,
      cacheEverything: true,
      // Cache 200 responses; let errors fall through without poisoning the cache
      cacheTtlByStatus: { "200-299": ttl, "400-499": 5, "500-599": 0 },
    },
  });

  // Build a clean response with our own headers — strip Vercel-specific
  // headers, lock down Cache-Control, expose CORS for the storefront.
  const respHeaders = new Headers();
  respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
  respHeaders.set("Cache-Control", `public, max-age=${ttl}, s-maxage=${ttl * 2}`);
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("X-Source", "cloudflare-worker-api-proxy");
  respHeaders.set("X-Origin", "vercel");
  respHeaders.set("X-Cache-TTL", String(ttl));
  // Pass through Cloudflare's own cache status if present
  const cfCacheStatus = upstream.headers.get("CF-Cache-Status");
  if (cfCacheStatus) respHeaders.set("X-Edge-Cache", cfCacheStatus);

  return new Response(upstream.body, {
    status: upstream.status,
    headers: respHeaders,
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // OPTIONS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Health/version probe — useful for diagnostics
    if (url.pathname === "/health" || url.pathname === "/") {
      return new Response(
        JSON.stringify({
          status: "ok",
          widget_hash: WIDGET_HASH,
          widget_built_at: WIDGET_BUILT_AT,
          widget_bytes: WIDGET_SOURCE.length,
          routes: ["/widget.js", "/health", "/api/widgets", "/api/products/inventory", "/api/delivery-edd"],
          origin: ORIGIN,
          cache_ttl_by_path_seconds: CACHE_TTL_BY_PATH,
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
          },
        }
      );
    }

    // Static widget.js — embedded into the worker bundle
    if (
      (request.method === "GET" || request.method === "HEAD") &&
      (url.pathname === "/widget.js" || url.pathname.endsWith("/widget.js"))
    ) {
      return new Response(request.method === "HEAD" ? null : WIDGET_SOURCE, {
        status: 200,
        headers: HEADERS_JS,
      });
    }

    // Proxied API endpoints — cached at the edge, falls through to Vercel
    // on cache miss (~1 fetch per shop per 5 minutes instead of every pageview)
    if (request.method === "GET" || request.method === "HEAD") {
      if (url.pathname === "/api/widgets") {
        return proxyWithCache(request, "/api/widgets");
      }
      if (url.pathname === "/api/products/inventory") {
        return proxyWithCache(request, "/api/products/inventory");
      }
      if (url.pathname === "/api/delivery-edd") {
        return proxyWithCache(request, "/api/delivery-edd");
      }
    }

    return new Response("Not found", {
      status: 404,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};
