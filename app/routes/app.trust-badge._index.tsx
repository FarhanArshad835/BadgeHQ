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
  const badges = await prisma.trustBadge.findMany({
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
    await prisma.trustBadge.deleteMany({ where: { id, shop: session.shop } });
    return json({ success: true });
  }

  if (action === "toggle") {
    const badge = await prisma.trustBadge.findFirst({ where: { id, shop: session.shop } });
    if (badge) {
      await prisma.trustBadge.update({
        where: { id },
        data: { isActive: !badge.isActive },
      });
    }
    return json({ success: true });
  }

  return json({ error: "Unknown action" }, { status: 400 });
};

export default function TrustBadgeList() {
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
      <TitleBar title="Trust Badges">
        <button variant="primary" onClick={() => navigate("/app/trust-badge/new")}>
          Create Trust Badge
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
                  content: "Create Trust Badge",
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
                  { title: "Title" },
                  { title: "Status" },
                  { title: "Position" },
                  { title: "Pages" },
                  { title: "Actions" },
                ]}
                selectable={false}
              >
                {badges.map((badge, index) => {
                  const pages = JSON.parse(badge.pages) as string[];
                  return (
                    <IndexTable.Row id={badge.id} key={badge.id} position={index}>
                      <IndexTable.Cell>
                        <Button
                          variant="plain"
                          onClick={() => navigate(`/app/trust-badge/${badge.id}`)}
                        >
                          {badge.title}
                        </Button>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Badge tone={badge.isActive ? "success" : undefined}>
                          {badge.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {badge.position === "before-add-to-cart" ? "Before ATC" : "After ATC"}
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        {pages.join(", ")}
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
                  );
                })}
              </IndexTable>
            </Card>
          )}
        </Layout.Section>
      </Layout>
    </Page>
  );
}
