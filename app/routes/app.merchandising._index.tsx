/**
 * Collection Merchandising — choose which collections the engine reorders and
 * how it weights each signal.
 *
 * The ordering itself is written by the hourly cron, not from here. This screen
 * picks the collections, sets the weights, and offers a preview so a merchant
 * can see the resulting order BEFORE it touches a live collection.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useEffect } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  Text,
  Checkbox,
  Banner,
  Badge,
  Box,
  RangeSlider,
  Select,
  DataTable,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  getMerchSettings,
  fetchCollectionProducts,
  computeScores,
  rankProducts,
  runMerchandising,
} from "../utils/merchandise.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getMerchSettings(session.shop);

  // Every collection, so the merchant can choose. Product counts matter here:
  // a 1,000-product collection is a much heavier reorder than a 13-product one
  // and that should be visible when choosing.
  const res = await admin.graphql(
    `#graphql
    {
      collections(first: 100, sortKey: TITLE) {
        nodes { id title handle sortOrder productsCount { count } }
      }
    }`,
  );
  const body: any = await res.json();
  const collections = (body?.data?.collections?.nodes || []).map((c: any) => ({
    id: String(c.id),
    title: String(c.title),
    handle: String(c.handle),
    sortOrder: String(c.sortOrder),
    count: Number(c.productsCount?.count ?? 0),
  }));

  const lastRun = await prisma.merchandiseSettings.findUnique({
    where: { shop: session.shop },
    select: { lastRunAt: true, lastRunStatus: true },
  });

  return json({ settings, collections, lastRun });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  if (intent === "preview") {
    const collectionId = String(form.get("collectionId") || "");
    if (!collectionId) return json({ error: "Pick a collection to preview" }, { status: 400 });

    const s = await getMerchSettings(session.shop);
    const facts = await fetchCollectionProducts(admin, collectionId);
    if (!facts.length) return json({ error: "That collection has no products" }, { status: 400 });

    const rows = await prisma.$queryRawUnsafe<Array<{ productId: string; units: number }>>(
      `SELECT "productId", SUM(quantity)::int AS units
         FROM "OrderLineFinancials"
        WHERE shop = $1 AND "productId" <> ''
          AND "orderCreatedAt" >= NOW() - ($2 || ' days')::interval
        GROUP BY "productId"`,
      session.shop,
      String(s.salesWindowDays),
    );
    const sales = new Map(rows.map((r) => [r.productId, r.units]));
    const scored = computeScores(facts, sales, new Map(), s);
    const order = rankProducts(scored, s.sinkOutOfStock);

    // Titles only for what is shown — a preview should not cost a full catalogue read.
    const top = order.slice(0, 20);
    const tRes = await admin.graphql(
      `#graphql
      query Titles($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { id title totalInventory } } }`,
      { variables: { ids: top } },
    );
    const tBody: any = await tRes.json();
    const titleBy = new Map(
      (tBody?.data?.nodes || [])
        .filter(Boolean)
        .map((n: any) => [String(n.id), { title: String(n.title), inv: n.totalInventory }]),
    );
    const byId = new Map(scored.map((x) => [x.productId, x]));

    return json({
      preview: top.map((id, i) => {
        const sc = byId.get(id);
        const t = titleBy.get(id) as any;
        return {
          rank: i + 1,
          title: t?.title ?? id.split("/").pop(),
          score: sc?.score ?? 0,
          units: sc?.unitsSold ?? 0,
          inStock: sc?.inStock ?? true,
          parts: sc?.parts ?? [],
        };
      }),
      total: order.length,
    });
  }

  if (intent === "run") {
    const result = await runMerchandising(session.shop, admin);
    return json({ ran: result });
  }

  const data = JSON.parse(String(form.get("data") || "{}"));
  await prisma.merchandiseSettings.update({
    where: { shop: session.shop },
    data: {
      isEnabled: Boolean(data.isEnabled),
      collectionIds: JSON.stringify(data.collectionIds || []),
      weightSales: Number(data.weightSales) || 0,
      weightReviews: Number(data.weightReviews) || 0,
      weightNewArrival: Number(data.weightNewArrival) || 0,
      weightBehaviour: Number(data.weightBehaviour) || 0,
      useSales: Boolean(data.useSales),
      useReviews: Boolean(data.useReviews),
      useNewArrival: Boolean(data.useNewArrival),
      useBehaviour: Boolean(data.useBehaviour),
      weightCart: Number(data.weightCart) || 0,
      weightWish: Number(data.weightWish) || 0,
      weightDwell: Number(data.weightDwell) || 0,
      weightViews: Number(data.weightViews) || 0,
      useCart: Boolean(data.useCart),
      useWish: Boolean(data.useWish),
      useDwell: Boolean(data.useDwell),
      useViews: Boolean(data.useViews),
      newArrivalDays: Number(data.newArrivalDays) || 30,
      salesWindowDays: Number(data.salesWindowDays) || 30,
      sinkOutOfStock: Boolean(data.sinkOutOfStock),
    },
  });
  return json({ success: true });
};

export default function Merchandising() {
  const { settings, collections, lastRun } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const [isEnabled, setIsEnabled] = useState(settings.isEnabled);
  const [picked, setPicked] = useState<string[]>(settings.collectionIds);
  const [wSales, setWSales] = useState(settings.weightSales);
  const [wReviews, setWReviews] = useState(settings.weightReviews);
  const [wNew, setWNew] = useState(settings.weightNewArrival);
  const [useSales, setUseSales] = useState(settings.useSales);
  const [useReviews, setUseReviews] = useState(settings.useReviews);
  const [useNew, setUseNew] = useState(settings.useNewArrival);
  const [useCart, setUseCart] = useState(settings.useCart);
  const [useWish, setUseWish] = useState(settings.useWish);
  const [useDwell, setUseDwell] = useState(settings.useDwell);
  const [useViews, setUseViews] = useState(settings.useViews);
  const [wCart, setWCart] = useState(settings.weightCart);
  const [wWish, setWWish] = useState(settings.weightWish);
  const [wDwell, setWDwell] = useState(settings.weightDwell);
  const [wViews, setWViews] = useState(settings.weightViews);
  const [sink, setSink] = useState(settings.sinkOutOfStock);
  const [salesWindow, setSalesWindow] = useState(String(settings.salesWindowDays));
  const [newDays, setNewDays] = useState(String(settings.newArrivalDays));
  const [previewId, setPreviewId] = useState(settings.collectionIds[0] || "");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (actionData?.success) {
      setSaved(true);
      const t = setTimeout(() => setSaved(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const save = () =>
    submit(
      {
        data: JSON.stringify({
          isEnabled,
          collectionIds: picked,
          weightSales: wSales,
          weightReviews: wReviews,
          weightNewArrival: wNew,
          weightBehaviour: settings.weightBehaviour,
          useSales,
          useReviews,
          useNewArrival: useNew,
          useBehaviour: useCart || useWish || useDwell || useViews,
          weightCart: wCart,
          weightWish: wWish,
          weightDwell: wDwell,
          weightViews: wViews,
          useCart,
          useWish,
          useDwell,
          useViews,
          newArrivalDays: Number(newDays),
          salesWindowDays: Number(salesWindow),
          sinkOutOfStock: sink,
        }),
      },
      { method: "POST" },
    );

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const heavy = picked
    .map((id) => collections.find((c: any) => c.id === id))
    .filter(Boolean)
    .reduce((n: number, c: any) => n + c.count, 0);

  return (
    <Page>
      <TitleBar title="Collection Merchandising">
        <button variant="primary" onClick={save} disabled={busy}>Save</button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {saved && <Banner tone="success">Settings saved.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}
            {actionData?.ran && (
              <Banner tone="info">
                Reordered {actionData.ran.collections?.filter((c: any) => c.reordered).length ?? 0} of{" "}
                {actionData.ran.collections?.length ?? 0} collections.
              </Banner>
            )}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">How it works</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Products are ranked by how well they sell, how well they are reviewed and how new
                  they are, then that order is saved to Shopify as the collection&rsquo;s manual sort.
                  It runs hourly in the background, so it costs nothing per visitor and applies to
                  the whole collection rather than one page of it.
                </Text>
                <Checkbox
                  label="Enable automatic reordering"
                  checked={isEnabled}
                  onChange={setIsEnabled}
                  helpText="While off, nothing is written to any collection."
                />
                {lastRun?.lastRunAt && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    Last run: {new Date(lastRun.lastRunAt).toLocaleString("en-IN")} — {lastRun.lastRunStatus}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">Collections to manage</Text>
                  <Badge tone={picked.length ? "success" : undefined}>
                    {`${picked.length} selected · ${heavy.toLocaleString("en-IN")} products`}
                  </Badge>
                </InlineStack>
                <Text as="p" variant="bodyMd" tone="subdued">
                  Only the collections you tick are ever written to. Start with a few — each reorder
                  queues a job on Shopify, and large collections take longer to apply.
                </Text>
                <BlockStack gap="100">
                  {collections.map((c: any) => (
                    <InlineStack key={c.id} gap="300" blockAlign="center">
                      <Checkbox
                        label={c.title}
                        checked={picked.includes(c.id)}
                        onChange={() => toggle(c.id)}
                      />
                      <Text as="span" variant="bodySm" tone="subdued">
                        {c.count.toLocaleString("en-IN")} products
                        {c.sortOrder !== "MANUAL" ? " · will switch to manual sort" : ""}
                      </Text>
                    </InlineStack>
                  ))}
                </BlockStack>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">What decides the order</Text>

                <Checkbox label="Best sellers" checked={useSales} onChange={setUseSales}
                  helpText="Units sold in the window below. The strongest signal." />
                {useSales && (
                  <>
                    <RangeSlider label={`Weight: ${wSales}`} value={wSales} min={0} max={100}
                      onChange={(v) => setWSales(Number(v))} output />
                    <Select label="Sales window" value={salesWindow} onChange={setSalesWindow}
                      options={[
                        { label: "Last 7 days", value: "7" },
                        { label: "Last 14 days", value: "14" },
                        { label: "Last 30 days", value: "30" },
                        { label: "Last 60 days", value: "60" },
                        { label: "Last 90 days", value: "90" },
                      ]} />
                  </>
                )}

                <Checkbox label="Reviews" checked={useReviews} onChange={setUseReviews}
                  helpText="Review count from Doran." />
                {useReviews && (
                  <RangeSlider label={`Weight: ${wReviews}`} value={wReviews} min={0} max={100}
                    onChange={(v) => setWReviews(Number(v))} output />
                )}

                <Checkbox label="New arrivals" checked={useNew} onChange={setUseNew}
                  helpText="Boosts recently published products so they can gather sales history. Fades out across the window rather than stopping suddenly." />
                {useNew && (
                  <>
                    <RangeSlider label={`Weight: ${wNew}`} value={wNew} min={0} max={100}
                      onChange={(v) => setWNew(Number(v))} output />
                    <Select label="Counts as new for" value={newDays} onChange={setNewDays}
                      options={[
                        { label: "14 days", value: "14" },
                        { label: "30 days", value: "30" },
                        { label: "60 days", value: "60" },
                      ]} />
                  </>
                )}

                <Box paddingBlockStart="200">
                  <Text as="h3" variant="headingSm">From shopper behaviour</Text>
                  <Text as="p" variant="bodySm" tone="subdued">
                    Collected from the storefront. Each starts at zero and becomes useful after a
                    few days of traffic. They measure different things &mdash; an add to cart is
                    close to a purchase, a view barely counts &mdash; so each carries its own weight.
                  </Text>
                </Box>

                <Checkbox label="Added to cart" checked={useCart} onChange={setUseCart}
                  helpText="Net of removals. The strongest behavioural signal." />
                {useCart && (
                  <RangeSlider label={`Weight: ${wCart}`} value={wCart} min={0} max={100}
                    onChange={(v) => setWCart(Number(v))} output />
                )}

                <Checkbox label="Wishlisted" checked={useWish} onChange={setUseWish}
                  helpText="Net of un-wishlisting." />
                {useWish && (
                  <RangeSlider label={`Weight: ${wWish}`} value={wWish} min={0} max={100}
                    onChange={(v) => setWWish(Number(v))} output />
                )}

                <Checkbox label="Viewed 30 seconds or more" checked={useDwell} onChange={setUseDwell}
                  helpText="Shoppers who stayed on the page rather than bouncing." />
                {useDwell && (
                  <RangeSlider label={`Weight: ${wDwell}`} value={wDwell} min={0} max={100}
                    onChange={(v) => setWDwell(Number(v))} output />
                )}

                <Checkbox label="Product views" checked={useViews} onChange={setUseViews}
                  helpText="Weakest signal: a view says a shopper arrived, not that they liked it." />
                {useViews && (
                  <RangeSlider label={`Weight: ${wViews}`} value={wViews} min={0} max={100}
                    onChange={(v) => setWViews(Number(v))} output />
                )}

                <Box paddingBlockStart="200">
                  <Checkbox label="Push out-of-stock products down" checked={sink} onChange={setSink}
                    helpText="Sold-out products move below everything in stock, but keep their order among themselves — a sold-out best seller still carries its Back in Stock signup." />
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">Preview</Text>
                <Text as="p" variant="bodyMd" tone="subdued">
                  See the order this would produce without writing anything to Shopify.
                </Text>
                <Select
                  label="Collection"
                  value={previewId}
                  onChange={setPreviewId}
                  options={[
                    { label: "Choose a collection…", value: "" },
                    ...picked.map((id) => {
                      const c = collections.find((x: any) => x.id === id);
                      return { label: c?.title ?? id, value: id };
                    }),
                  ]}
                />
                <InlineStack gap="300">
                  <button
                    className="Polaris-Button"
                    disabled={!previewId || busy}
                    onClick={() => submit({ intent: "preview", collectionId: previewId }, { method: "POST" })}
                  >
                    {busy ? "Working…" : "Preview order"}
                  </button>
                  <button
                    className="Polaris-Button"
                    disabled={!isEnabled || !picked.length || busy}
                    onClick={() => submit({ intent: "run" }, { method: "POST" })}
                  >
                    Run now
                  </button>
                </InlineStack>

                {actionData?.preview && (
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm" tone="subdued">
                      Top 20 of {actionData.total} products
                    </Text>
                    <DataTable
                      columnContentTypes={["numeric", "text", "text", "numeric", "text"]}
                      headings={["#", "Product", "Why it ranks here", "Score", "Stock"]}
                      rows={actionData.preview.map((p: any) => [
                        p.rank,
                        p.title,
                        // The parts sum to the score, so this explains the
                        // number rather than restating it. Ordered by
                        // contribution: what actually decided the position
                        // reads first.
                        <InlineStack key={p.rank} gap="200" wrap>
                          {[...p.parts]
                            .sort((a: any, b: any) => b.points - a.points)
                            .map((part: any) => (
                              <Text key={part.label} as="span" variant="bodySm"
                                tone={part.points === 0 ? "subdued" : undefined}>
                                {part.label} <b>{part.points}</b>{" "}
                                <Text as="span" variant="bodySm" tone="subdued">
                                  ({part.detail})
                                </Text>
                              </Text>
                            ))}
                        </InlineStack>,
                        p.score,
                        p.inStock ? "In stock" : "Sold out",
                      ])}
                    />
                  </BlockStack>
                )}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>

        <Layout.Section>
          <Box paddingBlockEnd="800" />
        </Layout.Section>
      </Layout>
    </Page>
  );
}
