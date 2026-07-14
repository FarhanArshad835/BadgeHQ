# BadgeHQ Order Actions UI extension (Phase 2)

Adds a **Cancel order** button to two surfaces the theme `widget.js` can't reach:

- **Thank-you page** (`purchase.thank-you.block.render`) — post-purchase, may be a guest.
- **New customer accounts order page** (`customer-account.order-status.block.render`) — always logged in.

Each surface only renders when the merchant selected it in **Order Management → Where to show**
(`showOnPages` contains `thank-you` / `account-new`). Backend: `POST /api/order-cancel`,
authenticated with a session-token JWT (`authenticate.public.checkout`).

## Authorization
- **Logged-in** buyer: order ownership enforced via `checkOwnership` (customer-id match).
- **Guest** (thank-you): allowed only for a **fresh (≤ 60 min), unfulfilled, cancelScope-eligible**
  order. See `app/routes/api.order-cancel.tsx`.

## Running it (interactive — must be done locally, not headless)

1. Install the new deps (adds `@shopify/ui-extensions[-react]`):
   ```
   npm install
   ```
2. Start the dev session (opens a browser to auth + pick a dev store, creates a tunnel):
   ```
   npm run dev        # = shopify app dev
   ```
   - Place a test order on the dev store → the **Cancel order** button should appear on the
     thank-you page (if `thank-you` is selected in the admin) and on the new customer-account
     order page (if `account-new` is selected).
   - Test: a logged-in cancel enforces ownership; a guest thank-you cancel works only for the
     just-placed order; a stale/foreign order id is rejected.
3. Publish the extension to production:
   ```
   npm run deploy     # = shopify app deploy
   ```
   This registers the extension in `shopify.app.toml` and makes it live. The backend route
   deploys via the normal Vercel push to `main`.

## Notes / things to verify during `shopify app dev`
- **Order-id API path:** `ThankYou.tsx` reads `orderConfirmation.current.order.id` and
  `OrderStatus.tsx` reads `order.current.id`. If the dev console shows the id is elsewhere for
  your API version, adjust those two reads (kept defensive with `?? null`).
- **Merchant must add the block** in the checkout/customer-account editor for it to appear
  (block-type targets are merchant-placed).
- **api_version** is `2025-01` to match the app. Bump only if the CLI requires it.
- Backend origin is hardcoded to `https://badge-hq.vercel.app` in `src/shared.ts` — change if the
  app URL changes.
