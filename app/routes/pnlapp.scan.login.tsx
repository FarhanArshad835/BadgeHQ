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
import { ClaimsStyles } from "../components/ClaimsStyles";
import { BusyBar, useBusy } from "../components/BusyBar";

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
  // A second press re-submits the form, so the button stands down while
  // the first is in flight.
  const busy = useBusy();
  const { needsSetup } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="claims-app login-app">
      <ClaimsStyles />
      <BusyBar />
      <div className="login-card">
        <h1>Warehouse Scanner</h1>
        <p>
          {needsSetup
            ? "First time here. Set a password for the scanners."
            : "Enter the scanner password to continue."}
        </p>
        <Form method="post">
          <input
            type="password"
            name="password"
            placeholder={needsSetup ? "Create a password" : "Password"}
            autoComplete="current-password"
            autoFocus
          />
          {actionData?.error && <div className="login-err">{actionData.error}</div>}
          <button type="submit" className="btn-primary" disabled={busy}>
            {needsSetup ? "Set password and enter" : "Enter"}
          </button>
        </Form>
      </div>
    </div>
  );
}
