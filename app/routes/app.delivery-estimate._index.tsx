import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
  Button,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import {
  DELHIVERY_BASES,
  computeEtaDate,
  fetchDelhiveryTat,
  formatEta,
} from "../utils/delivery-eta.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const settings = await prisma.deliverySettings.findUnique({
    where: { shop: session.shop },
  });
  return json({
    isEnabled: settings?.isEnabled ?? false,
    // The raw token never leaves the server — only whether one is saved.
    hasToken: Boolean(settings?.apiToken),
    tokenPreview: settings?.apiToken ? settings.apiToken.slice(-4) : "",
    originPin: settings?.originPin ?? "",
    bufferDays: settings?.bufferDays ?? 1,
    environment: settings?.environment ?? "staging",
    placement: settings?.placement ?? "below-atc",
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "test") {
    const settings = await prisma.deliverySettings.findUnique({
      where: { shop: session.shop },
    });
    if (!settings?.apiToken || !/^\d{6}$/.test(settings.originPin)) {
      return json({ testError: "Save your API token and a valid origin PIN first." });
    }
    const pincode = ((formData.get("testPincode") as string) || "").trim();
    if (!/^\d{6}$/.test(pincode)) {
      return json({ testError: "Enter a valid 6-digit PIN code to test." });
    }
    try {
      const data = await fetchDelhiveryTat({
        base: DELHIVERY_BASES[settings.environment] || DELHIVERY_BASES.staging,
        token: settings.apiToken,
        originPin: settings.originPin,
        destinationPin: pincode,
      });
      const tat = data && data.success && data.data ? data.data.tat : null;
      if (typeof tat === "number" && tat >= 0) {
        const eta = formatEta(computeEtaDate(tat, settings.bufferDays));
        return json({
          testResult: `Serviceable — transit ${tat} day(s), estimated delivery ${eta.etaText} (${eta.etaDate}).`,
        });
      }
      return json({
        testResult: `Delhivery responded, but ${pincode} is not serviceable from ${settings.originPin} (${settings.environment}). Note: staging supports very few pincodes.`,
      });
    } catch {
      return json({
        testError:
          "Delhivery API call failed. Check that the token matches the selected environment (staging tokens don't work on production and vice versa).",
      });
    }
  }

  const data = JSON.parse(formData.get("data") as string);

  const originPin = String(data.originPin || "").trim();
  if (originPin && !/^\d{6}$/.test(originPin)) {
    return json({ error: "Origin PIN must be exactly 6 digits." }, { status: 400 });
  }
  const bufferDays = parseInt(String(data.bufferDays), 10);
  if (isNaN(bufferDays) || bufferDays < 0 || bufferDays > 10) {
    return json({ error: "Dispatch buffer must be between 0 and 10 days." }, { status: 400 });
  }
  const environment = data.environment === "production" ? "production" : "staging";
  const PLACEMENTS = ["below-atc", "above-atc", "below-description"];
  const placement = PLACEMENTS.includes(data.placement) ? data.placement : "below-atc";
  const newToken = String(data.apiToken || "").trim();

  try {
    await prisma.deliverySettings.upsert({
      where: { shop: session.shop },
      create: {
        shop: session.shop,
        isEnabled: data.isEnabled,
        apiToken: newToken,
        originPin,
        bufferDays,
        environment,
        placement,
      },
      update: {
        isEnabled: data.isEnabled,
        // Empty token field means "keep the saved token".
        ...(newToken ? { apiToken: newToken } : {}),
        originPin,
        bufferDays,
        environment,
        placement,
      },
    });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  } catch (error) {
    return json({ error: "Failed to save settings" }, { status: 500 });
  }
};

type ActionData = {
  success?: boolean;
  error?: string;
  testResult?: string;
  testError?: string;
};

export default function DeliveryEstimate() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const submit = useSubmit();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  const initial = {
    enabled: loaderData.isEnabled,
    apiToken: "",
    originPin: loaderData.originPin,
    bufferDays: String(loaderData.bufferDays),
    environment: loaderData.environment,
    placement: loaderData.placement,
  };

  const [enabled, setEnabled] = useState(initial.enabled);
  const [apiToken, setApiToken] = useState(initial.apiToken);
  const [originPin, setOriginPin] = useState(initial.originPin);
  const [bufferDays, setBufferDays] = useState(initial.bufferDays);
  const [environment, setEnvironment] = useState(initial.environment);
  const [placement, setPlacement] = useState(initial.placement);
  const [testPincode, setTestPincode] = useState("");
  const [showSuccess, setShowSuccess] = useState(false);

  const isDirty =
    enabled !== initial.enabled ||
    apiToken !== initial.apiToken ||
    originPin !== initial.originPin ||
    bufferDays !== initial.bufferDays ||
    environment !== initial.environment ||
    placement !== initial.placement;

  useEffect(() => {
    if (actionData?.success) {
      setShowSuccess(true);
      setApiToken("");
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const handleDiscard = () => {
    setEnabled(initial.enabled);
    setApiToken(initial.apiToken);
    setOriginPin(initial.originPin);
    setBufferDays(initial.bufferDays);
    setEnvironment(initial.environment);
    setPlacement(initial.placement);
  };

  const handleSave = () => {
    const data = {
      isEnabled: enabled,
      apiToken,
      originPin,
      bufferDays,
      environment,
      placement,
    };
    submit({ data: JSON.stringify(data) }, { method: "POST" });
  };

  const handleTest = () => {
    submit({ intent: "test", testPincode }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Delivery Estimate">
        <button onClick={handleDiscard}>Discard</button>
        <button variant="primary" onClick={handleSave} disabled={!isDirty}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {showSuccess && <Banner tone="success">Settings saved successfully.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            <Banner tone="info">
              Once enabled, the widget appears automatically on your product pages under
              the Add to Cart button — no theme changes needed. Allow up to 1 hour for it
              to appear or disappear, and up to 6 hours for delivery-date updates (results
              are cached at the edge). Tip: to control the exact placement, you can
              instead add the "Delivery Estimate" app block in the theme editor.
            </Banner>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Delivery Estimate Widget</Text>
                <Text as="p" tone="subdued">
                  Lets shoppers enter their PIN code on the product page and see an
                  estimated delivery date, powered by your Delhivery account.
                </Text>
                <Checkbox
                  label="Enable delivery estimate"
                  helpText="When disabled, the widget stays hidden on your storefront"
                  checked={enabled}
                  onChange={setEnabled}
                />
                <Select
                  label="Placement on product page"
                  options={[
                    { label: "Below Add to Cart button", value: "below-atc" },
                    { label: "Above Add to Cart button", value: "above-atc" },
                    { label: "Below product description", value: "below-description" },
                  ]}
                  value={placement}
                  onChange={setPlacement}
                  helpText="Where the PIN-code checker appears on your product pages"
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Delhivery Configuration</Text>
                <TextField
                  label="Delhivery API token"
                  value={apiToken}
                  onChange={setApiToken}
                  autoComplete="off"
                  placeholder={
                    loaderData.hasToken
                      ? `Saved token ending in ${loaderData.tokenPreview} — enter a new token to replace it`
                      : "Paste your Delhivery API token"
                  }
                  helpText="Found in your Delhivery One portal under API setup. Stored securely — never sent to your storefront."
                />
                <TextField
                  label="Origin PIN code"
                  value={originPin}
                  onChange={(v) => setOriginPin(v.replace(/\D/g, "").slice(0, 6))}
                  autoComplete="off"
                  inputMode="numeric"
                  placeholder="e.g. 110041"
                  helpText="The 6-digit pincode of the warehouse you dispatch orders from"
                />
                <TextField
                  label="Dispatch buffer (business days)"
                  type="number"
                  value={bufferDays}
                  onChange={setBufferDays}
                  autoComplete="off"
                  min={0}
                  max={10}
                  helpText="How many business days you need before an order ships. Saturdays and Sundays are skipped."
                />
                <Select
                  label="Delhivery environment"
                  options={[
                    { label: "Staging (testing)", value: "staging" },
                    { label: "Production (live)", value: "production" },
                  ]}
                  value={environment}
                  onChange={setEnvironment}
                  helpText="Staging serves only a handful of test pincodes and needs a staging token. Switch to Production when going live."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Test a PIN code</Text>
                <Text as="p" tone="subdued">
                  Checks your saved settings against Delhivery right now, bypassing the
                  storefront cache. Save your settings first.
                </Text>
                {actionData?.testResult && <Banner tone="success">{actionData.testResult}</Banner>}
                {actionData?.testError && <Banner tone="warning">{actionData.testError}</Banner>}
                <InlineStack gap="200" blockAlign="end" wrap={false}>
                  <div style={{ flexGrow: 1 }}>
                    <TextField
                      label="Destination PIN code"
                      labelHidden
                      value={testPincode}
                      onChange={(v) => setTestPincode(v.replace(/\D/g, "").slice(0, 6))}
                      autoComplete="off"
                      inputMode="numeric"
                      placeholder="Enter a 6-digit PIN code"
                    />
                  </div>
                  <Button onClick={handleTest} loading={isSubmitting} disabled={testPincode.length !== 6}>
                    Test
                  </Button>
                </InlineStack>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
