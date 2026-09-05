/**
 * Meta (Facebook) Marketing API — monthly ad spend for the P&L.
 *
 * Direct Graph API, not Supermetrics (the team's Supermetrics trial expired and
 * the direct API is free with an ads_read token). Per the build spec, Phase 5:
 *   - WHOLE-ACCOUNT spend for the month (not a filtered ad-set pivot — that
 *     under-counted by 12% in the manual build).
 *   - Attribution PINNED to 7d_click + 1d_view — this is asserted, never left to
 *     the API default (leaving it at 7d-click only caused a 34% CPP error).
 *
 * Returns actual spend in minor units (paise) or a typed "pending"/error, never
 * an estimate. The token + account id come from PnlApp (metaAccessToken /
 * metaAdAccountId), entered in Settings.
 */
import { toMinor } from "./pnl.server";

// Exported so the Conversions API sender pins to the SAME version — two Graph
// callers drifting apart is a silent source of "works here, not there".
export const GRAPH_VERSION = "v21.0";

// Pinned attribution windows — asserted here so a code change can't silently
// revert to the API default (the spec's 34%-CPP-error guard).
export const ATTRIBUTION_WINDOWS = ["7d_click", "1d_view"] as const;

export type MetaSpendResult =
  | { ok: true; spendMinor: bigint; impressions: number; clicks: number; purchases: number }
  | { ok: false; reason: string };

/**
 * Fetch whole-account spend for an IST calendar month. `since`/`until` are the
 * month's date strings (YYYY-MM-DD, inclusive both ends per Meta's time_range).
 * Meta reports account currency amounts as decimal strings → toMinor() (paise),
 * never parseFloat.
 */
export async function fetchMetaMonthlySpend(opts: {
  accessToken: string;
  adAccountId: string; // "act_..."
  since: string; // YYYY-MM-DD
  until: string; // YYYY-MM-DD (inclusive)
}): Promise<MetaSpendResult> {
  const { accessToken, adAccountId, since, until } = opts;
  if (!accessToken || !adAccountId) return { ok: false, reason: "Add the Meta token and ad-account id in Settings." };

  const acct = adAccountId.startsWith("act_") ? adAccountId : `act_${adAccountId}`;
  const params = new URLSearchParams({
    level: "account", // whole account, not per-adset (the spec's under-count guard)
    time_range: JSON.stringify({ since, until }),
    fields: "spend,impressions,clicks,actions",
    action_attribution_windows: JSON.stringify(ATTRIBUTION_WINDOWS),
    access_token: accessToken,
  });
  const url = `https://graph.facebook.com/${GRAPH_VERSION}/${acct}/insights?${params.toString()}`;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    const body = await res.json().catch(() => ({}));
    if (body?.error) {
      const msg = String(body.error.message || "Meta API error");
      if (/access token|OAuth|expired|session/i.test(msg)) {
        return { ok: false, reason: "The Meta token is invalid or expired. Generate a new ads_read token in Settings." };
      }
      return { ok: false, reason: msg.slice(0, 160) };
    }
    const row = Array.isArray(body?.data) ? body.data[0] : null;
    if (!row) {
      // No spend rows for the window is a valid zero, not an error.
      return { ok: true, spendMinor: 0n, impressions: 0, clicks: 0, purchases: 0 };
    }

    const spendMinor = toMinor(row.spend);
    const impressions = Number(row.impressions ?? 0) || 0;
    const clicks = Number(row.clicks ?? 0) || 0;
    // Purchases from the actions array (pixel purchase), if present.
    let purchases = 0;
    for (const a of row.actions ?? []) {
      if (String(a?.action_type) === "offsite_conversion.fb_pixel_purchase") {
        purchases += Number(a?.value ?? 0) || 0;
      }
    }
    return { ok: true, spendMinor, impressions, clicks, purchases };
  } catch (e: any) {
    return { ok: false, reason: "Couldn't reach the Meta API. Check the token and try again." };
  }
}
