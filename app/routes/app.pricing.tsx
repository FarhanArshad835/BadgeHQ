import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useActionData, useSubmit, useNavigation } from "@remix-run/react";
import {
  Page,
  Card,
  BlockStack,
  InlineGrid,
  Text,
  Badge,
  List,
  Box,
  Banner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEffect, useRef } from "react";
import { authenticate } from "../shopify.server";
import { PLANS, PLAN_DETAILS, type Plan } from "../billing.shared";
import {
  upsertShopPlan,
  extractReauthorizeUrl,
} from "../billing.server";

/** Returns true if the shop is a development/partner store (test charges required). */
async function isTestStore(shop: string, accessToken: string): Promise<boolean> {
  try {
    const resp = await fetch(
      `https://${shop}/admin/api/2025-01/shop.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const data = await resp.json() as { shop?: { plan_name?: string } };
    const plan = data.shop?.plan_name ?? "";
    return ["developer", "affiliate", "staff", "staff_business", "partner_test"].includes(plan);
  } catch {
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = await isTestStore(shop, session.accessToken!);

  // Check active subscriptions
  let activePlan: Plan = PLANS.FREE;
  let billingId: string | undefined;

  try {
    const { appSubscriptions } = await billing.check({
      plans: [PLANS.GROWTH, PLANS.PRO],
      isTest,
    });
    if (appSubscriptions.length > 0) {
      const sub = appSubscriptions[0];
      activePlan = (sub.name as Plan) ?? PLANS.FREE;
      billingId = sub.id;
      await upsertShopPlan(shop, activePlan, billingId);
    }
  } catch (error) {
    const reauthorizeUrl = extractReauthorizeUrl(error);
    if (reauthorizeUrl) {
      return json({ currentPlan: PLANS.FREE, reauthorizeUrl, error: null });
    }
  }

  return json({ currentPlan: activePlan, reauthorizeUrl: null, error: null });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const isTest = await isTestStore(shop, session.accessToken!);
  const form = await request.formData();
  const intent = form.get("intent") as string;
  const plan = form.get("plan") as Plan;

  if (intent === "upgrade" && (plan === PLANS.GROWTH || plan === PLANS.PRO)) {
    try {
      const returnUrl = `${process.env.SHOPIFY_APP_URL}/app/pricing`;
      const price = String(PLAN_DETAILS[plan].price);
      const resp = await admin.graphql(
        `#graphql
        mutation AppSubscriptionCreate($name: String!, $returnUrl: URL!, $test: Boolean, $price: Decimal!) {
          appSubscriptionCreate(
            name: $name
            returnUrl: $returnUrl
            test: $test
            lineItems: [{
              plan: {
                appRecurringPricingDetails: {
                  price: { amount: $price, currencyCode: USD }
                  interval: EVERY_30_DAYS
                }
              }
            }]
          ) {
            userErrors { field message }
            confirmationUrl
          }
        }`,
        { variables: { name: plan, returnUrl, test: isTest, price } }
      );
      const body = await resp.json() as {
        data?: {
          appSubscriptionCreate?: {
            confirmationUrl: string | null;
            userErrors: { field: string; message: string }[];
          };
        };
        errors?: unknown;
      };
      console.error("[BadgeHQ billing] GraphQL response:", JSON.stringify(body));
      const result = body.data?.appSubscriptionCreate;
      if (body.errors) {
        return json({ confirmationUrl: null, error: `GraphQL error: ${JSON.stringify(body.errors)}` });
      }
      if (result?.userErrors?.length) {
        const msg = result.userErrors.map((e) => e.message).join(", ");
        return json({ confirmationUrl: null, error: `Billing error: ${msg}` });
      }
      return json({ confirmationUrl: result?.confirmationUrl ?? null, error: null });
    } catch (error) {
      if (error instanceof Response) throw error;
      const msg = (error as Error)?.message ?? JSON.stringify(error);
      console.error("[BadgeHQ billing] exception:", msg);
      return json({ confirmationUrl: null, error: `Billing error: ${msg}` });
    }
  }

  if (intent === "cancel") {
    try {
      const { appSubscriptions } = await billing.check({
        plans: [PLANS.GROWTH, PLANS.PRO],
        isTest,
      });
      if (appSubscriptions.length > 0) {
        await billing.cancel({
          subscriptionId: appSubscriptions[0].id,
          isTest,
          prorate: true,
        });
      }
      await upsertShopPlan(shop, PLANS.FREE);
    } catch {
      // ignore
    }
    return json({ confirmationUrl: null, error: null });
  }

  return json({ confirmationUrl: null, error: null });
};

export default function PricingPage() {
  const { currentPlan, reauthorizeUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isLoading = navigation.state !== "idle";

  const confirmationUrlRef = useRef<string | null>(null);

  // Handle reauthorize redirect on load
  useEffect(() => {
    if (reauthorizeUrl && window.top) {
      window.top.location.href = reauthorizeUrl;
    }
  }, [reauthorizeUrl]);

  // Handle confirmationUrl from action — navigate top frame to break out of iframe
  useEffect(() => {
    const url = actionData?.confirmationUrl;
    if (url && url !== confirmationUrlRef.current) {
      confirmationUrlRef.current = url;
      if (window.top) {
        window.top.location.href = url;
      }
    }
  }, [actionData]);

  function handleUpgrade(plan: Plan) {
    const form = new FormData();
    form.append("intent", "upgrade");
    form.append("plan", plan);
    submit(form, { method: "post" });
  }

  function handleCancel() {
    if (!confirm("Are you sure you want to cancel your subscription? You will be moved to the Free plan.")) return;
    const form = new FormData();
    form.append("intent", "cancel");
    submit(form, { method: "post" });
  }

  const plans: Plan[] = [PLANS.FREE, PLANS.GROWTH, PLANS.PRO];

  return (
    <Page>
      <TitleBar title="Pricing" />
      <BlockStack gap="500">
        {actionData?.error && (
          <Banner tone="critical">
            <p>{actionData.error}</p>
          </Banner>
        )}

        <BlockStack gap="200">
          <Text as="h2" variant="headingLg">Choose your plan</Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            All plans include access to BadgeHQ features. Upgrade anytime to unlock more.
          </Text>
        </BlockStack>

        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
          {plans.map((plan) => {
            const details = PLAN_DETAILS[plan];
            const isCurrent = currentPlan === plan;
            const isPaid = plan !== PLANS.FREE;

            return (
              <Card key={plan}>
                <BlockStack gap="400">
                  <BlockStack gap="100">
                    <InlineGrid columns="1fr auto" alignItems="center">
                      <Text as="h3" variant="headingMd">{details.name}</Text>
                      {isCurrent && <Badge tone="success">Current plan</Badge>}
                    </InlineGrid>
                    <Text as="p" variant="headingXl">
                      {details.price === 0 ? "Free" : `$${details.price}/mo`}
                    </Text>
                  </BlockStack>

                  <div style={{ borderTop: "1px solid #e1e3e5" }} />

                  <List type="bullet">
                    {details.features.map((f) => (
                      <List.Item key={f}>{f}</List.Item>
                    ))}
                  </List>

                  <Box>
                    {isCurrent ? (
                      <>
                        {isPaid && (
                          <button
                            onClick={handleCancel}
                            disabled={isLoading}
                            style={{
                              width: "100%",
                              padding: "10px",
                              background: "none",
                              border: "1px solid #c9cccf",
                              borderRadius: "6px",
                              cursor: "pointer",
                              color: "#c9cccf",
                              fontSize: "0.875rem",
                            }}
                          >
                            Cancel plan
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        onClick={() => isPaid ? handleUpgrade(plan) : undefined}
                        disabled={isLoading || !isPaid}
                        style={{
                          width: "100%",
                          padding: "10px",
                          background: isPaid ? "#008060" : "#f6f6f7",
                          border: "none",
                          borderRadius: "6px",
                          cursor: isPaid ? "pointer" : "default",
                          color: isPaid ? "#fff" : "#8c9196",
                          fontSize: "0.875rem",
                          fontWeight: 500,
                        }}
                      >
                        {isPaid
                          ? currentPlan === PLANS.FREE
                            ? `Upgrade to ${details.name}`
                            : plan === PLANS.PRO
                            ? "Upgrade to Pro"
                            : "Downgrade to Growth"
                          : "Current free plan"}
                      </button>
                    )}
                  </Box>
                </BlockStack>
              </Card>
            );
          })}
        </InlineGrid>
      </BlockStack>
    </Page>
  );
}
