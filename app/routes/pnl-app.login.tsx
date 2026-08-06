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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isAuthed(request)) return redirect("/pnl-app");
  const app = await getPnlApp();
  return json({ needsSetup: !app.passwordHash });
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
    return redirect("/pnl-app", { headers: { "Set-Cookie": makeSessionCookie() } });
  }

  if (!verifyPassword(password, app.passwordHash)) {
    return json({ error: "Wrong password." }, { status: 401 });
  }
  return redirect("/pnl-app", { headers: { "Set-Cookie": makeSessionCookie() } });
};

export default function PnlLogin() {
  const { needsSetup } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  return (
    <div className="pnl" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <PnlStyles />
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
          <button type="submit" className="pnl-btn pnl-btn-primary">
            {needsSetup ? "Set password and enter" : "Enter"}
          </button>
        </Form>
      </div>
    </div>
  );
}
