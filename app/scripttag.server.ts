/**
 * Ensures a ScriptTag for widget.js is registered on the storefront.
 * Uses the GraphQL Admin API (scriptTagCreate / scriptTags queries).
 */

type GraphQLClient = (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response>;

const SCRIPT_TAG_CHECK = `#graphql
  query ScriptTagCheck($src: URL!) {
    scriptTags(first: 1, src: $src) {
      edges {
        node {
          id
          src
        }
      }
    }
  }
`;

const SCRIPT_TAG_CREATE = `#graphql
  mutation ScriptTagCreate($input: ScriptTagInput!) {
    scriptTagCreate(input: $input) {
      scriptTag {
        id
        src
        displayScope
      }
      userErrors {
        field
        message
      }
    }
  }
`;

export async function ensureScriptTag(admin: { graphql: GraphQLClient }) {
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  if (!appUrl) return;

  const widgetSrc = `${appUrl}/widget.js`;

  try {
    // Check if ScriptTag already exists
    const checkResponse = await admin.graphql(SCRIPT_TAG_CHECK, {
      variables: { src: widgetSrc },
    });
    const checkData = await checkResponse.json();
    const existing = checkData.data?.scriptTags?.edges ?? [];

    if (existing.length > 0) return;

    // Create the ScriptTag
    const createResponse = await admin.graphql(SCRIPT_TAG_CREATE, {
      variables: {
        input: {
          src: widgetSrc,
          displayScope: "ONLINE_STORE",
          cache: false,
        },
      },
    });
    const createData = await createResponse.json();
    const errors = createData.data?.scriptTagCreate?.userErrors ?? [];

    if (errors.length > 0) {
      console.error("BadgeHQ: ScriptTag creation errors:", errors);
    } else {
      console.log("BadgeHQ: ScriptTag registered:", widgetSrc);
    }
  } catch (e) {
    console.error("BadgeHQ: ScriptTag registration failed:", e);
  }
}
