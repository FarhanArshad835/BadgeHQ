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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;

  // Check active subscriptions
  let activePlan: Plan = PLANS.FREE;
  let billingId: string | undefined;

  try {
    const { appSubscriptions } = await billing.check({
      plans: [PLANS.GROWTH, PLANS.PRO],
      isTest: false,
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
  const { session, billing } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = form.get("intent") as string;
  const plan = form.get("plan") as Plan;

  if (intent === "upgrade" && (plan === PLANS.GROWTH || plan === PLANS.PRO)) {
    try {
      const confirmationUrl = await billing.request({
        plan,
        isTest: false,
        returnUrl: `${process.env.SHOPIFY_APP_URL}/app/pricing`,
      });
      return json({ confirmationUrl, error: null });
    } catch (error) {
      const reauthorizeUrl = extractReauthorizeUrl(error);
      if (reauthorizeUrl) {
        return json({ confirmationUrl: reauthorizeUrl, error: null });
      }
      return json({ confirmationUrl: null, error: "Billing request failed. Please try again." });
    }
  }

  if (intent === "cancel") {
    try {
      const { appSubscriptions } = await billing.check({
        plans: [PLANS.GROWTH, PLANS.PRO],
        isTest: false,
      });
      if (appSubscriptions.length > 0) {
        await billing.cancel({
          subscriptionId: appSubscriptions[0].id,
          isTest: false,
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
    if (reauthorizeUrl) {
      window.open(reauthorizeUrl, "_top");
    }
  }, [reauthorizeUrl]);

  // Handle confirmationUrl from action — must break out of iframe
  useEffect(() => {
    const url = actionData?.confirmationUrl;
    if (url && url !== confirmationUrlRef.current) {
      confirmationUrlRef.current = url;
      window.open(url, "_top");
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
