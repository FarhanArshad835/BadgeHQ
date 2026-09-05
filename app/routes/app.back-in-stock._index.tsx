/**
 * Back in Stock activity: who is waiting, for what, and whether they were told.
 *
 * The headline the merchant actually acts on is "still waiting", not "signups":
 * a queue of people on one sold-out variant is a restock decision, and it is
 * current state rather than something a date range should hide.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams, useNavigation } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Badge,
  Button,
  Select,
  IndexTable,
  Banner,
  Box,
  Link,
  TextField,
  Spinner,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  backInStockStats,
  recentBackInStockActivity,
  variantLabels,
} from "../utils/back-in-stock-stats.server";
import { DailyTrend } from "../components/DailyTrend";
import { Stat, RankedList, ago, nfmt } from "../components/Stats";

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * The presets, each resolved to an explicit IST day range.
 *
 * Deliberately not a map of day COUNTS: "yesterday" is the one preset that does
 * not end today, and expressing it as a count forces a special case at every
 * call site. Returning both ends keeps the loader a single lookup.
 */
const WINDOWS: Record<string, (today: string) => { from: string; to: string }> = {
  today: (t) => ({ from: t, to: t }),
  yesterday: (t) => ({ from: addDays(t, -1), to: addDays(t, -1) }),
  "7d": (t) => ({ from: addDays(t, -6), to: t }),
  "30d": (t) => ({ from: addDays(t, -29), to: t }),
  "90d": (t) => ({ from: addDays(t, -89), to: t }),
};

const WINDOW_OPTIONS = [
  { label: "Today", value: "today" },
  { label: "Yesterday", value: "yesterday" },
  { label: "Last 7 days", value: "7d" },
  { label: "Last 30 days", value: "30d" },
  { label: "Last 90 days", value: "90d" },
  { label: "Custom range", value: "custom" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const requested = params.get("window") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";

  // A custom range wins when both ends are well-formed; anything else falls back
  // to a preset. Both are validated: these values become query bounds.
  const custom = ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to;
  const windowKey = custom ? "custom" : WINDOWS[requested] ? requested : "7d";

  const today = istToday();
  const preset = custom ? null : WINDOWS[windowKey](today);
  const fromDay = preset ? preset.from : from;
  // Never run a custom range past today: future days would plot as a flat zero
  // tail and read as a collapse in signups.
  const toDay = preset ? preset.to : to > today ? today : to;

  const [stats, activity, settings] = await Promise.all([
    backInStockStats(session.shop, fromDay, toDay),
    recentBackInStockActivity(session.shop, 50),
    prisma.backInStockSettings.findUnique({ where: { shop: session.shop } }),
  ]);

  // One Admin API round trip covering both the ranked list and the feed, so the
  // merchant never sees a bare variant id anywhere on the page.
  const labels = await variantLabels(admin, [
    ...stats.topVariants.map((v) => v.variantId),
    ...activity.map((a) => a.variantId),
  ]);
  const nameOf = (variantId: string) =>
    labels.get(variantId)?.label ?? `Variant ${variantId.split("/").pop()}`;
  const handleOf = (variantId: string) => labels.get(variantId)?.productId ?? "";

  return json({
    windowKey,
    fromDay,
    toDay,
    shopDomain: session.shop,
    stats,
    // Notifications only go out once WhatsApp is connected; without this the
    // page would show a growing queue and never say why nobody was messaged.
    waReady: Boolean(settings?.waEnabled && settings?.waApiKey && settings?.waTemplateName),
    topVariants: stats.topVariants.map((v) => ({
      label: nameOf(v.variantId),
      count: v.count,
      handle: handleOf(v.variantId),
    })),
    activity: activity.map((a) => ({
      id: a.id,
      when: a.createdAt.toISOString(),
      phone: a.phone,
      product: nameOf(a.variantId),
      handle: handleOf(a.variantId),
      notified: Boolean(a.notifiedAt),
    })),
  });
};

export default function BackInStockActivityPage() {
  const d = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const nav = useNavigation();
  const s = d.stats;

  // The loader re-runs on every range change, so on a slow connection the page
  // sat there looking broken. This drives a spinner and dims the stale figures.
  const loading = nav.state === "loading";

  const [customFrom, setCustomFrom] = useState(d.fromDay);
  const [customTo, setCustomTo] = useState(d.toDay);
  const [showCustom, setShowCustom] = useState(d.windowKey === "custom");

  const applyCustom = () => {
    if (customFrom && customTo && customFrom <= customTo) {
      setSearchParams({ from: customFrom, to: customTo });
    }
  };

  const dim = { opacity: loading ? 0.5 : 1, transition: "opacity 150ms" };

  return (
    <Page fullWidth>
      <TitleBar title="Back in Stock" />
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Select
              label="Period"
              labelHidden
              disabled={loading}
              options={WINDOW_OPTIONS}
              value={d.windowKey}
              onChange={(v) => {
                if (v === "custom") {
                  setShowCustom(true); // reveal the fields; don't reload yet
                } else {
                  setShowCustom(false);
                  setSearchParams({ window: v });
                }
              }}
            />
            {showCustom && (
              <>
                <TextField
                  label="From"
                  labelHidden
                  type="date"
                  value={customFrom}
                  onChange={setCustomFrom}
                  autoComplete="off"
                  max={d.toDay}
                />
                <TextField
                  label="To"
                  labelHidden
                  type="date"
                  value={customTo}
                  onChange={setCustomTo}
                  autoComplete="off"
                  min={customFrom}
                />
                <Button
                  onClick={applyCustom}
                  loading={loading}
                  disabled={!customFrom || !customTo || customFrom > customTo}
                >
                  Apply
                </Button>
              </>
            )}
            {/* Something must acknowledge the click, or a slow load reads as a
                dead control and gets clicked again. */}
            {loading && <Spinner accessibilityLabel="Loading" size="small" />}
          </InlineStack>
          <Button url="/app/back-in-stock/settings">Settings</Button>
        </InlineStack>

        {s.signups === 0 && s.waiting === 0 && (
          <Banner tone="info">
            No signups yet. Shoppers see the notify form on sold-out variants once the feature is
            switched on.
          </Banner>
        )}

        {/* A queue with no way to message it is the one thing worth interrupting
            for, and the fix is one click away rather than described. */}
        {s.waiting > 0 && !d.waReady && (
          <Banner
            tone="warning"
            title={`${nfmt(s.waiting)} ${s.waiting === 1 ? "shopper is" : "shoppers are"} waiting, but nobody can be notified`}
            action={{ content: "Connect WhatsApp", url: "/app/back-in-stock/settings" }}
          >
            <p>
              Signups are being collected. Connect WhatsApp so these shoppers hear from you when
              stock returns.
            </p>
          </Banner>
        )}

        {/* Dim what is about to be replaced: showing the previous period's
            numbers at full strength during a load invites misreading them. */}
        <div style={dim}>
          <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="300">
            <Stat
              label="Still waiting"
              value={nfmt(s.waiting)}
              sub="Across all time, not just this range"
            />
            <Stat label="Signups" value={nfmt(s.signups)} sub={`${nfmt(s.notified)} notified`} />
            <Stat label="Shoppers" value={nfmt(s.shoppers)} />
            <Stat label="Products wanted" value={nfmt(s.products)} />
            <Stat
              label="Notified"
              value={s.signups > 0 ? `${Math.round((s.notified / s.signups) * 100)}%` : "0%"}
              sub={`${nfmt(s.notified)} of ${nfmt(s.signups)} signups`}
            />
          </InlineGrid>
        </div>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Signups per day</Text>
            <div style={dim}>
              <DailyTrend points={s.days} noun="signups" />
            </div>
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <RankedList
            title="Restock these first"
            items={d.topVariants.map((v) => ({
              label: v.label,
              count: v.count,
              url: v.handle ? `https://${d.shopDomain}/products/${v.handle}` : undefined,
            }))}
            empty="Nobody is waiting on anything right now."
          />

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Notification status</Text>
              <InlineStack gap="200">
                <Badge tone="attention">{`${nfmt(s.waiting)} waiting`}</Badge>
                <Badge tone="success">{`${nfmt(s.notified)} notified in range`}</Badge>
                <Badge tone={d.waReady ? "success" : "critical"}>
                  {d.waReady ? "WhatsApp connected" : "WhatsApp not connected"}
                </Badge>
              </InlineStack>
              <Text as="p" tone="subdued">
                Shoppers are messaged on the WhatsApp number they type in themselves. No Shopify
                customer data is used to reach them.
              </Text>
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card padding="0">
          <Box padding="300">
            <Text as="h2" variant="headingMd">Recent signups</Text>
          </Box>
          <IndexTable
            resourceName={{ singular: "signup", plural: "signups" }}
            itemCount={d.activity.length}
            selectable={false}
            headings={[
              { title: "WhatsApp" },
              { title: "Product" },
              { title: "Signed up" },
              { title: "Status" },
            ]}
          >
            {d.activity.map((a, i) => (
              <IndexTable.Row id={a.id} key={a.id} position={i}>
                <IndexTable.Cell>
                  {/* A tel: link is the only useful action here: the merchant
                      cannot open a Shopify customer record for a number that was
                      typed into a storefront form. */}
                  <Link url={`tel:+91${a.phone}`} removeUnderline>
                    +91 {a.phone}
                  </Link>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {a.handle ? (
                    <Link url={`https://${d.shopDomain}/products/${a.handle}`} target="_blank" removeUnderline>
                      {a.product}
                    </Link>
                  ) : (
                    <Text as="span">{a.product}</Text>
                  )}
                </IndexTable.Cell>
                {/* Exact time on hover: "2 hours ago" scans faster, but the real
                    timestamp is what someone reconciling a complaint needs. */}
                <IndexTable.Cell>
                  <span title={new Date(a.when).toLocaleString("en-IN")}>{ago(a.when)}</span>
                </IndexTable.Cell>
                <IndexTable.Cell>
                  {a.notified ? (
                    <Badge tone="success">Notified</Badge>
                  ) : (
                    <Badge tone="attention">Waiting</Badge>
                  )}
                </IndexTable.Cell>
              </IndexTable.Row>
            ))}
          </IndexTable>
        </Card>

        {/* The embedded frame clips at the last element, so the table sat flush
            against the bottom edge with nothing to breathe into. */}
        <Box paddingBlockEnd="800" />
      </BlockStack>
    </Page>
  );
}
