import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Button,
  Badge,
  Banner,
  Checkbox,
  Box,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { getUsdConfig, getInrToUsdRate } from "../utils/usd-checkout.server";
import prisma from "../db.server";

const SECRET_MASK = "••••••••"; // shown instead of the real secret; unchanged if left as-is

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const cfg = await getUsdConfig();
  const rate = await getInrToUsdRate().catch(() => 0);

  return json({
    enabled: cfg.enabled,
    razorpayKeyId: cfg.razorpayKeyId,
    hasSecret: Boolean(cfg.razorpayKeySecret),
    shopDomain: cfg.shopDomain,
    hasAdminToken: Boolean(cfg.shopifyAdminToken),
    markupBps: cfg.markupBps,
    inrToUsdRate: rate,
    isLive: cfg.razorpayKeyId.startsWith("rzp_live_"),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);
  const form = await request.formData();

  const enabled = form.get("enabled") === "on";
  const razorpayKeyId = String(form.get("razorpayKeyId") || "").trim();
  const secretInput = String(form.get("razorpayKeySecret") || "");
  const shopDomain = String(form.get("shopDomain") || "").trim();
  const markupInput = String(form.get("markupX") || "").trim();

  // markup entered as a multiplier (e.g. "4" = x4). Store as bps (4 -> 40000).
  const markupX = Number(markupInput);
  const markupBps =
    markupX && markupX > 0 && markupX <= 100 ? Math.round(markupX * 10000) : undefined;

  const data: Record<string, unknown> = { enabled, razorpayKeyId, shopDomain };
  if (markupBps) data.markupBps = markupBps;
  // Only overwrite the secret if the user typed a new one (mask left untouched = keep).
  if (secretInput && secretInput !== SECRET_MASK) data.razorpayKeySecret = secretInput.trim();

  await prisma.usdCheckout.update({ where: { id: "default" }, data });

  return redirect("/app/usd-checkout?saved=1");
};

export default function UsdCheckoutSettings() {
  const d = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const saving = nav.state === "submitting";
  const [searchParams] = useSearchParams();
  const saved = searchParams.get("saved") === "1";

  const [enabled, setEnabled] = useState(d.enabled);
  const [keyId, setKeyId] = useState(d.razorpayKeyId);
  const [secret, setSecret] = useState(d.hasSecret ? SECRET_MASK : "");
  const [shopDomain, setShopDomain] = useState(d.shopDomain);
  const [markupX, setMarkupX] = useState(String((d.markupBps / 10000) || 4));

  const rateStr = d.inrToUsdRate > 0 ? d.inrToUsdRate.toFixed(6) : "unavailable";
  const exampleUsd =
    d.inrToUsdRate > 0 ? (1000 * (d.markupBps / 10000) * d.inrToUsdRate).toFixed(2) : "-";

  return (
    <Page narrowWidth>
      <TitleBar title="USD Checkout" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {saved && <Banner tone="success" title="Settings saved." />}

            {d.isLive ? (
              <Banner tone="warning" title="Live keys are active">
                <p>Real cards will be charged. Make sure you have rotated any keys that were ever pasted in chat.</p>
              </Banner>
            ) : (
              <Banner tone="info" title="Test mode">
                <p>These are test keys (or none). No real money moves. Swap in live keys below when ready to go live.</p>
              </Banner>
            )}

            <Card>
              <Form method="post">
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">Razorpay (International USD)</Text>

                  <Checkbox
                    label="Enable Pay in USD for US customers"
                    checked={enabled}
                    onChange={setEnabled}
                    helpText="Master switch. The storefront button is also gated in the theme editor."
                  />
                  {/* checkbox posts only when checked; mirror into a hidden input */}
                  <input type="hidden" name="enabled" value={enabled ? "on" : "off"} />

                  <TextField
                    label="Razorpay Key ID"
                    name="razorpayKeyId"
                    value={keyId}
                    onChange={setKeyId}
                    autoComplete="off"
                    placeholder="rzp_live_XXXXXXXX"
                    helpText="Public key id. Live keys start with rzp_live_, test with rzp_test_."
                  />

                  <TextField
                    label="Razorpay Key Secret"
                    name="razorpayKeySecret"
                    type="password"
                    value={secret}
                    onChange={setSecret}
                    autoComplete="off"
                    helpText={
                      d.hasSecret
                        ? "A secret is saved. Leave the dots to keep it, or type a new secret to replace it."
                        : "Paste the key secret. Stored server-side only, never sent to the storefront."
                    }
                  />

                  <Divider />

                  <TextField
                    label="Price markup (multiplier)"
                    name="markupX"
                    type="number"
                    value={markupX}
                    onChange={setMarkupX}
                    autoComplete="off"
                    suffix="×"
                    helpText="4 = charge 4× the INR base price, then convert to USD (your ₹1000 becomes ₹4000 rule)."
                  />

                  <TextField
                    label="Shop domain"
                    name="shopDomain"
                    value={shopDomain}
                    onChange={setShopDomain}
                    autoComplete="off"
                    placeholder="six-by-eleven.myshopify.com"
                    helpText="The store USD orders are written back into."
                  />

                  <InlineStack align="end">
                    <Button variant="primary" submit loading={saving}>Save</Button>
                  </InlineStack>
                </BlockStack>
              </Form>
            </Card>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">Live status</Text>
                <InlineStack gap="300" wrap>
                  <Badge tone={d.enabled ? "success" : undefined}>{d.enabled ? "Enabled" : "Disabled"}</Badge>
                  <Badge tone={d.isLive ? "warning" : "info"}>{d.isLive ? "Live keys" : "Test keys"}</Badge>
                  <Badge tone={d.hasAdminToken ? "success" : "critical"}>
                    {d.hasAdminToken ? "Shopify token set" : "No Shopify token"}
                  </Badge>
                </InlineStack>
                <Box paddingBlockStart="200">
                  <Text as="p" tone="subdued">Live INR to USD rate: {rateStr} (USD per ₹1)</Text>
                  <Text as="p" tone="subdued">
                    Example: a ₹1,000 base item becomes ₹{(1000 * (d.markupBps / 10000)).toLocaleString()}, charged as ${exampleUsd}.
                  </Text>
                </Box>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
