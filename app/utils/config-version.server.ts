/**
 * Bust the Cloudflare Worker's edge cache for a shop after an admin save.
 *
 * The worker keys its origin-fetch cache on a per-shop config version stored
 * in KV; bumping it forces the next storefront request to fetch fresh config
 * instead of waiting out the edge TTL. Best-effort: if the worker, the KV
 * binding, or BUMP_SECRET is missing, storefronts still refresh within the
 * normal cache TTL.
 */
const WORKER_ORIGIN = "https://badgehq-widget.badgehq.workers.dev";

let warnedMissingSecret = false;

export async function bumpConfigVersion(shop: string): Promise<void> {
  const secret = process.env.BUMP_SECRET;
  if (!secret) {
    if (!warnedMissingSecret) {
      warnedMissingSecret = true;
      // Surface the config gap once — without BUMP_SECRET, admin saves can't
      // bust the edge cache and storefronts stay stale for the full TTL.
      console.warn(
        "[config-version] BUMP_SECRET is not set — admin saves will NOT refresh the storefront cache instantly (falling back to the edge TTL).",
      );
    }
    return;
  }
  try {
    await fetch(`${WORKER_ORIGIN}/internal/bump?shop=${encodeURIComponent(shop)}`, {
      method: "POST",
      headers: { "X-Bump-Secret": secret },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Never let a cache-bust failure break the save itself.
  }
}
