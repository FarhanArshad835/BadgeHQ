/**
 * TEMPORARY. Sets the P&L tool's password to a value chosen by the user, then is
 * deleted. Secret-guarded so it can't be triggered by anyone who finds the URL.
 */
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { hashPassword } from "../utils/pnl-app.server";

const SECRET = "SBE_PWRESET_4d9";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("secret") !== SECRET) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const pw = url.searchParams.get("pw") || "";
  if (pw.length < 6) return json({ error: "password must be at least 6 characters" }, { status: 400 });

  await prisma.pnlApp.update({
    where: { id: "default" },
    data: { passwordHash: hashPassword(pw) },
  });
  return json({ ok: true, message: "Password set. Delete this endpoint now." });
};
