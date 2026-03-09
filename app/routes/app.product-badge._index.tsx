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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const badges = await prisma.productBadge.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
  });
  return json({ badges });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const action = formData.get("action");
  const id = formData.get("id") as string;

  if (action === "delete") {
    await prisma.productBadge.deleteMany({ where: { id, shop: session.shop } });
    return json({ success: true });
  }

  if (action === "toggle") {
    const badge = await prisma.productBadge.findFirst({ where: { id, shop: session.shop } });
    if (badge) {
      await prisma.productBadge.update({ where: { id }, data: { isActive: !badge.isActive } });
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
                  new arrivals, bestsellers, and more.
                </p>
              </EmptyState>
            </Card>
          ) : (
            <Card padding="0">
              <IndexTable
                itemCount={badges.length}
                headings={[
                  { title: "Text" },
                  { title: "Shape" },
                  { title: "Position" },
                  { title: "Status" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {badges.map((badge, index) => (
                  <IndexTable.Row id={badge.id} key={badge.id} position={index}>
                    <IndexTable.Cell>
                      <Button variant="plain" onClick={() => navigate(`/app/product-badge/${badge.id}`)}>
                        {badge.text}
                      </Button>
                    </IndexTable.Cell>
                    <IndexTable.Cell>{badge.shape}</IndexTable.Cell>
                    <IndexTable.Cell>{badge.position}</IndexTable.Cell>
                    <IndexTable.Cell>
                      <Badge tone={badge.isActive ? "success" : undefined}>
                        {badge.isActive ? "Active" : "Inactive"}
                      </Badge>
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
