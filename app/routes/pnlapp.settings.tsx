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
    deliverySheetUrl: app.deliverySheetUrl,
    stockingMatch: app.stockingMatch,
    stockingUnitCost: (Number(app.stockingUnitCostMinor) / 100).toString(),
    opsPerPair: (Number(app.opsPerPairMinor) / 100).toString(),
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
  const deliverySheetUrl = String(form.get("deliverySheetUrl") || "").trim();
  const stockingMatch = String(form.get("stockingMatch") || "").trim();
  // Rupees in the field, paise in the column. Blank keeps the current value.
  const opsPerPairRaw = String(form.get("opsPerPair") || "").trim();
  const opsPerPairNum = Number(opsPerPairRaw);
  const opsPerPairMinor =
    opsPerPairRaw === "" || !isFinite(opsPerPairNum) || opsPerPairNum < 0
      ? null
      : BigInt(Math.round(opsPerPairNum * 100));
  const stockingUnitCostRaw = String(form.get("stockingUnitCost") || "").trim();
  const stockingUnitCostNum = Number(stockingUnitCostRaw);
  const stockingUnitCostMinor =
    stockingUnitCostRaw === "" || !isFinite(stockingUnitCostNum) || stockingUnitCostNum < 0
      ? null // blank or unparseable: keep whatever is stored rather than zeroing it
      : BigInt(Math.round(stockingUnitCostNum * 100));

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
      deliverySheetUrl,
      stockingMatch,
      ...(stockingUnitCostMinor != null ? { stockingUnitCostMinor } : {}),
      ...(opsPerPairMinor != null ? { opsPerPairMinor } : {}),
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
          <hr className="pnl-rule" />
          <div className="pnl-section-label">Operations</div>
          <div className="pnl-help" style={{ marginBottom: 12 }}>
            Your own handling and packing cost per delivered item, charged on the statement as
            this rate &times; items delivered. Set it to 0 if that cost is already inside your
            product cost price, or it will be counted twice.
          </div>
          <Field label="Operations cost per item (₹)" name="opsPerPair" defaultValue={d.opsPerPair} placeholder="0" />
          <hr className="pnl-rule" />
          <div className="pnl-section-label">Stocking (free product added to orders)</div>
          <div className="pnl-help" style={{ marginBottom: 12 }}>
            The stocking product is free to the customer, so it carries no revenue and no cost-per-item,
            and would otherwise never show up as a cost. Enter a word from its product title and what one
            unit costs you; the P&amp;L counts the units on delivered orders and multiplies. Leave the word
            blank to switch this off.
          </div>
          <Field label="Product title contains" name="stockingMatch" defaultValue={d.stockingMatch} placeholder="stocking" />
          <Field label="Cost per unit (₹)" name="stockingUnitCost" defaultValue={d.stockingUnitCost} placeholder="60" />
          <hr className="pnl-rule" />
          <div className="pnl-section-label">Delivery status sheet (auto-fetch)</div>
          <div className="pnl-help" style={{ marginBottom: 12 }}>
            In Google Sheets: File, Share, Publish to web, pick the AWB tab, format CSV, Publish. Paste that link here.
            The app fetches it directly (delivered / RTO matched by AWB) on the dashboard button and nightly.
          </div>
          <Field label="Published CSV URL" name="deliverySheetUrl" defaultValue={d.deliverySheetUrl} placeholder="https://docs.google.com/…/pub?gid=…&output=csv" />
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
