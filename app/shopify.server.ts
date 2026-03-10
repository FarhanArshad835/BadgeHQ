import "@shopify/shopify-app-remix/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
  DeliveryMethod,
} from "@shopify/shopify-app-remix/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import { restResources } from "@shopify/shopify-api/rest/admin/2025-01";
import prisma from "./db.server";
import { ensureScriptTag } from "./scripttag.server";

// Validate critical env vars at startup
const requiredVars = ["SHOPIFY_API_KEY", "SHOPIFY_API_SECRET", "SHOPIFY_APP_URL", "SCOPES"] as const;
for (const name of requiredVars) {
  if (!process.env[name]) {
    console.error(`BadgeHQ: Missing required env var ${name}`);
  }
}
console.log("BadgeHQ: Initializing with", {
  apiKey: process.env.SHOPIFY_API_KEY ? `${process.env.SHOPIFY_API_KEY.slice(0, 6)}...` : "MISSING",
  apiSecret: process.env.SHOPIFY_API_SECRET ? `${process.env.SHOPIFY_API_SECRET.slice(0, 4)}...` : "MISSING",
  appUrl: process.env.SHOPIFY_APP_URL || "MISSING",
  scopes: process.env.SCOPES || "MISSING",
});

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.January25,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  distribution: AppDistribution.AppStore,
  restResources: restResources as any,
  isEmbeddedApp: true,
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  } as any,
  hooks: {
    afterAuth: async ({ session, admin }) => {
      try {
        await ensureScriptTag(admin);
      } catch (error) {
        // Never let the afterAuth hook break the auth flow
        console.error("BadgeHQ: afterAuth hook error:", error);
      }
    },
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.January25;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
