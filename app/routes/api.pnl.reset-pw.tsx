/**
 * TEMPORARY password reset for the P&L tool. Verifies by reading the row back.
 * Secret-guarded. Delete once the real login is confirmed working.
 */
import { json } from "@remix-run/node";
import type { LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";
import { hashPassword, verifyPassword } from "../utils/pnl-app.server";

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
  const after = await prisma.pnlApp.findUnique({ where: { id: "default" } });
  return json({
    ok: after ? verifyPassword(pw, after.passwordHash) : false,
    rowId: after?.id ?? null,
    shopDomain: after?.shopDomain ?? null, // proves it's the real configured row
  });
};
