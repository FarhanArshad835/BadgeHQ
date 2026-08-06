import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import { getPnlApp, isAuthed, validateShopifyToken } from "../utils/pnl-app.server";
import { PnlStyles } from "../utils/pnl-styles";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthed(request)) return redirect("/pnl-app/login");
  const app = await getPnlApp();
  return json({
    shopDomain: app.shopDomain,
    hasToken: Boolean(app.adminToken),
    shiprocketEmail: app.shiprocketEmail,
    hasShiprocketPassword: Boolean(app.shiprocketPassword),
    hasDelhiveryKey: Boolean(app.delhiveryApiKey),
    metaAdAccountId: app.metaAdAccountId,
    hasMetaToken: Boolean(app.metaAccessToken),
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
  const metaAdAccountId = String(form.get("metaAdAccountId") || "").trim();
  const metaAccessToken = String(form.get("metaAccessToken") || "").trim();

  const existing = await getPnlApp();
  const effectiveToken = adminToken || existing.adminToken;

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
      metaAdAccountId,
      ...(adminToken ? { adminToken } : {}),
      ...(shiprocketPassword ? { shiprocketPassword } : {}),
      ...(delhiveryApiKey ? { delhiveryApiKey } : {}),
      ...(metaAccessToken ? { metaAccessToken } : {}),
    },
  });

  return json({ saved: true, tokenNote });
};

export default function PnlSettings() {
  const d = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div className="pnl">
      <PnlStyles />
      <div className="pnl-wrap narrow">
        <div className="pnl-head">
          <h1 className="pnl-h1">Settings</h1>
          <div className="pnl-headlinks">
            <a className="pnl-link" href="/pnl-app/home">Dashboard</a>
            <a className="pnl-link" href="/pnl-app/logout">Log out</a>
          </div>
        </div>

        {actionData?.saved && (
          <div className={`pnl-banner ${actionData.tokenNote ? "warn" : "ok"}`} style={{ marginBottom: 18 }}>
            {actionData.tokenNote ? `Saved, but: ${actionData.tokenNote}` : "Saved. Shopify token verified."}
          </div>
        )}

        <div className="pnl-help" style={{ marginBottom: 22 }}>
          <strong>Get the Shopify token (about 5 minutes, no approval needed):</strong>
          <ol>
            <li>Shopify admin: Settings, Apps and sales channels, Develop apps, Create an app.</li>
            <li>Configuration, Admin API scopes: enable <code>read_orders</code>, <code>read_products</code>, <code>read_inventory</code>. Save.</li>
            <li>Install app, reveal the Admin API access token (starts with <code>shpat_</code>), copy it.</li>
            <li>Paste it and your store domain below.</li>
          </ol>
          A custom app on your own store gets order access automatically; no Protected Customer Data approval.
        </div>

        <Form method="post" className="pnl-panel pnl-form">
          <Field label="Store domain" name="shopDomain" defaultValue={d.shopDomain} placeholder="yourstore.myshopify.com" />
          <Field
            label="Shopify Admin API token"
            name="adminToken"
            type="password"
            placeholder={d.hasToken ? "•••••••• saved, paste to replace" : "shpat_…"}
          />
          <hr className="pnl-rule" />
          <div className="pnl-section-label">Shipping cost (actual billed, optional)</div>
          <Field label="Shiprocket email" name="shiprocketEmail" defaultValue={d.shiprocketEmail} placeholder="you@store.com" />
          <Field
            label="Shiprocket password"
            name="shiprocketPassword"
            type="password"
            placeholder={d.hasShiprocketPassword ? "•••••••• saved" : "Shiprocket password"}
          />
          <Field
            label="Delhivery API token"
            name="delhiveryApiKey"
            type="password"
            placeholder={d.hasDelhiveryKey ? "•••••••• saved" : "Delhivery token"}
          />
          <hr className="pnl-rule" />
          <div className="pnl-section-label">Meta ad spend (for the ad-spend line)</div>
          <Field label="Meta ad account id" name="metaAdAccountId" defaultValue={d.metaAdAccountId} placeholder="act_908549380106884" />
          <Field
            label="Meta access token (ads_read)"
            name="metaAccessToken"
            type="password"
            placeholder={d.hasMetaToken ? "•••••••• saved" : "EAAG… (ads_read token)"}
          />
          <button type="submit" className="pnl-btn pnl-btn-primary" style={{ marginTop: 4, alignSelf: "flex-start" }}>
            Save
          </button>
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
    <label className="pnl-field">
      <span className="pnl-field-label">{label}</span>
      <input className="pnl-input" type={type} name={name} defaultValue={defaultValue} placeholder={placeholder} autoComplete="off" />
    </label>
  );
}
