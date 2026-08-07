/**
 * Standalone P&L app — auth + Shopify token client.
 *
 * This tool lives at /pnl-app, OUTSIDE the Shopify embedded app, so it has none
 * of the embedded session/PCD limits. It authenticates to Shopify with a
 * CUSTOM-APP Admin API token (shpat_…) the brand generates in their own admin —
 * custom apps get Protected Customer Data access automatically, so this path can
 * read orders where the embedded BadgeHQ app is blocked.
 *
 * Access to the tool itself is a single shared password (it's not behind Shopify
 * login). The session is a signed cookie; the signing key is the app secret that
 * already exists in the environment, so no new secret is needed.
 */
import crypto from "node:crypto";
import prisma from "../db.server";
import type { AdminGraphql } from "./pnl.server";
import { syncRevenueAndCogs, backfillShipping } from "./pnl-sync.server";

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const COOKIE_NAME = "pnl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SIGNING_KEY = process.env.SHOPIFY_API_SECRET || "pnl-fallback-key-change-me";

// ── password hashing (scrypt) ────────────────────────────────────────────────

/** Hash a password as scrypt: "salt:hash" hex. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time verify against a stored "salt:hash". */
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = String(stored || "").split(":");
  if (!saltHex || !hashHex) return false;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expected = Buffer.from(hashHex, "hex");
    const actual = crypto.scryptSync(password, salt, expected.length);
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ── signed-cookie session ────────────────────────────────────────────────────

function sign(value: string): string {
  return crypto.createHmac("sha256", SIGNING_KEY).update(value).digest("hex");
}

/** Build the Set-Cookie header value for a fresh authenticated session. */
export function makeSessionCookie(): string {
  const expiry = String(Date.now() + SESSION_TTL_MS);
  const payload = `ok.${expiry}`;
  const token = `${payload}.${sign(payload)}`;
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  return `${COOKIE_NAME}=${token}; Path=/pnl-app; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

/** Clear the session (logout). */
export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/pnl-app; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** True if the request carries a valid, unexpired, correctly-signed session. */
export function isAuthed(request: Request): boolean {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`));
  if (!m) return false;
  const parts = decodeURIComponent(m[1]).split(".");
  if (parts.length !== 3) return false;
  const [ok, expiry, sig] = parts;
  const payload = `${ok}.${expiry}`;
  // Constant-time signature check.
  const expected = sign(payload);
  if (
    sig.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
  ) {
    return false;
  }
  return ok === "ok" && Number(expiry) > Date.now();
}

/** Load the single config row (id="default"), creating it empty on first use. */
export async function getPnlApp() {
  const existing = await prisma.pnlApp.findUnique({ where: { id: "default" } });
  if (existing) return existing;
  return prisma.pnlApp.create({ data: { id: "default" } });
}

/**
 * Run one CURSOR-AWARE chunk of the standalone P&L sync, shared by BOTH the
 * "Sync now" button and the nightly cron. This is what makes a second click (or
 * the next cron run) continue where the last one stopped instead of re-syncing
 * the same first orders:
 *   - if a previous chunk left a saved cursor+window, resume it,
 *   - otherwise open a fresh window (90 days on the very first run when there's
 *     no data yet, else the last 3 days to catch refunds),
 *   - run until `timeBudgetMs`/`maxPages`, then persist the cursor (or clear it
 *     when the window is fully drained) so the next run picks up from there.
 *
 * The button passes small bounds (a few pages, ~7s); the cron passes large ones.
 * They share the SAME PnlApp cursor, so clicks and nightly runs cooperate.
 */
export async function runStandaloneSync(opts: {
  maxPages: number;
  timeBudgetMs: number;
  deliveryLimit?: number; // how many orders to resolve delivery for this run
  shippingLimit?: number;
}): Promise<
  | { orders: number; done: boolean; billed: number; pending: number; delivered: number; rto: number }
  | { error: string }
> {
  const app = await getPnlApp();
  if (!app.shopDomain || !app.adminToken) return { error: "not configured" };

  const admin = tokenAdmin(app.shopDomain, app.adminToken);
  const resuming = Boolean(app.syncCursor && app.syncWindowStart && app.syncWindowEnd);

  let since: Date;
  let until: Date;
  let startCursor: string | null;
  if (resuming) {
    since = app.syncWindowStart!;
    until = app.syncWindowEnd!;
    startCursor = app.syncCursor!;
  } else {
    // Fixed calendar-month start (NOT a rolling 90-day window, which cut off the
    // start of May and drifted later daily). Cover complete months from
    // backfillStartMonth to now, so no month is ever partially pulled.
    const [by, bm] = (app.backfillStartMonth || "2026-04").split("-").map(Number);
    since = new Date(Date.UTC(by, bm - 1, 1) - IST_OFFSET_MS);
    until = new Date();
    startCursor = null;
  }

  const rc = await syncRevenueAndCogs(admin, app.shopDomain, {
    since,
    until,
    startCursor,
    maxPages: opts.maxPages,
    timeBudgetMs: opts.timeBudgetMs,
  });

  // Persist progress: keep the cursor+window if not done, clear it when drained.
  await prisma.pnlApp.update({
    where: { id: "default" },
    data: rc.done
      ? {
          syncCursor: null,
          syncWindowStart: null,
          syncWindowEnd: null,
          lastSyncAt: new Date(),
          lastSyncStatus: `synced ${rc.orders} orders`,
        }
      : {
          syncCursor: rc.nextCursor,
          syncWindowStart: since,
          syncWindowEnd: until,
          lastSyncAt: new Date(),
          lastSyncStatus: `syncing (${rc.orders} this run, more pending)`,
        },
  });

  const carrier = {
    shiprocketEmail: app.shiprocketEmail,
    shiprocketPassword: app.shiprocketPassword,
    delhiveryApiKey: app.delhiveryApiKey,
  };

  // Delivery outcome now comes from the UPLOADED tracking sheet (the authority),
  // not the carrier API — so the sync no longer classifies delivery. The
  // backfill* helpers remain available for a fallback, but are not run here.
  const dv = { delivered: 0, rto: 0 };
  const bf = await backfillShipping(app.shopDomain, { limit: opts.shippingLimit ?? 200, carrier });

  return {
    orders: rc.orders,
    done: rc.done,
    billed: bf.billed,
    pending: bf.stillPending,
    delivered: dv.delivered,
    rto: dv.rto,
  };
}

// ── Shopify admin client from a raw custom-app token ─────────────────────────

/**
 * Build an AdminGraphql client (same interface the embedded `admin` exposes)
 * that talks to Shopify with a custom-app Admin API token. Because it implements
 * `.graphql(query, {variables})` identically, all the existing P&L sync code
 * (fetchOrdersPage, syncRevenueAndCogs, …) works against it unchanged.
 */
export function tokenAdmin(shopDomain: string, adminToken: string): AdminGraphql {
  const shop = shopDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const url = `https://${shop}/admin/api/2025-01/graphql.json`;
  return {
    graphql: (query: string, opts?: { variables?: any }) =>
      fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": adminToken,
        },
        body: JSON.stringify({ query, variables: opts?.variables ?? {} }),
        signal: AbortSignal.timeout(20000),
      }),
  };
}

/**
 * Validate a token by asking Shopify for one order. Returns a clear status so
 * the settings page can tell the merchant exactly what's wrong (bad token vs no
 * order scope vs wrong domain) instead of a generic failure.
 */
export async function validateShopifyToken(
  shopDomain: string,
  adminToken: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!shopDomain || !adminToken) return { ok: false, reason: "Enter the store domain and token." };
  try {
    const admin = tokenAdmin(shopDomain, adminToken);
    const res = await admin.graphql(`{ orders(first: 1) { nodes { id } } }`);
    const body = await res.json().catch(() => ({}));
    if (body?.errors) {
      const msg = Array.isArray(body.errors)
        ? body.errors[0]?.message
        : body.errors?.message || JSON.stringify(body.errors);
      const s = String(msg);
      if (/not approved to access the Order|protected-customer-data/i.test(s)) {
        return {
          ok: false,
          reason:
            "This token can't read orders. In the custom app's configuration, enable the " +
            "read_orders scope (and read_products, read_inventory), then reinstall and copy the new token.",
        };
      }
      if (/access token|invalid|401|unauthor/i.test(s)) {
        return { ok: false, reason: "Invalid token. Copy the Admin API access token again (it starts with shpat_)." };
      }
      return { ok: false, reason: s.slice(0, 160) };
    }
    if (!res.ok) return { ok: false, reason: `Shopify returned HTTP ${res.status}. Check the store domain.` };
    return { ok: true };
  } catch (e: any) {
    return { ok: false, reason: "Couldn't reach Shopify. Check the store domain (e.g. yourstore.myshopify.com)." };
  }
}
