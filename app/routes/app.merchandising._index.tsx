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

/**
 * Styles for the signal-weight panel, taken from the supplied design.
 *
 * Every selector is prefixed .merch- and the panel is wrapped in .merch, so
 * these cannot reach Polaris chrome and Polaris cannot restyle the cards. The
 * values - radii, padding, type scale, the slider track and thumb - are the
 * design's own, not approximations.
 *
 * Geist is loaded from Google Fonts, matching the design; it falls back to the
 * system stack if that request fails, so the layout never depends on it.
 */
const MERCH_CSS = `
@import url('https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700&display=swap');
.merch{font-family:"Geist",system-ui,-apple-system,sans-serif;color:#141414;display:flex;flex-direction:column;gap:18px}
.merch input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:4px;border-radius:999px;background:linear-gradient(to right,#3B38C9 var(--p,50%),#E4E4EA var(--p,50%));outline:none;margin:0}
.merch input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;border:2px solid #3B38C9;box-shadow:0 1px 3px rgba(0,0,0,.18);cursor:pointer}
.merch input[type=range]::-moz-range-thumb{width:18px;height:18px;border-radius:50%;background:#fff;border:2px solid #3B38C9;cursor:pointer}
.merch input[type=range]:disabled{opacity:.45;cursor:not-allowed}
.merch-seg{display:flex;gap:4px;background:#F4F4F6;border-radius:10px;padding:4px}
.merch-seg button{flex:1;border:0;background:transparent;border-radius:7px;padding:7px 0;font:inherit;font-size:13px;font-weight:500;color:#4B4B55;cursor:pointer;min-height:32px}
.merch-seg button[aria-pressed=true]{background:#141414;color:#fff}
.merch-card{background:#fff;border:1px solid #E6E6EA;border-radius:14px;padding:20px 22px;display:flex;flex-direction:column;gap:12px;min-width:0}
.merch-lab{font-size:12px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;color:#6B6B76}
.merch-big{font-size:36px;font-weight:700;line-height:1;letter-spacing:-.02em;color:#141414}
.merch-desc{font-size:13.5px;line-height:1.45;color:#4B4B55;margin:0}
.merch-sub{font-size:13px;color:#6B6B76}
.merch-pill{font-size:11px;font-weight:500;border-radius:999px;padding:3px 9px}
.merch-pill--accent{color:#3B38C9;background:#ECECFB}
.merch-pill--warn{color:#8A4B00;background:#FFF1E0}
.merch-pill--mute{color:#6B6B76;background:#F4F4F6}
.merch-source{display:flex;align-items:center;gap:8px;background:#F4F4F6;border-radius:10px;padding:9px 12px;font-size:13px;font-weight:500;min-height:40px;box-sizing:border-box}
@media (max-width:1100px){.merch [style*="repeat(4"]{grid-template-columns:repeat(2,minmax(0,1fr))!important}}
@media (max-width:620px){.merch [style*="repeat(4"]{grid-template-columns:1fr!important}}
`;

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

  // Figures the cards show beside each control, so a weight is set against
  // what the signal actually holds rather than in the abstract: an empty
  // behaviour counter explains a dead slider better than any help text.
  const [stock, behaviour] = await Promise.all([
    prisma.productScore.groupBy({
      by: ["inStock"],
      where: { shop: session.shop },
      _count: { _all: true },
    }),
    prisma.productBehaviour.aggregate({
      where: { shop: session.shop },
      _sum: { cartAdds: true, wishAdds: true, dwell30: true, views: true },
    }),
  ]);

  return json({
    settings,
    collections,
    lastRun,
    counts: {
      inStock: stock.find((r) => r.inStock)?._count._all ?? 0,
      soldOut: stock.find((r) => !r.inStock)?._count._all ?? 0,
      cart: behaviour._sum.cartAdds ?? 0,
      wish: behaviour._sum.wishAdds ?? 0,
      dwell: behaviour._sum.dwell30 ?? 0,
      views: behaviour._sum.views ?? 0,
    },
  });
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
  const { settings, collections, lastRun, counts } = useLoaderData<typeof loader>();
  const actionData = useActionData<any>();
  const submit = useSubmit();
  const nav = useNavigation();
  const busy = nav.state !== "idle";

  const [isEnabled, setIsEnabled] = useState(settings.isEnabled);
  const [picked, setPicked] = useState<string[]>(settings.collectionIds);
  const [wSales, setWSales] = useState(settings.weightSales);
  const [wReviews, setWReviews] = useState(settings.weightReviews);
  const [wNew, setWNew] = useState(settings.weightNewArrival);
  const [useSales] = useState(settings.useSales);
  const [useReviews] = useState(settings.useReviews);
  const [useNew] = useState(settings.useNewArrival);
  const [useCart] = useState(settings.useCart);
  const [useWish] = useState(settings.useWish);
  const [useDwell] = useState(settings.useDwell);
  const [useViews] = useState(settings.useViews);
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

  // The denominator every score is divided by. Shown so a weight is read as a
  // share of the whole rather than an absolute: Best sellers 50 means 50/total,
  // which is what actually decides how much it can move a product.
  const totalWeight =
    (useSales ? wSales : 0) +
    (useReviews ? wReviews : 0) +
    (useNew ? wNew : 0) +
    (useCart ? wCart : 0) +
    (useWish ? wWish : 0) +
    (useDwell ? wDwell : 0) +
    (useViews ? wViews : 0);

  // Shades run dark to light in the design's own order, so the bar reads as
  // one ramp rather than seven unrelated colours.
  const mixRaw = [
    { label: "New arrivals", weight: useNew ? wNew : 0, color: "#3B38C9" },
    { label: "Best sellers", weight: useSales ? wSales : 0, color: "#6C6AE0" },
    { label: "Reviews", weight: useReviews ? wReviews : 0, color: "#A9A8F0" },
    { label: "Added to cart", weight: useCart ? wCart : 0, color: "#D2D1F7" },
    { label: "Wishlisted", weight: useWish ? wWish : 0, color: "#E0DFF9" },
    { label: "Viewed 30s+", weight: useDwell ? wDwell : 0, color: "#ECECFB" },
    { label: "Views", weight: useViews ? wViews : 0, color: "#F2F2FC" },
  ];
  const mix = mixRaw.map((m) => ({
    ...m,
    // Guarded: with every signal off the bar is simply empty rather than NaN.
    pct: totalWeight > 0 ? Math.round((m.weight / totalWeight) * 1000) / 10 : 0,
  }));

  const behaviourCards = [
    {
      id: "w-cart", label: "Added to cart", tag: "Strongest here",
      desc: "Net of removals. One step from a purchase.",
      weight: wCart, set: setWCart, on: useCart, collected: counts.cart,
    },
    {
      id: "w-wish", label: "Wishlisted", tag: "",
      desc: "Net of un-wishlisting. Shows intent without a cart.",
      weight: wWish, set: setWWish, on: useWish, collected: counts.wish,
    },
    {
      id: "w-dwell", label: "Viewed 30 s or more", tag: "",
      desc: "Shoppers who stayed on the page rather than bouncing.",
      weight: wDwell, set: setWDwell, on: useDwell, collected: counts.dwell,
    },
    {
      id: "w-view", label: "Product views", tag: "Weakest",
      desc: "A view says a shopper arrived, not that they liked it.",
      weight: wViews, set: setWViews, on: useViews, collected: counts.views,
    },
  ];

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

            {/* Signal weights, built to the supplied design: same grid, card
                chrome, type scale and spacing. Styles are scoped under
                .merch- so Polaris cannot restyle them and this cannot leak
                out into the rest of the admin. */}
            <style dangerouslySetInnerHTML={{ __html: MERCH_CSS }} />

            <div className="merch">
              <div className="merch-card" style={{ padding: "18px 22px", gap: 14 }}>
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
                    <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, letterSpacing: "-.01em" }}>What decides the order</h2>
                    <span className="merch-sub">Higher total ranks first.</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                    <span className="merch-lab">Total weight</span>
                    <span style={{ fontSize: 20, fontWeight: 700 }}>{totalWeight}</span>
                  </div>
                </div>

                <div
                  style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", gap: 2 }}
                  role="img"
                  aria-label={"Share of total weight: " + mix.filter((m) => m.weight > 0).map((m) => m.label + " " + m.pct + " percent").join(", ")}
                >
                  {mix.filter((m) => m.weight > 0).map((m) => (
                    <div key={m.label} style={{ width: m.pct + "%", background: m.color }} />
                  ))}
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 22, fontSize: 13, color: "#4B4B55" }}>
                  {mix.filter((m) => m.weight > 0).map((m) => (
                    <span key={m.label} style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <i style={{ width: 10, height: 10, borderRadius: 3, background: m.color }} />
                      {m.label} {m.weight}
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span className="merch-lab" style={{ color: "#141414" }}>Sales &amp; catalogue</span>
                  <span className="merch-sub">From your orders.</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>

                  <div className="merch-card">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <span className="merch-lab">Best sellers</span>
                      <span className="merch-pill merch-pill--accent">Strongest signal</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span className="merch-big">{useSales ? wSales : 0}</span>
                      <span className="merch-sub">weight</span>
                    </div>
                    <label htmlFor="w-best" className="merch-desc">Units sold in the window below.</label>
                    <input
                      id="w-best" type="range" min={0} max={100} value={wSales} disabled={!useSales}
                      onChange={(e) => setWSales(Number(e.currentTarget.value))}
                      style={{ ["--p" as any]: wSales + "%" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                      <span className="merch-sub" style={{ fontSize: 12 }}>Sales window</span>
                      <div className="merch-seg" role="group" aria-label="Sales window">
                        {["7", "14", "30", "60", "90"].map((d) => (
                          <button key={d} type="button" aria-pressed={salesWindow === d} onClick={() => setSalesWindow(d)}>{d}d</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="merch-card">
                    <span className="merch-lab">Reviews</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span className="merch-big">{useReviews ? wReviews : 0}</span>
                      <span className="merch-sub">weight</span>
                    </div>
                    <label htmlFor="w-rev" className="merch-desc">Review count from Doran, not the star rating.</label>
                    <input
                      id="w-rev" type="range" min={0} max={100} value={wReviews} disabled={!useReviews}
                      onChange={(e) => setWReviews(Number(e.currentTarget.value))}
                      style={{ ["--p" as any]: wReviews + "%" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                      <span className="merch-sub" style={{ fontSize: 12 }}>Source</span>
                      <div className="merch-source">
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#1E9E5A" }} />
                        Doran &middot; read on each run
                      </div>
                    </div>
                  </div>

                  <div className="merch-card">
                    <span className="merch-lab">New arrivals</span>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                      <span className="merch-big">{useNew ? wNew : 0}</span>
                      <span className="merch-sub">weight</span>
                    </div>
                    <label htmlFor="w-new" className="merch-desc">Boosts new products so they can gather sales history.</label>
                    <input
                      id="w-new" type="range" min={0} max={100} value={wNew} disabled={!useNew}
                      onChange={(e) => setWNew(Number(e.currentTarget.value))}
                      style={{ ["--p" as any]: wNew + "%" }}
                    />
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 2 }}>
                      <span className="merch-sub" style={{ fontSize: 12 }}>Counts as new for</span>
                      <div className="merch-seg" role="group" aria-label="Counts as new for">
                        {["14", "30", "60"].map((d) => (
                          <button key={d} type="button" aria-pressed={newDays === d} onClick={() => setNewDays(d)}>{d} days</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="merch-card">
                    <span className="merch-lab">Out of stock</span>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
                      <span style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.2 }}>Push sold-out<br />products down</span>
                      <label style={{ position: "relative", display: "inline-flex", alignItems: "center", cursor: "pointer", flexShrink: 0 }}>
                        <input
                          type="checkbox" checked={sink} onChange={(e) => setSink(e.currentTarget.checked)}
                          aria-label="Push out-of-stock products down"
                          style={{ position: "absolute", opacity: 0, width: 44, height: 26, margin: 0, cursor: "pointer" }}
                        />
                        <span aria-hidden="true" style={{ width: 44, height: 26, borderRadius: 999, background: sink ? "#3B38C9" : "#C9C9D2", display: "block", position: "relative", transition: "background .15s" }}>
                          <span style={{ position: "absolute", top: 3, left: sink ? 21 : 3, width: 20, height: 20, borderRadius: "50%", background: "#fff", boxShadow: "0 1px 2px rgba(0,0,0,.25)", transition: "left .15s" }} />
                        </span>
                      </label>
                    </div>
                    <p className="merch-desc">They sink below everything in stock, keeping their own order.</p>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "auto" }}>
                      <span className="merch-sub" style={{ fontSize: 12 }}>Right now</span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <span className="merch-pill merch-pill--accent" style={{ fontSize: 12, padding: "6px 10px" }}>
                          {counts.inStock.toLocaleString("en-IN")} in stock
                        </span>
                        <span className="merch-pill merch-pill--warn" style={{ fontSize: 12, padding: "6px 10px" }}>
                          {counts.soldOut.toLocaleString("en-IN")} sold out
                        </span>
                      </div>
                    </div>
                  </div>

                </div>
              </div>

              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                  <span className="merch-lab" style={{ color: "#141414" }}>From shopper behaviour</span>
                  <span className="merch-sub">From the storefront.</span>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 16 }}>
                  {behaviourCards.map((c) => (
                    <div className="merch-card" key={c.id}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span className="merch-lab">{c.label}</span>
                        {c.tag ? (
                          <span className={c.tag === "Weakest" ? "merch-pill merch-pill--mute" : "merch-pill merch-pill--accent"}>{c.tag}</span>
                        ) : null}
                      </div>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                        <span className="merch-big">{c.on ? c.weight : 0}</span>
                        <span className="merch-sub">weight</span>
                      </div>
                      <label htmlFor={c.id} className="merch-desc">{c.desc}</label>
                      <input
                        id={c.id} type="range" min={0} max={20} value={c.weight} disabled={!c.on}
                        onChange={(e) => c.set(Number(e.currentTarget.value))}
                        style={{ ["--p" as any]: (c.weight / 20) * 100 + "%" }}
                      />
                      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2 }}>
                        <span className="merch-sub" style={{ fontSize: 12 }}>Collected so far</span>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{c.collected.toLocaleString("en-IN")}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>

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
