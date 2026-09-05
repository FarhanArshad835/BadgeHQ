/**
 * The shared pieces of a feature's activity dashboard: a headline figure, a
 * ranked list, and a daily trend chart.
 *
 * Extracted rather than copied so the three dashboards (Wishlist, Back in Stock,
 * Automated Replies) cannot drift apart in spacing, empty states or number
 * formatting.
 */
import { Card, BlockStack, InlineStack, Text, Link } from "@shopify/polaris";

/** Indian digit grouping, matching the rest of this India-first app. */
export const nfmt = (v: number) => v.toLocaleString("en-IN");

/**
 * A headline number. Deliberately not a chart: a single value needs no plot,
 * and a one-bar bar chart is the classic way to make a number harder to read.
 */
export function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
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

export type RankedItem = { label: string; count: number; url?: string };

/** A "top N" list: label on the left, count on the right, optional deep link. */
export function RankedList({
  title,
  items,
  empty,
}: {
  title: string;
  items: RankedItem[];
  empty: string;
}) {
  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h2" variant="headingMd">{title}</Text>
        {items.length === 0 ? (
          <Text as="p" tone="subdued">{empty}</Text>
        ) : (
          <BlockStack gap="200">
            {items.map((it) => (
              <InlineStack key={it.label} align="space-between" blockAlign="center">
                {it.url ? (
                  <Link url={it.url} target="_blank" removeUnderline>{it.label}</Link>
                ) : (
                  <Text as="span" truncate>{it.label}</Text>
                )}
                <Text as="span" fontWeight="semibold">{nfmt(it.count)}</Text>
              </InlineStack>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}

/** "3 minutes ago" reads faster than a timestamp in a live activity feed. */
export function ago(iso: string): string {
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? "" : "s"} ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}
