/**
 * Wishlist analytics: what shoppers are saving, and whether Meta received it.
 *
 * All of it comes from WishlistEvent, which starts at the moment this feature
 * shipped. There is no retroactive data, and the page says so instead of letting
 * a small number read as a quiet week.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useSearchParams } from "@remix-run/react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { wishlistStats, recentWishlistActivity } from "../utils/wishlist-stats.server";
import { WishlistTrend } from "../components/WishlistTrend";

const WINDOWS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const requested = new URL(request.url).searchParams.get("window") || "";
  // Whitelist rather than trusting the param: it drives a query bound.
  const windowKey = WINDOWS[requested] ? requested : "7d";

  const [stats, activity] = await Promise.all([
    wishlistStats(session.shop, WINDOWS[windowKey]),
    recentWishlistActivity(session.shop, 50),
  ]);

  return json({
    windowKey,
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
  const s = d.stats;
  const n = (v: number) => v.toLocaleString("en-IN");

  return (
    <Page fullWidth>
      <TitleBar title="Wishlist" />
      <BlockStack gap="300">
        <InlineStack align="space-between" blockAlign="center">
          <Select
            label="Period"
            labelHidden
            options={[
              { label: "Last 7 days", value: "7d" },
              { label: "Last 30 days", value: "30d" },
              { label: "Last 90 days", value: "90d" },
            ]}
            value={d.windowKey}
            onChange={(v) => setSearchParams({ window: v })}
          />
          <InlineStack gap="200">
            <Button url="/app/wishlist/settings">Settings</Button>
            <Button variant="primary" url="/app/wishlist/export" download disabled={s.totalAdds === 0}>
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

        <Card>
          <BlockStack gap="300">
            <Text as="h2" variant="headingMd">Wishlist saves per day</Text>
            <WishlistTrend points={s.days} />
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
                      <Text as="span" truncate>{p.handle}</Text>
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
                          which this app does not hold, so the id is what we can show. */}
                      <Text as="span">Customer {c.customerId}</Text>
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
                <IndexTable.Cell>{a.customerId ? `Customer ${a.customerId}` : "Guest"}</IndexTable.Cell>
                <IndexTable.Cell>{a.handle}</IndexTable.Cell>
                <IndexTable.Cell>{ago(a.when)}</IndexTable.Cell>
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
      </BlockStack>
    </Page>
  );
}
