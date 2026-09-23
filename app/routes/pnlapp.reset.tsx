/**
 * Password reset for the standalone P&L tool.
 *
 * Reached by a single-use link minted from inside the Shopify admin (see
 * /app/pnl). Shopify is the proof of identity here: the tool has no email
 * address to send a link to, and a shared secret would be one more thing to
 * lose. Anyone already authenticated in the store's admin is, by definition,
 * entitled to reset this.
 *
 * The token is verified on BOTH the loader and the action. Checking only on the
 * loader would let an expired or already-used token still POST a new password.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useLoaderData } from "@remix-run/react";
import prisma from "../db.server";
import {
  getPnlApp,
  hashPassword,
  verifyResetToken,
  makeSessionCookie,
} from "../utils/pnl-app.server";
import { PnlStyles } from "../utils/pnl-styles";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const token = new URL(request.url).searchParams.get("token") || "";
  const app = await getPnlApp();
  const valid = verifyResetToken(token, app.resetTokenHash, app.resetTokenExpires);
  return json({ valid, token });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const form = await request.formData();
  const token = String(form.get("token") || "");
  const password = String(form.get("password") || "");
  const confirm = String(form.get("confirm") || "");

  // Re-checked here, not just in the loader: the loader only decides what to
  // render, and a stale tab must not be able to set a password.
  const app = await getPnlApp();
  if (!verifyResetToken(token, app.resetTokenHash, app.resetTokenExpires)) {
    return json({ error: "This reset link has expired or has already been used." }, { status: 400 });
  }

  if (password.length < 6) {
    return json({ error: "Choose a password of at least 6 characters." }, { status: 400 });
  }
  if (password !== confirm) {
    return json({ error: "The two passwords do not match." }, { status: 400 });
  }

  // Clearing the token in the same write is what makes the link single-use.
  await prisma.pnlApp.update({
    where: { id: "default" },
    data: {
      passwordHash: hashPassword(password),
      resetTokenHash: "",
      resetTokenExpires: null,
    },
  });

  // Straight in, rather than bouncing to a login they would immediately pass.
  return redirect("/pnl-app/home", { headers: { "Set-Cookie": makeSessionCookie() } });
};

export default function PnlReset() {
  const { valid, token } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <div className="pnl" style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <PnlStyles />
      <div className="pnl-panel" style={{ width: 380 }}>
        <h1 className="pnl-h1" style={{ fontSize: 22 }}>Set a new password</h1>

        {!valid ? (
          <>
            <p className="pnl-sub" style={{ marginTop: 6, marginBottom: 18 }}>
              This link has expired or has already been used. Reset links last 30 minutes and work
              once.
            </p>
            <p className="pnl-help" style={{ marginBottom: 18 }}>
              Open BadgeHQ in your Shopify admin, go to Profit &amp; Loss, and generate a new link.
            </p>
            <a className="pnl-btn" href="/pnl-app/login">Back to login</a>
          </>
        ) : (
          <>
            <p className="pnl-sub" style={{ marginTop: 6, marginBottom: 22 }}>
              Choose a new password for the Profit &amp; Loss dashboard.
            </p>
            <Form method="post" className="pnl-form">
              <input type="hidden" name="token" value={token} />
              <input
                className="pnl-input"
                type="password"
                name="password"
                placeholder="New password"
                autoFocus
                autoComplete="new-password"
              />
              <input
                className="pnl-input"
                type="password"
                name="confirm"
                placeholder="Repeat the password"
                autoComplete="new-password"
              />
              {actionData?.error && <div className="pnl-err">{actionData.error}</div>}
              <button type="submit" className="pnl-btn pnl-btn-primary">
                Save and enter
              </button>
            </Form>
          </>
        )}
      </div>
    </div>
  );
}
