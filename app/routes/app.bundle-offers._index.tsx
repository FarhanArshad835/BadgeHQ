/**
 * Bundle offers: "2 for Rs1299", "2 for Rs999", and so on.
 *
 * PROMOTIONAL ONLY, and the page says so. The discount itself is a Shopify
 * automatic discount the merchant already configured; this widget tells the
 * shopper the offer exists and how close they are. It never changes a price,
 * because a price changed in the cart is recalculated at checkout and the
 * shopper is charged full anyway.
 *
 * Multiple offers, unlike the single-record Free Shipping Bar, because running
 * two price points at once is the normal case rather than the exception.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useSubmit, useNavigation } from "@remix-run/react";
import { useState, useEffect, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  InlineStack,
  InlineGrid,
  Text,
  TextField,
  Select,
  Checkbox,
  Banner,
  Button,
  Badge,
  Box,
  ChoiceList,
  Modal,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { getStoreCurrency } from "../utils/currency.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [offers, { currencySymbol }] = await Promise.all([
    prisma.bundleOffer.findMany({
      where: { shop: session.shop },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    }),
    getStoreCurrency(session.shop, session.accessToken!),
  ]);

  return json({
    currencySymbol,
    offers: offers.map((o) => ({
      id: o.id,
      title: o.title,
      quantity: o.quantity,
      scope: o.scope,
      collectionHandle: o.collectionHandle,
      collectionTitle: o.collectionTitle,
      productHandles: JSON.parse(o.productHandles) as string[],
      messages: JSON.parse(o.messages) as Record<string, string>,
      colors: JSON.parse(o.colors) as Record<string, string>,
      showProgress: o.showProgress,
      isActive: o.isActive,
      pages: JSON.parse(o.pages) as string[],
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") || "save");

  try {
    if (intent === "delete") {
      const id = String(form.get("id") || "");
      // Scoped to this shop: an id alone must never be enough to delete
      // another store's offer.
      await prisma.bundleOffer.deleteMany({ where: { id, shop: session.shop } });
      await bumpConfigVersion(session.shop);
      return json({ success: true });
    }

    if (intent === "toggle") {
      const id = String(form.get("id") || "");
      const isActive = form.get("isActive") === "true";
      await prisma.bundleOffer.updateMany({ where: { id, shop: session.shop }, data: { isActive } });
      await bumpConfigVersion(session.shop);
      return json({ success: true });
    }

    const data = JSON.parse(String(form.get("data") || "{}"));

    // Two or more, and a sane ceiling: a "1 for" offer is just the price, and a
    // typo like 200 would show a bar nobody can ever fill.
    const quantity = Math.min(Math.max(parseInt(String(data.quantity), 10) || 2, 2), 50);
    const scope = ["all", "collection", "products"].includes(data.scope) ? data.scope : "all";

    const saveData = {
      title: String(data.title || "").trim().slice(0, 120),
      quantity,
      scope,
      collectionHandle: String(data.collectionHandle || "").trim().slice(0, 200),
      collectionTitle: String(data.collectionTitle || "").trim().slice(0, 200),
      productHandles: JSON.stringify(
        String(data.productHandles || "")
          .split(",")
          .map((h: string) => h.trim())
          .filter(Boolean)
          .slice(0, 100),
      ),
      messages: JSON.stringify(data.messages),
      colors: JSON.stringify(data.colors),
      showProgress: Boolean(data.showProgress),
      isActive: Boolean(data.isActive),
      pages: JSON.stringify(Array.isArray(data.pages) ? data.pages : ["cart", "product"]),
    };

    if (data.id) {
      await prisma.bundleOffer.updateMany({
        where: { id: String(data.id), shop: session.shop },
        data: saveData,
      });
    } else {
      await prisma.bundleOffer.create({ data: { shop: session.shop, ...saveData } });
    }

    await bumpConfigVersion(session.shop);
    return json({ success: true });
  } catch {
    return json({ error: "Could not save that offer. Check the fields and try again." }, { status: 500 });
  }
};

type Offer = ReturnType<typeof useLoaderData<typeof loader>>["offers"][number];

const BLANK = {
  id: "",
  title: "",
  quantity: "2",
  scope: "all",
  collectionHandle: "",
  collectionTitle: "",
  productHandles: "",
  below: "Add {{remaining}} more {{items}} to unlock {{title}}",
  reached: "{{title}} unlocked!",
  barBg: "#f0f0f0",
  progressBg: "#4caf50",
  textCol: "#333333",
  showProgress: true,
  isActive: true,
  pages: ["cart", "product"] as string[],
};

export default function BundleOffersPage() {
  const { offers, currencySymbol } = useLoaderData<typeof loader>();
  const actionData = useActionData<{ success?: boolean; error?: string }>();
  const submit = useSubmit();
  const nav = useNavigation();
  const shopify = useAppBridge();
  const busy = nav.state !== "idle";

  const [editing, setEditing] = useState<typeof BLANK | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    if (actionData?.success) {
      setEditing(null);
      setShowSuccess(true);
      const t = setTimeout(() => setShowSuccess(false), 3000);
      return () => clearTimeout(t);
    }
  }, [actionData]);

  const startEdit = (o: Offer) =>
    setEditing({
      id: o.id,
      title: o.title,
      quantity: String(o.quantity),
      scope: o.scope,
      collectionHandle: o.collectionHandle,
      collectionTitle: o.collectionTitle,
      productHandles: o.productHandles.join(", "),
      below: o.messages?.below ?? BLANK.below,
      reached: o.messages?.reached ?? BLANK.reached,
      barBg: o.colors?.barBg ?? BLANK.barBg,
      progressBg: o.colors?.progressBg ?? BLANK.progressBg,
      textCol: o.colors?.text ?? BLANK.textCol,
      showProgress: o.showProgress,
      isActive: o.isActive,
      pages: o.pages,
    });

  const save = () => {
    if (!editing) return;
    submit(
      {
        data: JSON.stringify({
          id: editing.id,
          title: editing.title,
          quantity: editing.quantity,
          scope: editing.scope,
          collectionHandle: editing.collectionHandle,
          collectionTitle: editing.collectionTitle,
          productHandles: editing.productHandles,
          messages: { below: editing.below, reached: editing.reached },
          colors: { barBg: editing.barBg, progressBg: editing.progressBg, text: editing.textCol },
          showProgress: editing.showProgress,
          isActive: editing.isActive,
          pages: editing.pages,
        }),
      },
      { method: "POST" },
    );
  };

  const set = <K extends keyof typeof BLANK>(key: K, value: (typeof BLANK)[K]) =>
    setEditing((e) => (e ? { ...e, [key]: value } : e));

  // Shopify's own picker, the same one the product badges use, so the merchant
  // browses real collections instead of typing a handle they have to look up.
  const pickCollection = useCallback(async () => {
    const selected = await shopify.resourcePicker({ type: "collection", multiple: false });
    if (selected && selected[0]) {
      const col = selected[0] as any;
      const handle = col.handle || String(col.id).replace("gid://shopify/Collection/", "");
      setEditing((e) => (e ? { ...e, collectionHandle: handle, collectionTitle: col.title || "" } : e));
    }
  }, [shopify]);

  // What the shopper sees at the halfway point, so copy tokens can be checked
  // before the offer goes live rather than on the storefront.
  const previewMsg = (() => {
    if (!editing) return "";
    const need = Math.max(parseInt(editing.quantity, 10) || 2, 2);
    const remaining = Math.max(need - 1, 0);
    return (remaining === 0 ? editing.reached : editing.below)
      .replace(/\{\{remaining\}\}/g, String(remaining))
      .replace(/\{\{items\}\}/g, remaining === 1 ? "item" : "items")
      .replace(/\{\{title\}\}/g, editing.title || "your offer")
      .replace(/\{\{quantity\}\}/g, String(need));
  })();

  return (
    <Page fullWidth>
      <TitleBar title="Bundle Offers">
        {editing ? (
          <button variant="primary" onClick={save} disabled={busy} loading={busy ? "" : undefined}>
            Save offer
          </button>
        ) : (
          <button variant="primary" onClick={() => setEditing({ ...BLANK })}>
            Add offer
          </button>
        )}
        {editing ? <button onClick={() => setEditing(null)}>Cancel</button> : undefined}
      </TitleBar>

      <Layout>
        <Layout.Section>
          <BlockStack gap="300">
            {showSuccess && <Banner tone="success">Offer saved.</Banner>}
            {actionData?.error && <Banner tone="critical">{actionData.error}</Banner>}

            {/* The single most important thing on this page. A merchant who
                thinks this creates the discount will run an offer that never
                actually applies at checkout. */}
            <Banner tone="info" title="This shows the offer, it does not create the discount">
              <Text as="p">
                Set the discount up in Shopify under Discounts as an automatic discount, so it
                applies at checkout on its own. This widget tells shoppers the offer exists and
                how close their cart is to unlocking it.
              </Text>
            </Banner>

            {editing ? (
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingMd">
                    {editing.id ? "Edit offer" : "New offer"}
                  </Text>

                  <InlineGrid columns={{ xs: 1, md: 2 }} gap="400">
                    <TextField
                      label="Offer name"
                      value={editing.title}
                      onChange={(v) => set("title", v)}
                      autoComplete="off"
                      placeholder={`2 for ${currencySymbol}1299`}
                      helpText="Shown to the shopper, so write it exactly as you advertise it."
                    />
                    <TextField
                      label="Items needed"
                      type="number"
                      min={2}
                      max={50}
                      value={editing.quantity}
                      onChange={(v) => set("quantity", v)}
                      autoComplete="off"
                      helpText="How many items unlock the price. 2 for a 2-for deal."
                    />
                  </InlineGrid>

                  <Select
                    label="Which products count"
                    options={[
                      { label: "Anything in the cart", value: "all" },
                      { label: "Only specific products", value: "products" },
                      { label: "Only a collection", value: "collection" },
                    ]}
                    value={editing.scope}
                    onChange={(v) => set("scope", v)}
                  />

                  {editing.scope === "products" && (
                    <TextField
                      label="Product handles"
                      value={editing.productHandles}
                      onChange={(v) => set("productHandles", v)}
                      autoComplete="off"
                      placeholder="blue-flip-flops, black-flip-flops"
                      helpText="Comma separated. A handle is the last part of the product URL."
                    />
                  )}

                  {editing.scope === "collection" && (
                    <BlockStack gap="200">
                      <Text as="h3" variant="headingSm">Collection</Text>
                      <InlineStack gap="300" blockAlign="center">
                        <Button onClick={pickCollection}>
                          {editing.collectionHandle ? "Change collection" : "Browse collections"}
                        </Button>
                        {editing.collectionHandle ? (
                          <Text as="span">
                            {editing.collectionTitle || editing.collectionHandle}
                          </Text>
                        ) : (
                          <Text as="span" tone="subdued">No collection chosen yet.</Text>
                        )}
                      </InlineStack>
                      <Text as="p" tone="subdued" variant="bodySm">
                        Only items from this collection count toward the offer.
                      </Text>
                    </BlockStack>
                  )}

                  <TextField
                    label="Before the offer is unlocked"
                    value={editing.below}
                    onChange={(v) => set("below", v)}
                    autoComplete="off"
                    helpText="Use {{remaining}} for how many are still needed, {{items}} for item or items, and {{title}} for the offer name."
                  />
                  <TextField
                    label="Once it is unlocked"
                    value={editing.reached}
                    onChange={(v) => set("reached", v)}
                    autoComplete="off"
                  />

                  {/* Preview, so token mistakes surface here rather than live. */}
                  <Box background="bg-surface-secondary" padding="300" borderRadius="200">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm" tone="subdued">
                        Preview with one item in the cart
                      </Text>
                      <div style={{ textAlign: "center", padding: "8px 0" }}>
                        <p style={{ color: editing.textCol, margin: "0 0 8px", fontSize: 14, fontWeight: 500 }}>
                          {previewMsg}
                        </p>
                        {editing.showProgress && (
                          <div style={{ background: editing.barBg, borderRadius: 10, height: 20, overflow: "hidden" }}>
                            <div
                              style={{
                                background: editing.progressBg,
                                height: "100%",
                                width: `${Math.min((1 / Math.max(parseInt(editing.quantity, 10) || 2, 2)) * 100, 100)}%`,
                                borderRadius: 10,
                              }}
                            />
                          </div>
                        )}
                      </div>
                    </BlockStack>
                  </Box>

                  <Checkbox
                    label="Show the progress bar"
                    checked={editing.showProgress}
                    onChange={(v) => set("showProgress", v)}
                    helpText="Turn off to show only the message."
                  />

                  <InlineGrid columns={{ xs: 1, sm: 3 }} gap="400">
                    <TextField label="Bar background" value={editing.barBg} onChange={(v) => set("barBg", v)} autoComplete="off" />
                    <TextField label="Progress colour" value={editing.progressBg} onChange={(v) => set("progressBg", v)} autoComplete="off" />
                    <TextField label="Text colour" value={editing.textCol} onChange={(v) => set("textCol", v)} autoComplete="off" />
                  </InlineGrid>

                  <ChoiceList
                    allowMultiple
                    title="Show on"
                    choices={[
                      { label: "Cart page", value: "cart" },
                      { label: "Product pages", value: "product" },
                    ]}
                    selected={editing.pages}
                    onChange={(v) => set("pages", v)}
                  />

                  <Checkbox
                    label="Offer is live"
                    checked={editing.isActive}
                    onChange={(v) => set("isActive", v)}
                  />
                </BlockStack>
              </Card>
            ) : offers.length === 0 ? (
              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">No offers yet</Text>
                  <Text as="p" tone="subdued">
                    Add one for each price point you run, for example 2 for {currencySymbol}1299 and
                    2 for {currencySymbol}999. Shoppers see how many more items they need.
                  </Text>
                  <InlineStack>
                    <Button variant="primary" onClick={() => setEditing({ ...BLANK })}>
                      Add your first offer
                    </Button>
                  </InlineStack>
                </BlockStack>
              </Card>
            ) : (
              <BlockStack gap="300">
                {offers.map((o) => (
                  <Card key={o.id}>
                    <InlineStack align="space-between" blockAlign="center" gap="300" wrap>
                      <BlockStack gap="100">
                        <InlineStack gap="200" blockAlign="center">
                          <Text as="h3" variant="headingSm">{o.title || "Untitled offer"}</Text>
                          <Badge tone={o.isActive ? "success" : undefined}>
                            {o.isActive ? "Live" : "Off"}
                          </Badge>
                        </InlineStack>
                        <Text as="p" tone="subdued" variant="bodySm">
                          {o.quantity} items
                          {o.scope === "products"
                            ? ` from ${o.productHandles.length} chosen ${o.productHandles.length === 1 ? "product" : "products"}`
                            : o.scope === "collection"
                              ? ` from ${o.collectionTitle || o.collectionHandle || "(no collection chosen)"}`
                              : " from anywhere in the cart"}
                          {o.pages.length ? `, on ${o.pages.join(" and ")}` : ""}
                        </Text>
                      </BlockStack>
                      <InlineStack gap="200">
                        <Button
                          size="slim"
                          disabled={busy}
                          onClick={() =>
                            submit(
                              { intent: "toggle", id: o.id, isActive: String(!o.isActive) },
                              { method: "POST" },
                            )
                          }
                        >
                          {o.isActive ? "Turn off" : "Turn on"}
                        </Button>
                        <Button size="slim" disabled={busy} onClick={() => startEdit(o)}>
                          Edit
                        </Button>
                        <Button size="slim" tone="critical" disabled={busy} onClick={() => setDeleteId(o.id)}>
                          Delete
                        </Button>
                      </InlineStack>
                    </InlineStack>
                  </Card>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Layout.Section>

        {/* The embedded frame clips at the last element, so without this the
            final control sits flush against the bottom edge. */}
        <Layout.Section>
          <Box paddingBlockEnd="800" />
        </Layout.Section>
      </Layout>

      <Modal
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete this offer?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (deleteId) submit({ intent: "delete", id: deleteId }, { method: "POST" });
            setDeleteId(null);
          },
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => setDeleteId(null) }]}
      >
        <Modal.Section>
          <Text as="p">
            It stops showing on your storefront right away. Your Shopify discount is not affected.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
