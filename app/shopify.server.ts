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
  future: {
    unstable_newEmbeddedAuthStrategy: true,
  } as any,
  hooks: {
    afterAuth: async ({ session, admin }) => {
      // Register ScriptTag so widget.js loads on the storefront
      const appUrl = process.env.SHOPIFY_APP_URL || "";
      const widgetSrc = `${appUrl}/widget.js`;

      try {
        // Check if ScriptTag already exists
        const existing = await admin.rest.resources.ScriptTag.all({
          session,
          src: widgetSrc,
        });

        if (!existing.data || existing.data.length === 0) {
          const scriptTag = new admin.rest.resources.ScriptTag({ session });
          scriptTag.event = "onload";
          scriptTag.src = widgetSrc;
          scriptTag.display_scope = "online_store";
          await scriptTag.save({ update: true });
          console.log("BadgeHQ: ScriptTag registered:", widgetSrc);
        }
      } catch (e) {
        console.error("BadgeHQ: Failed to register ScriptTag:", e);
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
