import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData, useNavigate, useSubmit } from "@remix-run/react";
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
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { bumpConfigVersion } from "../utils/config-version.server";

function conditionLabel(condition: { type: string }): string {
  const map: Record<string, string> = {
    none: "Manual",
    on_sale: "On Sale",
    new_arrival: "New Arrival",
    low_stock: "Low Stock",
    out_of_stock: "Out of Stock",
    discount_percent: "Discount %",
    price_range: "Price Range",
    inventory_count: "Inventory",
  };
  return map[condition.type] || "Manual";
}

function badgeTypeLabel(type: string): string {
  return type === "dynamic" ? "Dynamic" : type === "image" ? "Image" : "Text";
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const badges = await prisma.productBadge.findMany({
    where: { shop: session.shop },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });
  return json({
    badges: badges.map((b) => ({
      ...b,
      condition: JSON.parse(b.condition) as { type: string },
      schedule: JSON.parse(b.schedule) as { startDate?: string; endDate?: string },
    })),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");
  const id = formData.get("id") as string;

  if (action === "delete") {
    await prisma.productBadge.deleteMany({ where: { id, shop: session.shop } });
    await bumpConfigVersion(session.shop);
    return json({ success: true });
  }

  if (action === "toggle") {
    const badge = await prisma.productBadge.findFirst({ where: { id, shop: session.shop } });
    if (badge) {
      await prisma.productBadge.update({ where: { id }, data: { isActive: !badge.isActive } });
      await bumpConfigVersion(session.shop);
    }
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function ProductBadgeList() {
  const { badges } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const submit = useSubmit();

  const handleToggle = (id: string) => {
    submit({ action: "toggle", id }, { method: "POST" });
  };

  const handleDelete = (id: string) => {
    submit({ action: "delete", id }, { method: "POST" });
  };

  return (
    <Page>
      <TitleBar title="Product Badges">
        <button variant="primary" onClick={() => navigate("/app/product-badge/new")}>
          Create Product Badge
        </button>
      </TitleBar>
      <Layout>
        <Layout.Section>
          {badges.length === 0 ? (
            <Card>
              <EmptyState
                heading="Create your first product badge"
                image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                action={{
                  content: "Create Product Badge",
                  onAction: () => navigate("/app/product-badge/new"),
                }}
              >
                <p>
                  Overlay badges on product images to highlight sales,
                  new arrivals, bestsellers, and more. Supports automated
                  conditions, dynamic text, image badges, and scheduling.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <IndexTable
                itemCount={badges.length}
                headings={[
                  { title: "Badge" },
                  { title: "Type" },
                  { title: "Condition" },
                  { title: "Position" },
                  { title: "Status" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {badges.map((badge, index) => (
                  <IndexTable.Row id={badge.id} key={badge.id} position={index}>
                    <IndexTable.Cell>
                      <InlineStack gap="200" blockAlign="center">
                        <div style={{
                          width: 24, height: 24, borderRadius: badge.shape === "circle" ? "50%" : 4,
                          backgroundColor: badge.badgeColor, display: "inline-flex",
                          alignItems: "center", justifyContent: "center",
                          color: badge.textColor, fontSize: "7px", fontWeight: 700,
                        }}>
                          {badge.badgeType === "image" ? "IMG" : badge.text.slice(0, 3)}
                        </div>
                        <Button variant="plain" onClick={() => navigate(`/app/product-badge/${badge.id}`)}>
                          {badge.text}
                        </Button>
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={badge.badgeType === "dynamic" ? "info" : undefined}>
                        {badgeTypeLabel(badge.badgeType)}
                      </Badge>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      {badge.condition.type !== "none" ? (
                        <Badge tone="attention">{conditionLabel(badge.condition)}</Badge>
                      ) : (
                        <Text as="span" variant="bodyMd" tone="subdued">Manual</Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>{badge.position}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="100">
                        <Badge tone={badge.isActive ? "success" : undefined}>
                          {badge.isActive ? "Active" : "Inactive"}
                        </Badge>
                        {badge.schedule.startDate && (
                          <Badge tone="warning">Scheduled</Badge>
                        )}
                      </InlineStack>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <InlineStack gap="200">
                        <Button size="slim" onClick={() => handleToggle(badge.id)}>
                          {badge.isActive ? "Disable" : "Enable"}
                        </Button>
                        <Button size="slim" tone="critical" onClick={() => handleDelete(badge.id)}>
                          Delete
                        </Button>
                      </InlineStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
