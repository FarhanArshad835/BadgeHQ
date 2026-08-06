/**
 * Daily P&L sync cron — keeps the OrderFinancials cache fresh.
 *
 * Two jobs per shop that has P&L enabled or existing financials:
 *   1. Re-sync the last ~3 days of orders — revenue and refunds can change
 *      after the fact (a refund posts days later).
 *   2. Backfill shipping for ALL pending rows — this is how a freight charge
 *      that bills days after dispatch gets picked up automatically. Never
 *      estimated: an un-billed shipment stays pending.
 *
 * Guarded by CRON_SECRET (a run reads the merchant's Shopify + carrier data).
 */
import type { LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import prisma from "../db.server";
import { unauthenticated } from "../shopify.server";
import { syncRevenueAndCogs, backfillShipping } from "../utils/pnl-sync.server";
import { getPnlApp, tokenAdmin } from "../utils/pnl-app.server";

export const config = { maxDuration: 300 };

const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
// How long the standalone sync may run before it saves its cursor and stops,
// leaving headroom under maxDuration for backfill + response.
const STANDALONE_TIME_BUDGET_MS = 220_000;

function istDaysAgoStart(days: number): Date {
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - days);
  return new Date(ist.getTime() - IST_OFFSET_MS);
}

/**
 * Sync the standalone P&L app (PnlApp row) using its CUSTOM-APP token, which —
 * unlike the embedded app — has order access. Self-chunking: if a previous run
 * left a cursor mid-window, resume it; else open a fresh window. A first-ever
 * run backfills 90 days; steady state re-syncs the last 3 (refunds change). The
 * run stops on its time budget and persists the cursor so the next night
 * continues, so no single invocation runs unbounded or over-bills Neon.
 */
async function runStandaloneSync(): Promise<Record<string, unknown>> {
  const app = await getPnlApp();
  if (!app.shopDomain || !app.adminToken) return { standalone: "not configured" };

  const admin = tokenAdmin(app.shopDomain, app.adminToken);
  const resuming = Boolean(app.syncCursor && app.syncWindowStart && app.syncWindowEnd);

  // Resume the saved window, or open a new one. First-ever sync (no rows yet)
  // reaches back 90 days; steady state just refreshes the last 3.
  let since: Date;
  let until: Date;
  let startCursor: string | null;
  if (resuming) {
    since = app.syncWindowStart!;
    until = app.syncWindowEnd!;
    startCursor = app.syncCursor!;
  } else {
    const hasData = (await prisma.orderFinancials.count({ where: { shop: app.shopDomain } })) > 0;
    since = istDaysAgoStart(hasData ? 2 : 89);
    until = new Date();
    startCursor = null;
  }

  const rc = await syncRevenueAndCogs(admin, app.shopDomain, {
    since,
    until,
    startCursor,
    maxPages: 400,
    timeBudgetMs: STANDALONE_TIME_BUDGET_MS,
  });

  // Persist progress: keep the cursor+window if not done, clear them if done.
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

  // Backfill shipping for this shop's pending rows (verify-gated → mostly no-op
  // until the carrier billing endpoint is enabled).
  const bf = await backfillShipping(app.shopDomain, {
    limit: 200,
    carrier: {
      shiprocketEmail: app.shiprocketEmail,
      shiprocketPassword: app.shiprocketPassword,
      delhiveryApiKey: app.delhiveryApiKey,
    },
  });

  return { orders: rc.orders, done: rc.done, billed: bf.billed, pending: bf.stillPending };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get("Authorization");
  if (!secret || auth !== `Bearer ${secret}`) {
    return json({ error: "unauthorized" }, { status: 401 });
  }

  const results: Record<string, unknown> = {};

  // 1) Standalone P&L app (custom-app token) — this is the one that actually
  //    has order access here. Runs first, self-chunking within its time budget.
  const standaloneApp = await getPnlApp();
  try {
    results["standalone"] = await runStandaloneSync();
  } catch (e: any) {
    console.error("[pnl-cron] standalone", String(e?.message || e).slice(0, 200));
    results["standalone"] = { error: true };
  }

  // 2) Embedded-app shops (OAuth session). Skip the standalone shop — it's
  //    synced above via its token and its embedded session is PCD-blocked.
  const [enabled, withData] = await Promise.all([
    prisma.pnlSettings.findMany({ where: { isEnabled: true }, select: { shop: true } }),
    prisma.orderFinancials.findMany({ distinct: ["shop"], select: { shop: true } }),
  ]);
  const shops = Array.from(new Set([...enabled, ...withData].map((s) => s.shop))).filter(
    (s) => s !== standaloneApp.shopDomain,
  );

  // Re-sync window: last 3 IST days.
  const ist = new Date(Date.now() + IST_OFFSET_MS);
  ist.setUTCHours(0, 0, 0, 0);
  ist.setUTCDate(ist.getUTCDate() - 2);
  const since = new Date(ist.getTime() - IST_OFFSET_MS);
  const until = new Date();

  for (const shop of shops) {
    try {
      const { admin } = await unauthenticated.admin(shop);
      const rc = await syncRevenueAndCogs(admin, shop, { since, until, maxPages: 20 });
      const bf = await backfillShipping(shop, { limit: 200 });
      await prisma.pnlSettings.upsert({
        where: { shop },
        create: { shop, lastSyncAt: new Date(), lastSyncStatus: "cron ok" },
        update: { lastSyncAt: new Date(), lastSyncStatus: "cron ok" },
      });
      results[shop] = { orders: rc.orders, billed: bf.billed, pending: bf.stillPending };
    } catch (e: any) {
      console.error("[pnl-cron]", shop, String(e?.message || e).slice(0, 200));
      results[shop] = { error: true };
    }
  }

  return json({ ok: true, shops: shops.length, results });
};
