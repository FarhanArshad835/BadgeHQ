# BadgeHQ — Project Timeline & Hard-Won Lessons

A history of what was built, what broke, and why — reconstructed from all 206 commits
plus the debugging sessions behind them. Written so a future maintainer (or a future
me) doesn't re-learn the same lessons the expensive way.

**At a glance**
- **206 commits**, 2026-03-08 → 2026-07-19
- **11 features**, 40 app routes, 20 migrations, ~3,800-line storefront widget
- **Stack:** Remix + Prisma/Postgres (Neon) on Vercel · Cloudflare Worker edge · Shopify Theme App Extension + UI Extension
- **Store:** `six-by-eleven.myshopify.com` (Release theme) · app URL `badge-hq.vercel.app`

---

## Phase 1 — Scaffold & the auth war (Mar 8-10, ~35 commits)

Shopify app scaffold, then a genuinely brutal fight to get OAuth working on Vercel.

**What broke, in order:** ESM/CJS import errors in `vite.config.ts` → hydration mismatch
(blank page) → `require()` crash in the auth route → CSRF origin mismatch → 410 Gone →
401 → auth redirect loop.

**Root causes:**
- Prisma needed **`DATABASE_POSTGRES_URL_NON_POOLING`** for `directUrl`; the pooled URL
  alone caused connection-pool timeouts.
- Neon's pooled connections needed **`pgbouncer=true`**.
- Token exchange vs. auth-code flow was flip-flopped four times
  (`5e41f68` → `fece53f` → `0176092` → `fd11a00`) before landing on token exchange with
  SingleMerchant distribution.

> **Gotcha:** when auth misbehaves on Vercel + Neon, suspect the *database URL and
> pooling* before the OAuth strategy. Several "auth" commits here were really DB bugs.

## Phase 2 — Storefront injection & the disappearing images (Mar 10-11, ~25 commits)

Getting badges onto the storefront, then a multi-day hunt where **product images vanished**
on Dawn.

Five commits attacked it (`3cecf43`, `a1c24ab`, `30e681d`, `2c2e3f6`, `95a004a`) before
`9ee0cde` — *"all fixes were in the wrong file"* — revealed the real problem. Then
`ee42c0e` found Dawn's `.media > *` CSS was stretching the badge.

> **Gotchas established here (still true):**
> - **Never make the badge's parent a `<picture>` element** — it breaks the image.
> - Themes' `.media > *` rules will stretch anything you inject; neutralise explicitly.
> - ScriptTag registration must use **GraphQL**, not REST (`b8857a6`).
> - Verify *which file actually ships* before iterating on a fix. Five wasted commits.

## Phase 3 — Feature build-out (Mar 11-13, ~40 commits)

Free Shipping Bar, Sticky Cart, currency handling, billing (Free/Growth/Pro), save/discard
UX. Billing alone took **8 attempts** — `billing.request()` fought the managed-pricing API
until `101c129` replaced it with direct GraphQL.

- Currency: **REST `shop.json`** proved more reliable than GraphQL for INR detection (`084c434`).
- `3677cec` — all features default to **inactive** on install. Correct: never surprise a
  merchant's storefront.
- Briefly rebranded to "SaleKit" (`cf1bd2c`) and reverted the same day (`3ab9161`).

## Phase 4 — Product badge maturity (Apr 29, ~20 commits)

Placement picker (image vs info area), collection targeting, MutationObserver for
dynamically-loaded products, bulk prefetch via `/products.json`, per-variant inventory.

> **Gotcha:** `01c1516` — detect a card root by **walking up to the price element**, not by
> matching class-name regexes. Class names differ per theme; structure doesn't.

## Phase 5 — Edge migration (May 4-9, 7 commits)

Vercel's free-tier compute cap was the forcing function. Moved `widget.js`,
`/api/widgets` and the inventory feed to a **Cloudflare Worker**.

**The cache-invalidation lesson** (`e182b36` → `2ca8470`): `s-maxage` alone meant admin
saves took up to an hour to appear. The fix is a **per-shop config version in KV**, folded
into the *cache key* — `cf.cacheTtl` keys only on the incoming URL, so a bump could never
invalidate it. Every admin save calls `bumpConfigVersion()`.

> **Gotcha:** if you add a settings field that the storefront reads, the save path **must**
> call `bumpConfigVersion(shop)` or merchants wait out the TTL.

## Phase 6 — Delivery Estimate (Jul 13-15)

Delhivery Expected TAT, PIN-code → delivery date. Later: Standard/Express/Both
(`mot=S`/`mot=E`), then merchant-editable copy.

**Bugs worth remembering:**
- The result row wrapped to two lines — the icon and text needed a flex row, not
  inline elements.
- With "Show both", showing two labelled rows confused shoppers. Now shows the **fastest**
  date with no standard/express labels.
- `560e271` **broke `/api/widgets` for every widget** by adding a field the DB didn't have
  yet. See Phase 10 for the full post-mortem.

## Phase 7 — Order Management + the PCD wall (Jul 13-16, ~25 commits)

Customer self-service cancel + address edit. Then Shopify's **Protected Customer Data**
review approved Level 1 (customer ID, order number) but **denied Level 2** (Name, Address).

**The non-obvious failure:** the order lookup requested `shippingAddress` in the *same
query* that powered cancellation. Shopify rejects the **entire query** when it contains
unapproved PCD fields — so **cancel broke too**, for a reason that had nothing to do with
cancelling. Fixed in `14d62ac` by splitting into `ORDER_FIELDS_BASE` (Level-1 only) vs
`ORDER_FIELDS_WITH_ADDRESS`, behind `ADDRESS_EDIT_ENABLED = false`.

### The checkout-extension saga (18 commits)

Getting a cancel button onto the thank-you page was the hardest thing in this project:

| Problem | Cause | Commit |
|---|---|---|
| Extension never registered | 44-char malformed `uid` (a real UUID with 8 chars appended) | `25c3dd0` |
| Whole app version wouldn't release | `network_access` needs Shopify approval | `6bf67c4` → `1714534` |
| Block rendered blank | Read `data.orderManagement`; API nests it at **`data.widgets.orderManagement`** | `d1fabc8` |
| Order id always null | Wrong API path — thank-you needs `useSubscription(api.orderConfirmation).order.id`; account page needs `useOrder().id` | `dd415f7` |
| "Failed to fetch" | Extensions run at **null origin**; `authenticate.public.checkout` throws a Response with **no CORS headers**, so even the preflight failed | `09792e3`, `a0e1cff`, `9e5f761` |
| Still failing after fixes | The extension hadn't been redeployed | — |

> **Gotchas:**
> - UI extensions need `api_version >= 2025-07`; `@remote-ui/react` needs
>   **`react-reconciler`** as an explicit dep (`9dd06ad`).
> - Shopify CLI **≥ 3.84.1** required — older versions are refused by the Partners API.
> - Guest buyers have **no `sessionToken.sub`**, so ownership can't be checked the normal
>   way. Guests are gated on: order < 60 min old, unfulfilled, and cancelScope-eligible.
> - **⚠️ Still live:** `TEMP:` diagnostics (`946101e`, `0f47e7f`, `97764e8`, `c7cb58f`)
>   surface raw error codes to real shoppers. **Clean these up.**

## Phase 8 — Wishlist (Jul 13, 8 commits)

Nearly all effort went into making the header badge *look native* — cloning the cart
badge's geometry by measuring a hidden copy and snapshotting live styles.

## Phase 9 — Back in Stock: three delivery rewrites (Jul 17-19, ~25 commits)

Shipped first as **Shopify-native email** (`dab50ff`): inventory webhook → Flow trigger →
merchant's marketing automation → Shopify Email. Because *Shopify has no API to email a
shopper directly.*

**Flow trigger schema took 3 attempts** — the docs are misleading:
- `type = "string"` is invalid → must be **`single_line_text_field`** (`634697a`)
- Field keys with spaces are ambiguous in Liquid → **single words** (`cd8a5cb`)
- `[[settings.field]]` singular / nested under `[[extensions]]` → must be
  **`[[settings.fields]]` plural at TOP level**, or Shopify **silently drops every field**
  (`8f17e29`) — the picker just shows `shop` and the email action fails with "Customer needed"

Then the whole path collapsed: **Automations requires Shopify Flow**, and Shopify moved
marketing automations into **Messaging** (May 1 2026). Meanwhile signups kept landing as
"Waiting (not subscribed)" — root cause in `9f6d235`: `customers(query:)` returns nothing
for customers who *do* exist (it depends on the search index + PCD access), so the code fell
through to `customerCreate`, got "Email has already been taken", and stored a null id.
Fix: treat that rejection as "exists" and look up via `customerByIdentifier`.

### The WhatsApp rewrite (`2f14b89`, ported from ReturnHQ)

Replaced email entirely with **WhatsApp via Interakt or DoubleTick**. The shopper types
their own number — first-party data — so **notifying needs no PCD at all**.

| | Interakt | DoubleTick |
|---|---|---|
| Auth | `Authorization: Basic <key>` (already base64 — **never re-encode**) | `Authorization: <key>` (raw) |
| Body vars | `template.bodyValues` | `templateData.body.placeholders` |
| Image header | `template.headerValues: [url]` | `templateData.header {type:IMAGE, mediaUrl}` |
| URL button | `buttonValues: {"0": [suffix]}` (0-based) | `templateData.buttons[]` |
| Extra | — | requires a **sender number** |

> **WhatsApp gotchas:**
> - **Meta rejects a send if ANY body variable is empty.** Every value is whitespace-
>   flattened with a non-empty fallback, and `"Default Title"` (Shopify's single-variant
>   placeholder) counts as empty.
> - **A dynamic URL button sends only the SUFFIX**, not a full URL. The template holds
>   `https://<shop>/products/` and we send `handle?variant=id` (128-char cap).
> - **Body-value count must match the template exactly** — dropping `{{3}}` from the
>   template means dropping it from the code (`55afd76`).
> - The image header needs a **fallback image** or products without a featured image fail
>   silently and wait forever.
> - `notifiedAt` is set **only** when the provider accepts, so failures retry next restock.

Finally `f68d426` removed email entirely: phone became the identity
(`@@unique([shop, variantId, phone])`), and the customer-mirror + Flow trigger were deleted.

## Phase 10 — AI chat, and a self-inflicted outage (Jul 18-19)

**Automated Replies** (`90fa6a4`) — chat bubble using the *merchant's own* Gemini key, so it
costs us nothing. Transcript in `sessionStorage` only — no server persistence, no PCD surface.

- **`gemini-2.0-flash` was shut down by Google on 2026-06-01.** It now 404s, which the code
  lumped into "upstream" and reported as *"check the key"* — blaming a key that was fine.
  Now on `gemini-2.5-flash`, with 404 mapped to a distinct `bad-model` error (`71ae4dd`).
- Links rendered as raw text. Now parsed from markdown into **real DOM anchors** —
  never `innerHTML`, since the text is LLM output. Only `http(s)`/`mailto`/`tel` are
  linkified; `javascript:` and stray HTML stay inert text (`2e722c8`).

### 🔴 The outage — read this one twice

`c6af1db`. I appended `waFallbackImage` to migration **0017 after it had already been
applied**. Prisma tracks migrations by name, saw 0017 as done, logged *"No pending
migrations to apply"* — and never created the column. Every query on
`BackInStockSettings` then threw, which **500'd `/api/widgets`** — taking down *every
storefront widget*, not just Back in Stock.

> **⚠️ RULE: applied migrations are immutable. New column = new migration file. Always.**
> Symptom to recognise: *"No pending migrations to apply"* in the Vercel build log while
> the code references a column that doesn't exist.

Related: `3adf061` — merchant-editable copy (`consentText`/`successText`) is stored in the
DB, so changing a *default* does nothing for shops that already saved. Needed a migration
to rewrite text still promising an email.

## Phase 11 — Theme performance & UI polish (Jul 19, current)

### The theme (Release) — edits live in the theme, not this repo

**Images downloaded instantly but appeared 2-3s later.** Two bugs compounding:
1. `section-product.css` hides the gallery until JS runs
   (`.swiper { opacity: 0 }` → `.swiper-initialized { opacity: 1 }`)
2. `product-media-gallery.js` waited for **`window.load`** — which doesn't fire until every
   image, font and third-party script (Snapmint, Shopflo, Subify…) finishes.

So the hero sat downloaded and invisible, waiting on the slowest app. Fixed by
initialising on `DOMContentLoaded`. Same bug existed in `global.js` for site-wide sliders.

**Every gallery image was `loading="eager"` + `fetchpriority="high"`** (hero, thumbnails,
off-screen slides — 9 of them). The theme *has* correct lazy-loading logic, but it was dead
code: every caller passed `media_index: media_index_for_image`, a variable **never assigned
anywhere in the theme**. So `section_index < 2` forced eager on everything.

**Sold-out variants couldn't be selected** — needed *two* fixes:
1. `product-option.liquid` rendered a real `disabled` attribute → removed (kept the class)
2. `base.css` had `.product-option__input.disabled + label { pointer-events: none }` —
   and since the radio is `visually-hidden`, **the label is the only click target**

> **Gotcha:** removing a `disabled` attribute is only half the job — check whether CSS keys
> off a `disabled` *class* too. This cost an extra debugging round.

### Widget UI fixes (all in `public/widget.js`)

- **Buttons unreadable** (`7ccd2ca`, `ed878d3`): `bisStyleLikeAtc` copied the ATC's
  background colour onto text+border. On a sold-out variant the ATC is *disabled* — light
  grey — so the button rendered grey-on-white. Now guarded by `bisReadableColor()`
  (BT.601 luminance ≤ 160). **The same bug existed in the wishlist button** — one fix,
  two call sites.
- **Panel layout** (`4b68041` → `ed878d3` → `9b7fc95` → `6fef3ab`): four attempts. The
  button must match the ATC's slot, but the *panel* should span the full row. Requires
  measuring **both width and left offset** — width alone overflowed and pushed the submit
  button off-screen. And the offset must be measured **after** the ATC is hidden, or the
  wrapper hasn't taken its place yet.

> **Gotcha:** CSS lives inside JS string concatenation in `widget.js`. A `//` comment
> between concatenated strings is fine; **inside** the CSS string it breaks the stylesheet.
> Always verify the *runtime* CSS, not just the source.

---

## Standing rules

1. **Never edit an applied migration.** New column → new migration. (Cost: a full outage.)
2. **Deploys are two-headed.** Code → `git push` (Vercel auto-deploys). `public/widget.js`
   → **also** `cd cloudflare-worker && npm run deploy`. Forgetting the second means testing
   yesterday's code.
3. **`widget.js` is browser-cached for 1 hour.** Always hard-refresh or use incognito after
   a worker deploy, or you're debugging a stale bundle.
4. **Verify the runtime, not the source** — rendered HTML, computed styles, the served
   bundle. Several multi-round hunts ended in "the fix was never deployed" or "the CSS was
   in a different file."
5. **Adding a storefront-visible setting?** Update: schema → migration → admin loader/action
   → `api.widgets.tsx` → `widget.js` → `bumpConfigVersion`. Miss one and it silently no-ops.
6. **Merchant-editable text is stored per-shop.** Changing a default does nothing for
   existing shops — that needs a data migration.
7. **PCD:** never query `shippingAddress`/customer names without approval — it fails the
   *whole* query. Gate customer API calls on the granted scope.
8. **Theme edits are lost on theme update.** `THEME-CHANGES-HOW-TO-APPLY.md` (in Downloads)
   is the re-application guide.
9. Theme exports can be **stale snapshots** — uploading one 404'd every product page.
   Prefer editing a duplicate of the live theme via Edit code.

## Open items

| Item | Impact |
|---|---|
| **PNG → JPG** for product photos | Biggest remaining speed win: measured **1,250 KB vs 144 KB** for the same image |
| **`TEMP:` diagnostics** in order-cancel | Shows raw error codes to real shoppers |
| **Interakt template approval** → Send test → restock test | Back in Stock is unproven end-to-end |
| Level-2 PCD re-request | Address editing stays disabled until approved |
| Third-party script audit | ~570 KB across 72 script tags on the product page |
| `write_customers` scope now unused | Left in place — removing forces a merchant re-auth |

## Reference

**Key files:** `public/widget.js` (~3,800 lines, all storefront features) ·
`app/routes/api.widgets.tsx` (config → storefront, **nested under `widgets`**) ·
`app/utils/whatsapp.server.ts` · `app/utils/order-actions.server.ts` ·
`cloudflare-worker/src/index.js`

**Env:** `DATABASE_URL`, `DATABASE_POSTGRES_URL_NON_POOLING`, `SCOPES`, `BUMP_SECRET`

**Scopes:** `read_products, write_products, write_script_tags, read_script_tags,
read_themes, read_orders, write_orders, read_inventory, write_customers`
