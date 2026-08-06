import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSearchParams, useSubmit } from "@remix-run/react";
import { useState } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  Button,
  Badge,
  Banner,
  Select,
  Tabs,
  IndexTable,
  Box,
  Divider,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate, unauthenticated } from "../shopify.server";
import prisma from "../db.server";
import { rollup, completeness, type OrderRow } from "../utils/pnl.server";
import { syncRevenueAndCogs, backfillShipping } from "../utils/pnl-sync.server";
// formatMinor is a plain (non-.server) module — the client component renders
// amounts with it, so it must NOT come from a .server file.
import { formatMinor } from "../utils/money";

// ── date windows (IST) ───────────────────────────────────────────────────────
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/** Start-of-day IST for `daysAgo` days back, returned as a UTC Date. */
function istDayStart(daysAgo: number): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - daysAgo);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

const WINDOWS: Record<string, { label: string; since: () => Date }> = {
  today: { label: "Today", since: () => istDayStart(0) },
  "7d": { label: "Last 7 days", since: () => istDayStart(6) },
  "30d": { label: "Last 30 days", since: () => istDayStart(29) },
  "90d": { label: "Last 90 days", since: () => istDayStart(89) },
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const url = new URL(request.url);
  const windowKey = WINDOWS[url.searchParams.get("window") || "7d"] ? url.searchParams.get("window")! : "7d";
  const since = WINDOWS[windowKey].since();

  const orders = await prisma.orderFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: since } },
    orderBy: { orderCreatedAt: "desc" },
    select: {
      orderId: true,
      orderName: true,
      orderCreatedAt: true,
      currency: true,
      grossRevenueMinor: true,
      refundsMinor: true,
      cogsMinor: true,
      cogsComplete: true,
      shippingCostMinor: true,
      shippingStatus: true,
      dataComplete: true,
    },
  });

  const rows: OrderRow[] = orders.map((o) => ({
    orderCreatedAt: o.orderCreatedAt,
    grossRevenueMinor: o.grossRevenueMinor,
    refundsMinor: o.refundsMinor,
    cogsMinor: o.cogsMinor,
    cogsComplete: o.cogsComplete,
    shippingCostMinor: o.shippingCostMinor,
    shippingStatus: o.shippingStatus,
    dataComplete: o.dataComplete,
  }));

  const agg = rollup(rows);
  const comp = completeness(rows);
  const currency = orders[0]?.currency || "INR";

  // Per-product rollup from the line cache.
  const lines = await prisma.orderLineFinancials.findMany({
    where: { shop, orderCreatedAt: { gte: since } },
    select: {
      productId: true,
      productTitle: true,
      quantity: true,
      lineRevenueMinor: true,
      lineCogsMinor: true,
      lineCogsComplete: true,
    },
  });
  const productMap = new Map<
    string,
    { title: string; units: number; revenue: bigint; cogs: bigint; cogsComplete: boolean }
  >();
  for (const l of lines) {
    const key = l.productId || l.productTitle || "unknown";
    const p =
      productMap.get(key) ||
      { title: l.productTitle || "(untitled)", units: 0, revenue: 0n, cogs: 0n, cogsComplete: true };
    p.units += l.quantity;
    p.revenue += l.lineRevenueMinor;
    if (l.lineCogsMinor != null) p.cogs += l.lineCogsMinor;
    if (!l.lineCogsComplete) p.cogsComplete = false;
    productMap.set(key, p);
  }
  const products = Array.from(productMap.values())
    .map((p) => ({
      title: p.title,
      units: p.units,
      revenueMinor: p.revenue.toString(),
      cogsMinor: p.cogsComplete ? p.cogs.toString() : null,
      // Margin ex-shipping-ex-ad — only when COGS is complete.
      marginMinor: p.cogsComplete ? (p.revenue - p.cogs).toString() : null,
    }))
    .sort((a, b) => Number(BigInt(b.marginMinor ?? "0") - BigInt(a.marginMinor ?? "0")));

  // bigint → string at the JSON boundary (Remix can't serialize bigint).
  return json({
    windowKey,
    lastSync: (await prisma.pnlSettings.findUnique({ where: { shop }, select: { lastSyncAt: true, lastSyncStatus: true } })) ?? null,
    currency,
    kpis: {
      orders: agg.orders,
      revenue: agg.revenueMinor.toString(),
      refunds: agg.refundsMinor.toString(),
      cogs: agg.cogsMinor.toString(),
      shipping: agg.shippingMinor.toString(),
      confirmedMargin: agg.confirmedMarginMinor.toString(),
      provisionalMargin: agg.provisionalMarginMinor.toString(),
    },
    completeness: comp,
    perOrder: orders.slice(0, 200).map((o) => ({
      name: o.orderName,
      at: o.orderCreatedAt,
      revenue: o.grossRevenueMinor.toString(),
      refunds: o.refundsMinor.toString(),
      cogs: o.cogsMinor != null ? o.cogsMinor.toString() : null,
      shipping: o.shippingCostMinor != null ? o.shippingCostMinor.toString() : null,
      shippingStatus: o.shippingStatus,
      margin:
        o.dataComplete && o.cogsMinor != null && o.shippingCostMinor != null
          ? (o.grossRevenueMinor - o.refundsMinor - o.cogsMinor - o.shippingCostMinor).toString()
          : null,
    })),
    perProduct: products.slice(0, 200),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const windowKey = String(form.get("window") || "7d");
  const since = (WINDOWS[windowKey] || WINDOWS["7d"]).since();
  const until = new Date();

  try {
    // The page runs Sync-now bounded so it stays under the function timeout.
    const { admin } = await unauthenticated.admin(shop);
    const rc = await syncRevenueAndCogs(admin, shop, { since, until, maxPages: 20 });
    const bf = await backfillShipping(shop, { limit: 40 });
    await prisma.pnlSettings.upsert({
      where: { shop },
      create: { shop, lastSyncAt: new Date(), lastSyncStatus: `synced ${rc.orders} orders` },
      update: { lastSyncAt: new Date(), lastSyncStatus: `synced ${rc.orders} orders` },
    });
    return json({
      ok: true,
      message: `Synced ${rc.orders} orders. Shipping billed for ${bf.billed}, ${bf.stillPending} still pending.`,
    });
  } catch (e: any) {
    console.error("[pnl] sync failed", e);
    return json({ ok: false, message: "Sync failed. Check that carrier and Shopify access are set up." }, { status: 500 });
  }
};

export default function PnlPage() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const submit = useSubmit();
  const nav = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState(0);
  const busy = nav.state !== "idle";

  const fmt = (minor: string | null, pending = "—") =>
    minor == null ? pending : formatMinor(BigInt(minor), d.currency);
  const fmtDate = (iso: string) =>
    new Date(iso).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short" });

  const onWindowChange = (v: string) => {
    const p = new URLSearchParams(searchParams);
    p.set("window", v);
    setSearchParams(p);
  };
  const onSync = () => submit({ window: d.windowKey }, { method: "POST" });

  const k = d.kpis;
  const comp = d.completeness;

  return (
    <Page>
      <TitleBar title="Profit & Loss" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Select
                label="Period"
                labelInline
                options={Object.entries(WINDOWS).map(([v, w]) => ({ label: w.label, value: v }))}
                value={d.windowKey}
                onChange={onWindowChange}
              />
              <InlineStack gap="200" blockAlign="center">
                {d.lastSync?.lastSyncAt && (
                  <Text as="span" tone="subdued" variant="bodySm">
                    Last synced {new Date(d.lastSync.lastSyncAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}
                  </Text>
                )}
                <Button variant="primary" onClick={onSync} loading={busy}>
                  Sync now
                </Button>
              </InlineStack>
            </InlineStack>

            {actionData?.message && (
              <Banner tone={actionData.ok ? "success" : "critical"}>{actionData.message}</Banner>
            )}

            <Banner tone={comp.pct >= 90 ? "success" : comp.pct >= 60 ? "info" : "warning"}>
              Cost data is complete for <strong>{comp.pct}%</strong> of orders ({comp.fullyComplete}/{comp.total}).
              {comp.total - comp.shippingBilled > 0 && ` Shipping pending on ${comp.total - comp.shippingBilled}.`}
              {comp.total - comp.cogsComplete > 0 && ` Cost-per-item missing on ${comp.total - comp.cogsComplete}.`}
              {" "}Costs are never estimated — pending figures are shown as “—”.
            </Banner>

            <Tabs
              selected={tab}
              onSelect={setTab}
              tabs={[
                { id: "glance", content: "At a glance" },
                { id: "orders", content: "Per order" },
                { id: "products", content: "Per product" },
              ]}
            >
              <Box paddingBlockStart="400">
                {tab === 0 && (
                  <BlockStack gap="400">
                    <InlineGrid columns={{ xs: 1, sm: 2, md: 3 }} gap="400">
                      <KpiTile label="Revenue" value={fmt(k.revenue)} />
                      <KpiTile label="Refunds" value={"-" + fmt(k.refunds)} tone="subdued" />
                      <KpiTile
                        label="COGS"
                        value={"-" + fmt(k.cogs)}
                        tone="subdued"
                        note={comp.total - comp.cogsComplete > 0 ? `${comp.total - comp.cogsComplete} missing cost` : undefined}
                      />
                      <KpiTile
                        label="Shipping (actual)"
                        value={"-" + fmt(k.shipping)}
                        tone="subdued"
                        note={comp.total - comp.shippingBilled > 0 ? `${comp.total - comp.shippingBilled} pending` : undefined}
                      />
                      <KpiTile label="Confirmed margin" value={fmt(k.confirmedMargin)} strong />
                      <KpiTile label="Provisional margin" value={fmt(k.provisionalMargin)} note="incl. orders with pending costs" />
                    </InlineGrid>
                    <Text as="p" tone="subdued" variant="bodySm">
                      <strong>Confirmed margin</strong> counts only orders whose COGS and shipping are both fully known.
                      <strong> Provisional</strong> includes every order using the costs known so far (pending costs are simply
                      absent, never estimated), so it reads high until shipping bills. Ad spend is excluded in Phase 1.
                    </Text>
                  </BlockStack>
                )}

                {tab === 1 && (
                  <Card padding="0">
                    <IndexTable
                      resourceName={{ singular: "order", plural: "orders" }}
                      itemCount={d.perOrder.length}
                      selectable={false}
                      headings={[
                        { title: "Order" },
                        { title: "Date" },
                        { title: "Revenue" },
                        { title: "COGS" },
                        { title: "Shipping" },
                        { title: "Margin" },
                      ]}
                    >
                      {d.perOrder.map((o, i) => (
                        <IndexTable.Row id={String(i)} key={i} position={i}>
                          <IndexTable.Cell>{o.name || "—"}</IndexTable.Cell>
                          <IndexTable.Cell>{fmtDate(o.at as unknown as string)}</IndexTable.Cell>
                          <IndexTable.Cell>{fmt(o.revenue)}</IndexTable.Cell>
                          <IndexTable.Cell>{o.cogs == null ? <Badge tone="attention">Set cost</Badge> : fmt(o.cogs)}</IndexTable.Cell>
                          <IndexTable.Cell>
                            {o.shipping != null ? (
                              fmt(o.shipping)
                            ) : o.shippingStatus === "no-awb" ? (
                              <Badge>No AWB</Badge>
                            ) : o.shippingStatus === "unmatched" ? (
                              <Badge tone="warning">Unmatched</Badge>
                            ) : (
                              <Badge tone="info">Pending</Badge>
                            )}
                          </IndexTable.Cell>
                          <IndexTable.Cell>
                            {o.margin == null ? <Text as="span" tone="subdued">—</Text> : <strong>{fmt(o.margin)}</strong>}
                          </IndexTable.Cell>
                        </IndexTable.Row>
                      ))}
                    </IndexTable>
                  </Card>
                )}

                {tab === 2 && (
                  <BlockStack gap="200">
                    <Text as="p" tone="subdued" variant="bodySm">
                      Contribution margin per product, <strong>before shipping and ad spend</strong> (shipping is charged
                      per order, not per item, so splitting it here would be a guess). Sorted by total margin.
                    </Text>
                    <Card padding="0">
                      <IndexTable
                        resourceName={{ singular: "product", plural: "products" }}
                        itemCount={d.perProduct.length}
                        selectable={false}
                        headings={[
                          { title: "Product" },
                          { title: "Units" },
                          { title: "Revenue" },
                          { title: "COGS" },
                          { title: "Margin (ex-shipping)" },
                        ]}
                      >
                        {d.perProduct.map((p, i) => (
                          <IndexTable.Row id={String(i)} key={i} position={i}>
                            <IndexTable.Cell>{p.title}</IndexTable.Cell>
                            <IndexTable.Cell>{p.units}</IndexTable.Cell>
                            <IndexTable.Cell>{fmt(p.revenueMinor)}</IndexTable.Cell>
                            <IndexTable.Cell>{p.cogsMinor == null ? <Badge tone="attention">Set cost</Badge> : fmt(p.cogsMinor)}</IndexTable.Cell>
                            <IndexTable.Cell>
                              {p.marginMinor == null ? <Text as="span" tone="subdued">—</Text> : <strong>{fmt(p.marginMinor)}</strong>}
                            </IndexTable.Cell>
                          </IndexTable.Row>
                        ))}
                      </IndexTable>
                    </Card>
                  </BlockStack>
                )}
              </Box>
            </Tabs>

            {d.completeness.total === 0 && (
              <Card>
                <BlockStack gap="200">
                  <Text as="h2" variant="headingMd">No data yet</Text>
                  <Text as="p" tone="subdued">
                    Press <strong>Sync now</strong> to pull orders for this period. For accurate profit, set the
                    <strong> Cost per item</strong> on your Shopify products (without it, COGS shows “Set cost”, never zero),
                    and make sure your Shiprocket / Delhivery credentials are saved in the relevant settings pages.
                  </Text>
                  <Divider />
                  <Text as="p" tone="subdued" variant="bodySm">
                    Actual shipping cost is billed by the courier a few days after dispatch, so recent orders show
                    “Pending” until then — the figure is never estimated. Ad spend arrives in Phase 2.
                  </Text>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function KpiTile({
  label,
  value,
  tone,
  strong,
  note,
}: {
  label: string;
  value: string;
  tone?: "subdued";
  strong?: boolean;
  note?: string;
}) {
  return (
    <Card>
      <BlockStack gap="100">
        <Text as="span" tone="subdued" variant="bodySm">{label}</Text>
        <Text as="span" variant={strong ? "headingLg" : "headingMd"} tone={tone}>{value}</Text>
        {note && <Text as="span" tone="subdued" variant="bodySm">{note}</Text>}
      </BlockStack>
    </Card>
  );
}
