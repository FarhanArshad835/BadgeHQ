import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { authenticate } from "../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const accessToken = session.accessToken!;

  try {
    // Get active theme
    const themesResp = await fetch(
      `https://${shop}/admin/api/2025-01/themes.json?role=main`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const themesData = await themesResp.json() as { themes?: { id: number; name: string }[] };
    const theme = themesData.themes?.[0];

    if (!theme) return json({ error: "No active theme found", themesData });

    // Get settings_data.json
    const assetResp = await fetch(
      `https://${shop}/admin/api/2025-01/themes/${theme.id}/assets.json?asset[key]=config/settings_data.json`,
      { headers: { "X-Shopify-Access-Token": accessToken } }
    );
    const assetData = await assetResp.json() as { asset?: { value?: string } };
    const content = assetData.asset?.value;

    if (!content) return json({ error: "No settings_data.json found", assetData });

    const settings = JSON.parse(content) as {
      current?: { blocks?: Record<string, unknown> };
    };
    const blocks = settings?.current?.blocks ?? {};

    return json({
      themeId: theme.id,
      themeName: theme.name,
      allBlockKeys: Object.keys(blocks),
      badgehqBlocks: Object.entries(blocks).filter(([key]) => key.includes("badgehq")),
    });
  } catch (e) {
    return json({ error: String(e) });
  }
};

export default function DebugTheme() {
  const data = useLoaderData<typeof loader>();
  return (
    <pre style={{ padding: "2rem", fontSize: "0.8rem", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}
