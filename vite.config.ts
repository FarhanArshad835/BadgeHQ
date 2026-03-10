import type { UserConfig } from "vite";
import { defineConfig } from "vite";
import remixDev from "@remix-run/dev";
const remix = remixDev.vitePlugin;
import tsconfigPaths from "vite-tsconfig-paths";
import { vercelPreset } from "@vercel/remix/vite";

// Related: https://github.com/nicedoc/microlink-cards/issues/4#issuecomment-1112203426
// Also: https://shopify.dev/docs/api/shopify-app-remix#updating-env-or-host
if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost")
  .hostname;

let hmrConfig: Record<string, unknown> | boolean;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws" as const,
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  // Disable HMR in non-localhost environments (Codespaces, embedded Shopify iframe)
  // where WebSocket connections through proxies are unreliable
  hmrConfig = false;
}

/**
 * Vite plugin that normalises the `origin` header on incoming requests
 * so it matches `x-forwarded-host`. Shopify embedded apps run inside
 * the admin.shopify.com iframe, so the browser sends origin =
 * admin.shopify.com while the proxy sets x-forwarded-host to the app's
 * tunnel URL. Remix's CSRF check rejects the mismatch. This is safe
 * because Shopify already authenticates every request via session tokens.
 */
function shopifyEmbeddedOriginPlugin() {
  return {
    name: "shopify-embedded-origin",
    configureServer(server: { middlewares: { use: Function } }) {
      server.middlewares.use(
        (
          req: { headers: Record<string, string | string[] | undefined> },
          _res: unknown,
          next: () => void,
        ) => {
          const origin = req.headers["origin"];
          const forwarded = req.headers["x-forwarded-host"];
          if (typeof origin === "string" && typeof forwarded === "string") {
            const fwdHost = forwarded.split(",")[0].trim();
            try {
              const originHost = new URL(origin).host;
              if (originHost !== fwdHost) {
                req.headers["origin"] = `https://${fwdHost}`;
              }
            } catch {
              // invalid origin URL, leave it alone
            }
          }
          next();
        },
      );
    },
  };
}

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    shopifyEmbeddedOriginPlugin(),
    remix({
      presets: [vercelPreset()],
      future: {
        v3_fetcherPersist: true,
        v3_relativeSplatPath: true,
        v3_throwAbortReason: true,
        v3_lazyRouteDiscovery: true,
        v3_singleFetch: true,
        v3_routeConfig: true,
      },
    }),
    tsconfigPaths(),
  ],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/polaris"],
  },
}) satisfies UserConfig;
