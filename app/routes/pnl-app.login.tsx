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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (isAuthed(request)) return redirect("/pnl-app");
  const app = await getPnlApp();
  // First run: no password set yet → show the "create a password" form.
  return json({ needsSetup: !app.passwordHash });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const app = await getPnlApp();
  const form = await request.formData();
  const password = String(form.get("password") || "");

  if (!app.passwordHash) {
    // First-run setup: the password entered becomes THE password.
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
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.h1}>Profit &amp; Loss</h1>
        <p style={styles.sub}>
          {needsSetup
            ? "First time here — set a password to protect this dashboard."
            : "Enter your password to continue."}
        </p>
        <Form method="post" style={styles.form}>
          <input
            type="password"
            name="password"
            placeholder={needsSetup ? "Create a password" : "Password"}
            autoFocus
            style={styles.input}
          />
          {actionData?.error && <div style={styles.err}>{actionData.error}</div>}
          <button type="submit" style={styles.button}>
            {needsSetup ? "Set password & enter" : "Enter"}
          </button>
        </Form>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#f6f6f7",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  card: {
    background: "#fff",
    borderRadius: 12,
    padding: 32,
    width: 360,
    boxShadow: "0 1px 3px rgba(0,0,0,0.1)",
  },
  h1: { margin: 0, fontSize: 22, fontWeight: 700 },
  sub: { color: "#6d7175", fontSize: 14, marginTop: 6, marginBottom: 20 },
  form: { display: "flex", flexDirection: "column", gap: 12 },
  input: {
    padding: "10px 12px",
    border: "1px solid #c9cccf",
    borderRadius: 8,
    fontSize: 15,
  },
  err: { color: "#d72c0d", fontSize: 13 },
  button: {
    padding: "10px 12px",
    background: "#111",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontSize: 15,
    fontWeight: 600,
    cursor: "pointer",
  },
};
