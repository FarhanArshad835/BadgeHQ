import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import {
  getPnlApp,
  hashPassword,
  verifyPassword,
  makeSessionCookie,
  isAuthed,
} from "../utils/pnl-app.server";
import { PnlStyles } from "../utils/pnl-styles";
import { BusyBar, useBusy } from "../components/BusyBar";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isAuthed(request)) return redirect("/pnl-app/home");
  const app = await getPnlApp();

  // Build the exact Shopify admin URL for the P&L page, so recovery is one
  // click rather than an instruction to go and find something. The store handle
  // is the part before .myshopify.com.
  const handle = app.shopDomain.replace(".myshopify.com", "");
  const adminUrl = handle
    ? `https://admin.shopify.com/store/${handle}/apps/badgehq/app/pnl`
    : "";

  return json({ needsSetup: !app.passwordHash, adminUrl });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const app = await getPnlApp();
  const form = await request.formData();
  const password = String(form.get("password") || "");

  if (!app.passwordHash) {
    if (password.length < 6) {
      return json({ error: "Choose a password of at least 6 characters." }, { status: 400 });
    }
    await import("../db.server").then((m) =>
      m.default.pnlApp.update({ where: { id: "default" }, data: { passwordHash: hashPassword(password) } }),
    );
    return redirect("/pnl-app/home", { headers: { "Set-Cookie": makeSessionCookie() } });
  }

  if (!verifyPassword(password, app.passwordHash)) {
    return json({ error: "Wrong password." }, { status: 401 });
  }
  return redirect("/pnl-app/home", { headers: { "Set-Cookie": makeSessionCookie() } });
};

export default function PnlLogin() {
  // A second press re-submits the form, so the button stands down while
  // the first is in flight.
  const busy = useBusy();
  const { needsSetup, adminUrl } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div className="pnl" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <PnlStyles />
      <BusyBar />
      <div className="pnl-panel" style={{ width: 380 }}>
        <h1 className="pnl-h1" style={{ fontSize: 22 }}>Profit &amp; Loss</h1>
        <p className="pnl-sub" style={{ marginTop: 6, marginBottom: 22 }}>
          {needsSetup
            ? "First time here. Set a password to protect this dashboard."
            : "Enter your password to continue."}
        </p>
        <Form method="post" className="pnl-form">
          <input
            className="pnl-input"
            type="password"
            name="password"
            placeholder={needsSetup ? "Create a password" : "Password"}
            autoFocus
          />
          {actionData?.error && <div className="pnl-err">{actionData.error}</div>}
          <button type="submit" className="pnl-btn pnl-btn-primary" disabled={busy}>
            {needsSetup ? "Set password and enter" : "Enter"}
          </button>
        </Form>

        {/* Nothing to reset during first-time setup, so this only appears once
            a password actually exists. */}
        {!needsSetup && (
          <div className="pnl-help" style={{ marginTop: 18 }}>
            {adminUrl ? (
              <>
                <p style={{ margin: "0 0 10px" }}>
                  Forgot it? Being signed into the Shopify admin is what proves it is you, so
                  there is nothing extra to remember.
                </p>
                {/* A real link, because the P&L page is intentionally not listed
                    in the app's navigation: telling someone to "go to Profit and
                    Loss" would send them looking for a tile that is not there. */}
                <a className="pnl-btn" href={adminUrl} target="_blank" rel="noreferrer">
                  Reset via Shopify admin
                </a>
                <p style={{ margin: "10px 0 0" }}>
                  Sign in to the store if asked, then click{" "}
                  <strong>Reset dashboard password</strong> at the bottom of that page.
                </p>
              </>
            ) : (
              <p style={{ margin: 0 }}>
                Forgot it? Open the BadgeHQ app in your Shopify admin at{" "}
                <strong>/app/pnl</strong> and click <strong>Reset dashboard password</strong>.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
