import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, Link, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import { getPnlApp, isAuthed, validateShopifyToken } from "../utils/pnl-app.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  // Secrets are write-only: the client learns only whether one is saved.
  return json({
    shopDomain: app.shopDomain,
    hasToken: Boolean(app.adminToken),
    shiprocketEmail: app.shiprocketEmail,
    hasShiprocketPassword: Boolean(app.shiprocketPassword),
    hasDelhiveryKey: Boolean(app.delhiveryApiKey),
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const form = await request.formData();

  const shopDomain = String(form.get("shopDomain") || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const adminToken = String(form.get("adminToken") || "").trim();
  const shiprocketEmail = String(form.get("shiprocketEmail") || "").trim();
  const shiprocketPassword = String(form.get("shiprocketPassword") || "").trim();
  const delhiveryApiKey = String(form.get("delhiveryApiKey") || "").trim();

  const existing = await getPnlApp();
  const effectiveToken = adminToken || existing.adminToken;

  // Validate the Shopify token live so the merchant gets a real error, not a
  // silent bad-token later during sync.
  let tokenNote = "";
  if (shopDomain && effectiveToken) {
    const v = await validateShopifyToken(shopDomain, effectiveToken);
    if (!v.ok) tokenNote = v.reason;
  }

  await prisma.pnlApp.update({
    where: { id: "default" },
    data: {
      shopDomain,
      shiprocketEmail,
      // Write-only secrets: only overwrite when a new value is provided.
      ...(adminToken ? { adminToken } : {}),
      ...(shiprocketPassword ? { shiprocketPassword } : {}),
      ...(delhiveryApiKey ? { delhiveryApiKey } : {}),
    },
  });

  return json({ saved: true, tokenNote });
};

export default function PnlSettings() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div style={s.page}>
      <div style={s.wrap}>
        <div style={s.nav}>
          <Link to="/pnl-app" style={s.link}>&larr; Dashboard</Link>
          <Link to="/pnl-app/logout" style={s.link}>Log out</Link>
        </div>
        <h1 style={s.h1}>Settings</h1>

        {actionData?.saved && (
          <div style={{ ...s.banner, background: "#e3f1df" }}>
            Saved.{actionData.tokenNote ? ` But: ${actionData.tokenNote}` : " Shopify token verified."}
          </div>
        )}

        <div style={s.help}>
          <strong>How to get the Shopify token (5 min, no approval needed):</strong>
          <ol style={{ margin: "8px 0", paddingLeft: 20 }}>
            <li>In your Shopify admin: <em>Settings → Apps and sales channels → Develop apps → Create an app</em>.</li>
            <li>Configuration → Admin API scopes → enable <code>read_orders</code>, <code>read_products</code>, <code>read_inventory</code>. Save.</li>
            <li>Install app → reveal the <strong>Admin API access token</strong> (starts with <code>shpat_</code>) → copy it.</li>
            <li>Paste it and your store domain below.</li>
          </ol>
          A custom app on your own store gets order access automatically — no Protected Customer Data approval.
        </div>

        <Form method="post" style={s.form}>
          <Field label="Store domain" name="shopDomain" defaultValue={d.shopDomain} placeholder="yourstore.myshopify.com" />
          <Field
            label="Shopify Admin API token"
            name="adminToken"
            type="password"
            placeholder={d.hasToken ? "•••••••• (saved — paste to replace)" : "shpat_…"}
          />
          <hr style={s.hr} />
          <div style={s.sectionLabel}>Shipping cost (actual billed — optional)</div>
          <Field label="Shiprocket email" name="shiprocketEmail" defaultValue={d.shiprocketEmail} placeholder="you@store.com" />
          <Field
            label="Shiprocket password"
            name="shiprocketPassword"
            type="password"
            placeholder={d.hasShiprocketPassword ? "•••••••• (saved)" : "Shiprocket password"}
          />
          <Field
            label="Delhivery API token"
            name="delhiveryApiKey"
            type="password"
            placeholder={d.hasDelhiveryKey ? "•••••••• (saved)" : "Delhivery token"}
          />
          <button type="submit" style={s.button}>Save</button>
        </Form>
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  type = "text",
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  type?: string;
  defaultValue?: string;
  placeholder?: string;
}) {
  return (
    <label style={s.field}>
      <span style={s.fieldLabel}>{label}</span>
      <input type={type} name={name} defaultValue={defaultValue} placeholder={placeholder} style={s.input} autoComplete="off" />
    </label>
  );
}

const s: Record<string, React.CSSProperties> = {
  page: { minHeight: "100vh", background: "#f6f6f7", padding: "32px 16px", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  wrap: { maxWidth: 560, margin: "0 auto", background: "#fff", borderRadius: 12, padding: 28, boxShadow: "0 1px 3px rgba(0,0,0,0.1)" },
  nav: { display: "flex", justifyContent: "space-between", marginBottom: 12 },
  link: { color: "#2c6ecb", textDecoration: "none", fontSize: 14 },
  h1: { margin: "0 0 16px", fontSize: 22, fontWeight: 700 },
  banner: { padding: "10px 12px", borderRadius: 8, fontSize: 14, marginBottom: 16 },
  help: { background: "#f1f8ff", border: "1px solid #cfe3ff", borderRadius: 8, padding: 14, fontSize: 13, color: "#374151", marginBottom: 20, lineHeight: 1.5 },
  form: { display: "flex", flexDirection: "column", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 4 },
  fieldLabel: { fontSize: 13, fontWeight: 600, color: "#374151" },
  input: { padding: "9px 12px", border: "1px solid #c9cccf", borderRadius: 8, fontSize: 14 },
  hr: { border: "none", borderTop: "1px solid #e1e3e5", margin: "6px 0" },
  sectionLabel: { fontSize: 13, fontWeight: 700, color: "#6d7175", textTransform: "uppercase", letterSpacing: 0.3 },
  button: { padding: "10px 12px", background: "#111", color: "#fff", border: "none", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", marginTop: 4 },
};
