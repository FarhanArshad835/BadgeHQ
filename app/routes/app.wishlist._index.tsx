/**
 * Wishlist analytics: what shoppers are saving, and whether Meta received it.
 *
 * All of it comes from WishlistEvent, which starts at the moment this feature
 * shipped. There is no retroactive data, and the page says so instead of letting
 * a small number read as a quiet week.
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
import { wishlistStats, recentWishlistActivity } from "../utils/wishlist-stats.server";
import { WishlistTrend } from "../components/WishlistTrend";

const WINDOWS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };
const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Today in IST, as YYYY-MM-DD. */
function istToday(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const params = new URL(request.url).searchParams;
  const requested = params.get("window") || "";
  const from = params.get("from") || "";
  const to = params.get("to") || "";

  // A custom range wins when both ends are well-formed; anything else falls back
  // to a preset. Both are validated: these values become query bounds.
  const custom = ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to;
  const windowKey = custom ? "custom" : WINDOWS[requested] ? requested : "7d";

  const today = istToday();
  const fromDay = custom ? from : addDays(today, -(WINDOWS[windowKey] - 1));
  // Never let a custom range run past today: future days would plot as a flat
  // zero tail and read as a collapse in activity.
  const toDay = custom ? (to > today ? today : to) : today;

  const [stats, activity] = await Promise.all([
    wishlistStats(session.shop, fromDay, toDay),
    recentWishlistActivity(session.shop, 50),
  ]);

  return json({
    windowKey,
    fromDay,
    toDay,
    // Shop handle, for deep links into the Shopify admin and storefront.
    shopHandle: session.shop.replace(".myshopify.com", ""),
    shopDomain: session.shop,
    stats,
    activity: activity.map((a) => ({
      id: a.id,
      when: a.createdAt.toISOString(),
      customerId: a.customerId,
      handle: a.handle,
      action: a.action,
      metaStatus: a.metaStatus,
    })),
  });
};

/** "3 minutes ago" reads faster than a timestamp for a live activity feed. */
function ago(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A headline number with its label. Not a chart: one value needs no plot. */
function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="p" variant="bodySm" tone="subdued">{label}</Text>
        <Text as="p" variant="heading2xl">{value}</Text>
        {sub && <Text as="p" variant="bodySm" tone="subdued">{sub}</Text>}
      </BlockStack>
    </Card>
  );
}

export default function WishlistActivityPage() {
  const d = useLoaderData<typeof loader>();
  const [, setSearchParams] = useSearchParams();
  const nav = useNavigation();
  const s = d.stats;
  const n = (v: number) => v.toLocaleString("en-IN");

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

  return (
    <Page fullWidth>
      <TitleBar title="Wishlist" />
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <InlineStack gap="200" blockAlign="center">
            <Select
              label="Period"
              labelHidden
              disabled={loading}
              options={[
                { label: "Last 7 days", value: "7d" },
                { label: "Last 30 days", value: "30d" },
                { label: "Last 90 days", value: "90d" },
                { label: "Custom range", value: "custom" },
              ]}
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
          <InlineStack gap="200">
            <Button url="/app/wishlist/settings">Settings</Button>
            {/* target=_blank, not `download`: the app runs in the Shopify admin's
                iframe, where a same-frame download is blocked by the sandbox and
                simply does nothing. Opening outside the frame lets it save. */}
            <Button
              variant="primary"
              url={`/app/wishlist/export?from=${d.fromDay}&to=${d.toDay}`}
              target="_blank"
              disabled={s.totalAdds === 0}
            >
              Export to CSV
            </Button>
          </InlineStack>
        </InlineStack>

        {s.totalAdds === 0 && (
          <Banner tone="info">
            No wishlist activity recorded yet. Saves are recorded from the moment the feature was
            switched on, so anything wishlisted before that is not counted here.
          </Banner>
        )}

        {/* Saves are landing but nothing is reaching Meta: the single most useful
            thing to say here, with the fix one click away rather than described. */}
        {s.totalAdds > 0 && s.sentToMeta === 0 && (
          <Banner
            tone="warning"
            title="These saves are not reaching Meta"
            action={{ content: "Set up Meta", url: "/app/wishlist/settings" }}
          >
            <p>
              Wishlist saves are being recorded, but Meta is not receiving them, so shoppers are not
              being retargeted. Add your dataset id and access token to turn it on.
            </p>
          </Banner>
        )}

        {s.failedToMeta > 0 && (
          <Banner
            tone="critical"
            title={`${n(s.failedToMeta)} ${s.failedToMeta === 1 ? "event" : "events"} could not be sent to Meta`}
            action={{ content: "Check settings", url: "/app/wishlist/settings" }}
          >
            <p>Usually an expired or invalid access token. Generate a new one in Events Manager.</p>
          </Banner>
        )}

        {/* Dim what is about to be replaced: showing the previous period's
            numbers at full strength during a load invites misreading them. */}
        <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 150ms" }}>
        <InlineGrid columns={{ xs: 1, sm: 2, md: 3, lg: 5 }} gap="300">
          <Stat label="Wishlist saves" value={n(s.totalAdds)} sub={`${n(s.removes)} removed`} />
          <Stat label="Customers" value={n(s.customers)} sub={`${n(s.guestAdds)} guest saves`} />
          <Stat label="Products saved" value={n(s.products)} />
          <Stat label="Sent to Meta" value={n(s.sentToMeta)} sub={s.failedToMeta > 0 ? `${n(s.failedToMeta)} failed` : undefined} />
          <Stat
            label="Saves per customer"
            value={s.customers > 0 ? (s.totalAdds / s.customers).toFixed(1) : "0"}
          />
        </InlineGrid>
        </div>

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Wishlist saves per day</Text>
            <div style={{ opacity: loading ? 0.5 : 1, transition: "opacity 150ms" }}>
              <WishlistTrend points={s.days} />
            </div>
          </BlockStack>
        </Card>

        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Most wishlisted products</Text>
              {s.topProducts.length === 0 ? (
                <Text as="p" tone="subdued">Nothing saved yet.</Text>
              ) : (
                <BlockStack gap="200">
                  {s.topProducts.map((p) => (
                    <InlineStack key={p.handle} align="space-between" blockAlign="center">
                      {/* Opens the live product page: we store the handle, and a
                          handle addresses the storefront directly without needing
                          a product-id lookup. */}
                      <Link
                        url={`https://${d.shopDomain}/products/${p.handle}`}
                        target="_blank"
                        removeUnderline
                      >
                        {p.handle}
                      </Link>
                      <Text as="span" fontWeight="semibold">{n(p.count)}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">Most active customers</Text>
              {s.topCustomers.length === 0 ? (
                <Text as="p" tone="subdued">
                  No logged-in customers yet. Guests are counted in the totals above, but they
                  cannot be identified.
                </Text>
              ) : (
                <BlockStack gap="200">
                  {s.topCustomers.map((c) => (
                    <InlineStack key={c.customerId} align="space-between" blockAlign="center">
                      {/* Customer NAMES are Shopify Protected Customer Data Level 2,
                          which this app does not hold. Linking into the admin is the
                          honest answer: the merchant sees the name there, where they
                          are already entitled to it. */}
                      <Link
                        url={`https://admin.shopify.com/store/${d.shopHandle}/customers/${c.customerId}`}
                        target="_blank"
                        removeUnderline
                      >
                        Customer {c.customerId}
                      </Link>
                      <Text as="span" fontWeight="semibold">{n(c.count)}</Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
        </InlineGrid>

        <Card padding="0">
          <Box padding="300">
            <Text as="h2" variant="headingMd">Recent activity</Text>
          </Box>
          <IndexTable
            resourceName={{ singular: "activity", plural: "activities" }}
            itemCount={d.activity.length}
            selectable={false}
            headings={[
              { title: "Customer" },
              { title: "Product" },
              { title: "When" },
              { title: "Action" },
              { title: "Meta" },
            ]}
          >
            {d.activity.map((a, i) => (
              <IndexTable.Row id={a.id} key={a.id} position={i}>
                <IndexTable.Cell>
                  {a.customerId ? (
                    <Link
                      url={`https://admin.shopify.com/store/${d.shopHandle}/customers/${a.customerId}`}
                      target="_blank"
                      removeUnderline
                    >
                      Customer {a.customerId}
                    </Link>
                  ) : (
                    // A guest has no Shopify record to open, so this stays plain
                    // text rather than a link that would go nowhere.
                    <Text as="span" tone="subdued">Guest</Text>
                  )}
                </IndexTable.Cell>
                <IndexTable.Cell>
                  <Link url={`https://${d.shopDomain}/products/${a.handle}`} target="_blank" removeUnderline>
                    {a.handle}
                  </Link>
                </IndexTable.Cell>
                {/* Exact time on hover: "2 hours ago" is easier to scan, but the
                    real timestamp is what someone reconciling against Meta needs. */}
                <IndexTable.Cell>
                  <span title={new Date(a.when).toLocaleString("en-IN")}>{ago(a.when)}</span>
                </IndexTable.Cell>
                <IndexTable.Cell>{a.action === "add" ? "Saved" : "Removed"}</IndexTable.Cell>
                <IndexTable.Cell>
                  {a.metaStatus === "sent" ? (
                    <Badge tone="success">Sent</Badge>
                  ) : a.metaStatus === "failed" ? (
                    <Badge tone="critical">Failed</Badge>
                  ) : a.metaStatus === "pending" ? (
                    <Badge tone="attention">Pending</Badge>
                  ) : (
                    <Badge>Off</Badge>
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
