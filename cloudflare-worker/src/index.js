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
//
// The shop's config version (bumped via /internal/bump on every admin
// save) is appended to the target URL, so a publish changes the cache
// key and forces a fresh origin fetch; unchanged configs stay cached
// for the full TTL. The 60s KV read-cache keeps KV reads to ~1/min/POP.
async function proxyWithCache(request, originPath, env) {
  const url = new URL(request.url);
  const ttl = CACHE_TTL_BY_PATH[originPath] || DEFAULT_CACHE_TTL;

  // Per-shop config version (bumped via /internal/bump on every admin save).
  let configVersion = "0";
  const shop = url.searchParams.get("shop");
  if (shop && env && env.CONFIG_VERSIONS) {
    try {
      configVersion = (await env.CONFIG_VERSIONS.get("v:" + shop, { cacheTtl: 30 })) || "0";
    } catch (e) {
      // KV hiccup — fall back to version 0 (still correct, just not busted).
    }
  }

  // We manage the edge cache explicitly via the Cache API so the version is
  // part of the CACHE KEY. A bump changes the key -> guaranteed miss -> fresh
  // origin fetch; unchanged configs keep serving from the edge for the full
  // TTL. (Relying on cf.cacheTtl instead keyed only on the incoming URL, which
  // has no version, so a bump could never invalidate it.)
  const cache = caches.default;
  const cacheKey = new Request(
    `https://cache.badgehq.internal${originPath}?${url.searchParams.toString()}&_cv=${configVersion}`,
    { method: "GET" },
  );

  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set("X-Edge-Cache", "HIT");
    return hit;
  }

  const target = `${ORIGIN}${originPath}?${url.searchParams.toString()}&_cv=${configVersion}`;
  const upstream = await fetch(target, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Forwarded-For-Worker": "badgehq-widget",
    },
    // Don't let Cloudflare's implicit cache double-cache this; we own caching.
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  // Build a clean response with our own headers — strip Vercel-specific
  // headers, lock down Cache-Control, expose CORS for the storefront.
  const body = await upstream.arrayBuffer();
  const browserTtl = originPath === "/api/widgets" ? 60 : ttl;
  const respHeaders = new Headers();
  respHeaders.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
  respHeaders.set("Cache-Control", `public, max-age=${browserTtl}`);
  respHeaders.set("Access-Control-Allow-Origin", "*");
  respHeaders.set("X-Source", "cloudflare-worker-api-proxy");
  respHeaders.set("X-Origin", "vercel");
  respHeaders.set("X-Cache-TTL", String(ttl));
  respHeaders.set("X-Config-Version", configVersion);
  respHeaders.set("X-Edge-Cache", "MISS");

  const response = new Response(body, { status: upstream.status, headers: respHeaders });

  // Only cache successes at the edge, for `ttl` seconds under the versioned
  // key. The stored copy carries its own Cache-Control so cache.put honors ttl.
  if (upstream.status >= 200 && upstream.status < 300) {
    const toStore = response.clone();
    toStore.headers.set("Cache-Control", `public, max-age=${ttl}`);
    await cache.put(cacheKey, toStore);
  }

  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // OPTIONS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Back-in-stock signup. A write, so it must NOT be cached and must be
    // forwarded verbatim (method + body) to the origin, unlike the read-only
    // proxies below.
    // AI chat. Every reply is unique, so this must never be cached; forward
    // method + body verbatim like the back-in-stock signup.
    if (url.pathname === "/api/ai-reply") {
      const upstream = await fetch(`${ORIGIN}/api/ai-reply`, {
        method: request.method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: request.method === "POST" ? await request.text() : undefined,
      });
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "no-store");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    if (url.pathname === "/api/back-in-stock") {
      const upstream = await fetch(`${ORIGIN}/api/back-in-stock`, {
        method: request.method,
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: request.method === "POST" ? await request.text() : undefined,
      });
      const headers = new Headers();
      headers.set("Content-Type", "application/json");
      headers.set("Cache-Control", "no-store");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
      headers.set("Access-Control-Allow-Headers", "Content-Type");
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // Cache-bust hook: the Remix app calls this after every admin save so
    // storefronts fetch the new config immediately instead of waiting out
    // the edge TTL. Authenticated with the BUMP_SECRET worker secret.
    if (request.method === "POST" && url.pathname === "/internal/bump") {
      const secret = request.headers.get("X-Bump-Secret");
      if (!env.BUMP_SECRET || !secret || secret !== env.BUMP_SECRET) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const shop = url.searchParams.get("shop") || "";
      if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
        return new Response(JSON.stringify({ error: "invalid-shop" }), {
          status: 400,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      if (!env.CONFIG_VERSIONS) {
        return new Response(JSON.stringify({ error: "kv-not-bound" }), {
          status: 500,
          headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
        });
      }
      const version = String(Date.now());
      await env.CONFIG_VERSIONS.put("v:" + shop, version);
      return new Response(JSON.stringify({ ok: true, shop: shop, version: version }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
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
          routes: ["/widget.js", "/health", "/api/widgets", "/api/products/inventory", "/api/delivery-edd", "/api/back-in-stock", "/api/ai-reply", "/internal/bump"],
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
        return proxyWithCache(request, "/api/widgets", env);
      }
      if (url.pathname === "/api/products/inventory") {
        return proxyWithCache(request, "/api/products/inventory", env);
      }
      if (url.pathname === "/api/delivery-edd") {
        return proxyWithCache(request, "/api/delivery-edd", env);
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
