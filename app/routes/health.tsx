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

  // Egress IP, on demand: /health?egress=1
  //
  // Shopify's IP allowlist is about where the app's requests COME FROM, which
  // is not the address the app is reached AT - the inbound anycast IPs of the
  // deployment say nothing about outbound. On serverless the egress address
  // can also vary between invocations, so this reports what THIS invocation
  // used and is meant to be called several times.
  if (url.searchParams.get("egress") === "1") {
    try {
      const r = await fetch("https://api.ipify.org?format=json", {
        signal: AbortSignal.timeout(5000),
      });
      const b = (await r.json()) as { ip?: string };
      checks.egress_ip = b.ip || "unknown";
    } catch (e: any) {
      checks.egress_ip = `ERROR: ${String(e?.message || e).slice(0, 80)}`;
    }
    checks.vercel_region = process.env.VERCEL_REGION || "unknown";
  }

  return json({ status: "ok", checks }, { status: 200 });
}
