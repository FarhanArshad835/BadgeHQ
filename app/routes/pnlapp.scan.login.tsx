/**
 * Scanner login.
 *
 * A SEPARATE password from the P&L, on purpose. Its cookie is scoped to
 * /pnl-app/scan, so a browser holding it never sends it to /pnl-app/home: staff
 * on the packing floor cannot reach the finance tool even by typing the URL.
 * That separation is enforced by the browser, not by a check we might forget.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import {
  getPnlApp,
  hashPassword,
  verifyPassword,
  makeSessionCookie,
  isAuthed,
} from "../utils/pnl-app.server";
import { PnlStyles } from "../utils/pnl-styles";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isAuthed(request, "scan")) return redirect("/pnl-app/scan/dispatch");
  const app = await getPnlApp();
  return json({ needsSetup: !app.scanPasswordHash });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const app = await getPnlApp();
  const form = await request.formData();
  const password = String(form.get("password") || "");

  // First run: whoever sets it up chooses it, matching how the P&L bootstraps.
  if (!app.scanPasswordHash) {
    if (password.length < 6) {
      return json({ error: "Choose a password of at least 6 characters." }, { status: 400 });
    }
    await prisma.pnlApp.update({
      where: { id: "default" },
      data: { scanPasswordHash: hashPassword(password) },
    });
    return redirect("/pnl-app/scan/dispatch", {
      headers: { "Set-Cookie": makeSessionCookie("scan") },
    });
  }

  if (!verifyPassword(password, app.scanPasswordHash)) {
    return json({ error: "Wrong password." }, { status: 401 });
  }
  return redirect("/pnl-app/scan/dispatch", {
    headers: { "Set-Cookie": makeSessionCookie("scan") },
  });
};

export default function ScanLogin() {
  const { needsSetup } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="pnl" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <PnlStyles />
      <div className="pnl-panel" style={{ width: 380 }}>
        <h1 className="pnl-h1" style={{ fontSize: 22 }}>Warehouse Scanner</h1>
        <p className="pnl-sub" style={{ marginTop: 6, marginBottom: 22 }}>
          {needsSetup
            ? "First time here. Set a password for the scanners."
            : "Enter the scanner password to continue."}
        </p>
        <Form method="post" className="pnl-form">
          <input
            className="pnl-input"
            type="password"
            name="password"
            placeholder={needsSetup ? "Create a password" : "Password"}
            autoComplete="current-password"
            autoFocus
          />
          {actionData?.error && <div className="pnl-err">{actionData.error}</div>}
          <button type="submit" className="pnl-btn pnl-btn-primary">
            {needsSetup ? "Set password and enter" : "Enter"}
          </button>
        </Form>
        <p className="pnl-help" style={{ marginTop: 18 }}>
          This password opens the scanners only. It does not give access to Profit and Loss.
        </p>
      </div>
    </div>
  );
}
