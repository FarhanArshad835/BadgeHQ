/**
 * TEMPORARY. Sets the P&L tool's password, then reads the row back and proves the
 * new value verifies — so success means the password actually works, not merely
 * that the write was issued. Secret-guarded. Delete once confirmed.
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

  // Read back and verify, so this can't report success on a write that didn't land.
  const after = await prisma.pnlApp.findUnique({ where: { id: "default" } });
  const verifies = after ? verifyPassword(pw, after.passwordHash) : false;
  return json({ ok: verifies, verifies, hashPresent: Boolean(after?.passwordHash) });
};
