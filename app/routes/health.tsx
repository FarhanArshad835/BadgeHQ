import { json, type LoaderFunctionArgs } from "@remix-run/node";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const checks: Record<string, string> = {};

  // Check env vars
  checks.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ? "set" : "MISSING";
  checks.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET ? "set" : "MISSING";
  checks.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "MISSING";
  checks.SCOPES = process.env.SCOPES || "MISSING";
  checks.DATABASE_URL = process.env.DATABASE_URL ? "set" : "MISSING";

  // Check DB connectivity
  try {
    const count = await prisma.session.count();
    checks.database = `connected (${count} sessions)`;
  } catch (error: any) {
    checks.database = `ERROR: ${error.message}`;
  }

  return json({ status: "ok", checks }, { status: 200 });
}
