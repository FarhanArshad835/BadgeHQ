/**
 * /pnl-app/scan -> the dispatch scanner.
 *
 * Loader only, no component, no action. A route whose path is a PREFIX of its
 * siblings cannot serve a working `.data` endpoint on Vercel (see the comment in
 * app/routes.ts), so this must never gain one.
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

export const loader = async (_: LoaderFunctionArgs) => redirect("/pnl-app/scan/dispatch");
