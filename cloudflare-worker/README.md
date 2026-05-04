# BadgeHQ widget — Cloudflare Worker

Serves `public/widget.js` from Cloudflare's global edge network instead of
Vercel. Eliminates the largest single source of Vercel edge requests
(every storefront pageview fetches `widget.js`).

## What this gives you

| Before | After |
|---|---|
| Every storefront pageview hits Vercel for `widget.js` | Cloudflare serves it from 300+ edge POPs globally |
| 1M Vercel edge requests/month free, then $20/mo Pro tier | 100K Cloudflare requests/day free (~3M/mo), then $5/mo + $0.50/M |
| Single region origin (iad1) | Edge-distributed worldwide |

For a merchant doing 134K pageviews/day, this offloads roughly **30-40%** of
the Vercel edge-request count entirely (the widget.js portion). The
remaining `/api/widgets` and `/api/products/inventory` endpoints stay on
Vercel for now — those can be migrated later if needed.

## One-time setup

You only do this once per Cloudflare account.

### 1. Create a Cloudflare account

Sign up at https://dash.cloudflare.com/sign-up if you don't have one. Free
account is sufficient.

### 2. Install dependencies and authenticate

```bash
cd cloudflare-worker
npm install
npx wrangler login    # opens browser, authorize the CLI
```

### 3. First deploy

```bash
npm run deploy
```

This runs `node build.js` (embeds the latest `public/widget.js` into the
worker bundle), then `wrangler deploy` (uploads to Cloudflare).

The first time, Wrangler will:

1. Ask which Cloudflare account to use (pick yours)
2. Create the worker `badgehq-widget`
3. Output the URL it's reachable at, e.g.
   ```
   https://badgehq-widget.your-account-name.workers.dev
   ```

**Copy that URL** — you'll point the theme app extension at it next.

### 4. Verify the deploy

```bash
curl https://badgehq-widget.your-account-name.workers.dev/health
# → {"status":"ok","widget_hash":"...","widget_built_at":"...","widget_bytes":85547}

curl -I https://badgehq-widget.your-account-name.workers.dev/widget.js
# → 200 OK, Content-Type: application/javascript, Cache-Control: public, max-age=3600, s-maxage=86400
```

### 5. Update the theme app extension to use this URL

Edit [extensions/badgehq-widget/blocks/app-embed.liquid](../extensions/badgehq-widget/blocks/app-embed.liquid):

```liquid
<!-- Change from: -->
<script src="https://badge-hq.vercel.app/widget.js" async></script>

<!-- To: -->
<script src="https://badgehq-widget.your-account-name.workers.dev/widget.js" async></script>
```

Then redeploy the Shopify app:

```bash
cd ..    # back to repo root
shopify app deploy
```

After Shopify CDN picks up the new theme extension version (a few minutes),
all installed merchants' storefronts will start loading widget.js from
Cloudflare instead of Vercel.

## Updating widget.js after the initial deploy

Whenever you change `public/widget.js`, redeploy the worker:

```bash
cd cloudflare-worker
npm run deploy
```

Cache invalidation: the new version will propagate within `max-age=3600`
(1 hour) for browsers and `s-maxage=86400` (1 day) for Cloudflare's edge.
For an immediate cache flush, run `wrangler cache purge` or hit the
Cloudflare dashboard → Caching → Purge.

## Optional: bind a custom domain

Workers default URLs (`*.workers.dev`) work fine but are long. To use
e.g. `widget.badge-hq.com`:

1. Add `badge-hq.com` to Cloudflare (free DNS)
2. Cloudflare dashboard → Workers & Pages → `badgehq-widget` → Settings →
   Triggers → Custom Domains → Add Custom Domain → `widget.badge-hq.com`
3. Update [app-embed.liquid](../extensions/badgehq-widget/blocks/app-embed.liquid)
   to use the custom domain
4. `shopify app deploy`

## Cost projection

Cloudflare Workers free plan:
- 100,000 requests/day = **~3M/month free**
- 10ms CPU per request (this worker uses < 1ms)

Your usage (1 merchant at 134K pageviews/day, ~75% browser-cached):
- ~33K worker requests/day = **~1M/month**
- **Comfortably inside the free tier with 3× headroom for growth**

If you exceed 100K/day:
- Workers Paid plan: **$5/month** + $0.50 per additional million requests
- 10 merchants of similar size: ~$5/month + ~$5 = **$10/month** total

Compare to Vercel Pro at the same scale: $20/month base + bandwidth + per-request overage above 10M.
