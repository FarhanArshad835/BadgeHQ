import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { clearSessionCookie } from "../utils/pnl-app.server";

export const loader = async (_: LoaderFunctionArgs) =>
  redirect("/pnl-app/login", { headers: { "Set-Cookie": clearSessionCookie() } });
