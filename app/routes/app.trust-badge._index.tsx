import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
import { useState, useCallback } from "react";
import {
  Page,
  Layout,
  Card,
  BlockStack,
  Text,
  Button,
  IndexTable,
  Badge,
  EmptyState,
  InlineStack,
  Modal,
  Thumbnail,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";
import { getBadgesByIds } from "../data/badgeLibrary";

interface TrustBadgeRow {
  id: string;
  name: string;
  isEnabled: boolean;
  badgeIds: string[];
  settings: {
    position?: string;
    [key: string]: unknown;
  };
  createdAt: string;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const badges = await prisma.trustBadge.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return json({
    badges: badges.map((b) => ({
      id: b.id,
      name: b.name,
      isEnabled: b.isEnabled,
      badgeIds: JSON.parse(b.badgeIds) as string[],
      settings: JSON.parse(b.settings) as Record<string, unknown>,
      createdAt: b.createdAt.toISOString(),
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const actionType = formData.get("action");
  const id = formData.get("id") as string;

  if (actionType === "delete") {
    await prisma.trustBadge.deleteMany({ where: { id, shop: session.shop } });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  }

  if (actionType === "toggle") {
    const badge = await prisma.trustBadge.findFirst({
      where: { id, shop: session.shop },
    });
    if (badge) {
      await prisma.trustBadge.update({
        where: { id },
        data: { isEnabled: !badge.isEnabled },
      });
      await bumpConfigVersion(session.shop);
    }
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function TrustBadgeList() {
  const { badges } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const handleToggle = useCallback(
    (id: string) => {
      submit({ action: "toggle", id }, { method: "POST" });
    },
    [submit]
  );

  const handleDelete = useCallback(() => {
    if (deleteId) {
      submit({ action: "delete", id: deleteId }, { method: "POST" });
      setDeleteId(null);
    }
  }, [deleteId, submit]);

  const positionLabels: Record<string, string> = {
    "below-atc": "Below Add to Cart",
    "above-atc": "Above Add to Cart",
    "below-description": "Below Description",
    "cart-page": "Cart Page",
  };

  return (
    <Page>
      <TitleBar title="Trust Badges">
        <button
          variant="primary"
          onClick={() => navigate("/app/trust-badge/new")}
        >
          Add Trust Badge
        </button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          {badges.length === 0 ? (
            <Card>
              <EmptyState
                heading="Create your first trust badge widget"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{
                  content: "Add Trust Badge",
                  onAction: () => navigate("/app/trust-badge/new"),
                }}
              >
                <p>
                  Display payment and trust icons on your product pages to build
                  customer confidence and increase conversions.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <IndexTable
                itemCount={badges.length}
                headings={[
                  { title: "Name" },
                  { title: "Status" },
                  { title: "Badges" },
                  { title: "Position" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {badges.map((badge: TrustBadgeRow, index: number) => {
                  const badgeItems = getBadgesByIds(badge.badgeIds);
                  const pos =
                    positionLabels[badge.settings?.position as string] ||
                    "Below Add to Cart";
                  return (
                    <IndexTable.Row
                      id={badge.id}
                      key={badge.id}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <Button
                          variant="plain"
                          onClick={() =>
                            navigate(`/app/trust-badge/${badge.id}`)
                          }
                        >
                          {badge.name}
                        </Button>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={badge.isEnabled ? "success" : undefined}>
                          {badge.isEnabled ? "Enabled" : "Disabled"}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="100" wrap={false}>
                          {badgeItems.slice(0, 5).map((item) => (
                            <Thumbnail
                              key={item.id}
                              source={item.imageUrl}
                              alt={item.name}
                              size="extraSmall"
                            />
                          ))}
                          {badgeItems.length > 5 && (
                            <Text as="span" variant="bodySm" tone="subdued">
                              +{badgeItems.length - 5}
                            </Text>
                          )}
                        </InlineStack>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{pos}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200">
                          <Button
                            size="slim"
                            onClick={() => handleToggle(badge.id)}
                          >
                            {badge.isEnabled ? "Disable" : "Enable"}
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            onClick={() => setDeleteId(badge.id)}
                          >
                            Delete
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  );
                })}
              </IndexTable>
            </Card>
          )}
        </Layout.Section>
      </Layout>

      <Modal
        open={deleteId !== null}
        onClose={() => setDeleteId(null)}
        title="Delete Trust Badge?"
        primaryAction={{
          content: "Delete",
          destructive: true,
          onAction: handleDelete,
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setDeleteId(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p" variant="bodyMd">
            Are you sure you want to delete this trust badge widget? This action
            cannot be undone.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
