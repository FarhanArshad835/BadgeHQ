import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";

// `/pnl-app` is intentionally just a redirect to `/pnl-app/home` (the dashboard).
// The dashboard can't live at the bare `/pnl-app` path because that path is a
// prefix of its siblings (/pnl-app/login, …), which broke its single-fetch
// `.data` endpoint on Vercel — see the note in app/routes.ts.
export const loader = async (_: LoaderFunctionArgs) => redirect("/pnl-app/home");
