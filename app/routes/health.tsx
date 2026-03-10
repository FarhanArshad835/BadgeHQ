import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { createHmac } from "crypto";
import prisma from "../db.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const checks: Record<string, string> = {};

  // Check env vars
  checks.SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ? "set" : "MISSING";
  checks.SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET
    ? `set (length: ${process.env.SHOPIFY_API_SECRET.length}, starts: ${process.env.SHOPIFY_API_SECRET.slice(0, 4)}...)`
    : "MISSING";
  checks.SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL || "MISSING";
  checks.SCOPES = process.env.SCOPES || "MISSING";
  checks.DATABASE_URL = process.env.DATABASE_URL ? "set" : "MISSING";

  // Verify HMAC if test params provided: /health?shop=x&timestamp=y&hmac=z
  const url = new URL(request.url);
  const hmacParam = url.searchParams.get("hmac");
  if (hmacParam && process.env.SHOPIFY_API_SECRET) {
    const params = new URLSearchParams(url.search);
    params.delete("hmac");
    params.sort();
    const message = params.toString();
    const localHmac = createHmac("sha256", process.env.SHOPIFY_API_SECRET)
      .update(message)
      .digest("hex");
    checks.hmac_test = localHmac === hmacParam ? "VALID" : `MISMATCH (local: ${localHmac.slice(0, 10)}..., received: ${hmacParam.slice(0, 10)}...)`;
  }

  // Check DB connectivity
  try {
    const count = await prisma.session.count();
    checks.database = `connected (${count} sessions)`;
  } catch (error: any) {
    checks.database = `ERROR: ${error.message}`;
  }

  return json({ status: "ok", checks }, { status: 200 });
}
