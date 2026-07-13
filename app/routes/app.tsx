import type { HeadersFunction, LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Link, Outlet, useLoaderData, useRouteError } from "@remix-run/react";
import { boundary } from "@shopify/shopify-app-remix/server";
import { AppProvider } from "@shopify/shopify-app-remix/react";
import { NavMenu } from "@shopify/app-bridge-react";
import polarisStyles from "@shopify/polaris/build/esm/styles.css?url";
import { authenticate } from "../shopify.server";

export const links = () => [{ rel: "stylesheet", href: polarisStyles }];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const isEmbedded = url.searchParams.has("shop") ||
    url.searchParams.has("host") ||
    request.headers.has("authorization");

  console.log("BadgeHQ: app.tsx loader hit", {
    path: url.pathname,
    search: url.search,
    hasAuth: request.headers.has("authorization"),
    isEmbedded,
  });

  try {
    await authenticate.admin(request);
    console.log("BadgeHQ: authenticate.admin succeeded");
    return { apiKey: process.env.SHOPIFY_API_KEY || "" };
  } catch (error: any) {
    if (error instanceof Response) {
      console.error("BadgeHQ: authenticate.admin threw Response", {
        status: error.status,
        statusText: error.statusText,
      });
    } else {
      console.error("BadgeHQ: authenticate.admin error:", {
        message: error?.message,
        type: error?.constructor?.name,
      });
    }
    throw error;
  }
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider isEmbeddedApp apiKey={apiKey}>
      <NavMenu>
        <Link to="/app" rel="home">Dashboard</Link>
        <Link to="/app/trust-badge">Trust Badges</Link>
        <Link to="/app/product-badge">Product Badges</Link>
        <Link to="/app/announcement-bar">Announcement Bar</Link>
        <Link to="/app/free-shipping-bar">Free Shipping Bar</Link>
        <Link to="/app/sticky-cart">Sticky Add to Cart</Link>
        <Link to="/app/countdown-timer">Countdown Timer</Link>
        <Link to="/app/delivery-estimate">Delivery Estimate</Link>
        <Link to="/app/global-settings">Settings</Link>
        <Link to="/app/pricing">Pricing</Link>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
