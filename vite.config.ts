import type { UserConfig } from "vite";
import { defineConfig } from "vite";
import remixDev from "@remix-run/dev";
const remix = remixDev.vitePlugin;
import tsconfigPaths from "vite-tsconfig-paths";

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

export default defineConfig({
  server: {
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [
    remix({
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
