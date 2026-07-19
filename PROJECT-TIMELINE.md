# BadgeHQ — Project Timeline, Architecture & Hard-Won Lessons

The complete history of this project: what was built, what broke, the actual root cause of
each failure, and the rules that came out of them. Reconstructed from all 206 commits
(2026-03-08 → 2026-07-19) plus the debugging sessions behind them.

Written so a future maintainer — or a future me — doesn't re-learn any of this the
expensive way. **Where I got something wrong, it's recorded as wrong.** A history that only
lists successes can't prevent the next failure.

---

## Table of contents

1. [At a glance](#at-a-glance)
2. [Architecture](#architecture)
3. [Phase 1 — Scaffold & the auth war](#phase-1--scaffold--the-auth-war-mar-8-10)
4. [Phase 2 — Storefront injection & disappearing images](#phase-2--storefront-injection--the-disappearing-images-mar-10-11)
5. [Phase 3 — Feature build-out & billing](#phase-3--feature-build-out--billing-mar-11-13)
6. [Phase 4 — Product badge maturity](#phase-4--product-badge-maturity-apr-29)
7. [Phase 5 — Edge migration & cache invalidation](#phase-5--edge-migration--the-cache-invalidation-lesson-may-4-9)
8. [Phase 6 — Delivery Estimate](#phase-6--delivery-estimate-jul-13-15)
9. [Phase 7 — Order Management & the PCD wall](#phase-7--order-management--the-pcd-wall-jul-13-16)
10. [Phase 8 — Wishlist](#phase-8--wishlist-jul-13)
11. [Phase 9 — Back in Stock: three delivery rewrites](#phase-9--back-in-stock-three-delivery-rewrites-jul-17-19)
12. [Phase 10 — AI chat & a self-inflicted outage](#phase-10--ai-chat--a-self-inflicted-outage-jul-18-19)
13. [Phase 11 — Theme performance & UI polish](#phase-11--theme-performance--ui-polish-jul-19)
14. [Standing rules](#standing-rules)
15. [Debugging playbook](#debugging-playbook)
16. [Open items](#open-items)
17. [Reference](#reference)

---

## At a glance

| | |
|---|---|
| **Commits** | 206 (2026-03-08 → 2026-07-19) |
| **Features** | 11 |
| **App routes** | 40 |
| **Migrations** | 20 (`0001_init` → `0020_bis_whatsapp_wording`) |
| **Storefront widget** | `public/widget.js`, ~3,800 lines, 160 KB raw / 43 KB gzip |
| **Stack** | Remix · Prisma/Postgres (Neon) · Vercel · Cloudflare Worker · Shopify Theme App Extension + UI Extension |
| **Test store** | `six-by-eleven.myshopify.com` (DigiFist **Release** theme) |
| **App URL** | `badge-hq.vercel.app` · worker `badgehq-widget.badgehq.workers.dev` |

**The 11 features:** Trust Badges · Product Badges · Announcement Bar · Free Shipping Bar ·
Sticky Add-to-Cart · Countdown Timer · Delivery Estimate · Order Management · Wishlist ·
Back in Stock · Automated Replies (AI chat)

---

## Architecture

```
                    ┌────────────────────────────────────┐
   Merchant  ──────►│  Remix admin (embedded, Polaris)   │
                    │  badge-hq.vercel.app               │
                    └──────────────┬─────────────────────┘
                                   │ writes + bumpConfigVersion()
                                   ▼
                    ┌────────────────────────────────────┐
                    │  Postgres (Neon) via Prisma        │
                    └──────────────┬─────────────────────┘
                                   │ /api/widgets
                                   ▼
                    ┌────────────────────────────────────┐
   Shopper   ──────►│  Cloudflare Worker (edge cache)    │
                    │  serves widget.js + proxies APIs   │
                    └──────────────┬─────────────────────┘
                                   │ <script async>
                                   ▼
                    ┌────────────────────────────────────┐
                    │  Storefront: widget.js renders all │
                    │  11 features into the theme's DOM  │
                    └────────────────────────────────────┘
```

**Why a worker?** Vercel's free-tier compute cap. The worker embeds `widget.js` in its
bundle and edge-caches API responses, so Vercel only sees cache misses.

**Config flow (memorise this).** A storefront-visible setting must be threaded through
**six** places, or it silently no-ops:

```
prisma/schema.prisma  →  migration  →  admin loader + action
     →  api.widgets.tsx  →  widget.js  →  bumpConfigVersion()
```

**Two deploy targets.** Backend = `git push` (Vercel auto-deploys). Storefront =
`cd cloudflare-worker && npm run deploy`. **A `widget.js` change needs both.**

---

## Phase 1 — Scaffold & the auth war (Mar 8-10)

~35 commits. Shopify scaffold, then a brutal fight to make OAuth work on Vercel + Neon.

**The failure chain:** ESM/CJS import errors in `vite.config.ts` → hydration mismatch
(blank page) → `require()` crash in the auth route → CSRF origin mismatch → 410 Gone →
401 → an endless `302 → 200 → 401` redirect loop.

**Root causes — mostly *not* auth:**

- **`b072771` — the loop was a database bug.** Neon's PgBouncer runs transaction pooling,
  which **doesn't support prepared statements**, which Prisma uses by default. Session
  storage queries silently failed. Fix: `pgbouncer=true` on the connection URL (auto-added
  when the hostname contains `pooler`).
- **`ef7661a`** — Prisma needs `DATABASE_POSTGRES_URL_NON_POOLING` for `directUrl`;
  the pooled URL alone caused connection-pool timeouts.
- **`5d41bb0`** — visiting `/app` directly (outside Shopify admin) throws **410 Gone**
  because there's no App Bridge to perform the token-exchange bounce. Now detected and
  redirected to `/auth/login`. *(This exact symptom reappeared in July — see Phase 7.)*
- **Token exchange vs auth-code flow flip-flopped four times** (`5e41f68` → `fece53f` →
  `0176092` → `fd11a00`). Landed on **token exchange + SingleMerchant** because the standard
  OAuth flow kept failing HMAC validation despite verified-correct credentials — likely a
  query-string encoding bug in the library. Token exchange bypasses HMAC entirely.

> ### 🔑 Lesson
> When auth misbehaves on Vercel + Neon, **suspect the database URL and pooling before the
> OAuth strategy.** Several commits labelled "fix auth" were really Prisma/PgBouncer bugs.
> A `/health` endpoint that verifies credentials + HMAC (`9fd5112`) was what finally
> separated "credentials wrong" from "library misbehaving".

---

## Phase 2 — Storefront injection & the disappearing images (Mar 10-11)

~25 commits. Getting badges onto the storefront, then a multi-day hunt where **product
images vanished entirely** on Dawn.

### Injection

- **`9206440`** — three bugs at once: the ScriptTag was registered only in `afterAuth`,
  which **only fires during OAuth** — so an already-installed app never got one. Now also
  registered in the dashboard loader.
- **`b8857a6`** — `admin.rest.resources.ScriptTag` **doesn't exist** in
  `@shopify/shopify-app-remix` v4.1.0; the admin object only exposes `graphql`. Rewritten
  to `scriptTagCreate`.
- **`f69c644`** — the app-proxy fetch 404'd, so `widget.js` now derives the app origin from
  **its own `<script src>`** and fetches directly, with CORS preflight handling.

### The disappearing images

Five commits attacked it — `3cecf43`, `a1c24ab`, `30e681d`, `2c2e3f6`, `95a004a` — before
**`9ee0cde`: *"all fixes were in the wrong file."*** Then `ee42c0e` found Dawn's
`.media > *` CSS was stretching the injected badge over the whole image.

> ### 🔑 Lessons
> - **Never make a `<picture>` element the badge's parent** — it breaks the image.
> - Themes' `.media > *` rules stretch anything injected; neutralise explicitly.
> - **Verify which file actually ships before iterating.** Five commits were spent fixing
>   code that was never running. This pattern repeated in July (Phase 11) — it is the single
>   most expensive recurring mistake in this project.

---

## Phase 3 — Feature build-out & billing (Mar 11-13)

~40 commits. Free Shipping Bar, Sticky Cart, currency, billing, save/discard UX.

- **Billing took 8 attempts.** `billing.request()` fought Shopify's managed-pricing API
  through `c70fefe` → `8961226` → `7ad1fb9` → `5215f4d` → `541f008` → `42a22b0` until
  **`101c129` replaced it with direct GraphQL**. Redirects must be re-thrown and use
  `window.top.location.href` to escape the iframe.
- **`084c434`** — currency: **REST `shop.json` beat GraphQL** for reliable INR detection.
- **`3677cec`** — all features default to **inactive** on install. Correct call: never
  surprise a merchant's live storefront.
- **Theme-editor deep links took 7 attempts** (`283a912` → `d364810`) — iframe escaping
  needs a native `<a target="_top">`, and the link uses the **block filename**, not the
  extension handle (`41d8f07`).
- Rebranded to "SaleKit" (`cf1bd2c`) and reverted the same day (`3ab9161`).

---

## Phase 4 — Product badge maturity (Apr 29)

~20 commits. Placement picker (image vs info area), collection targeting, dynamic-product
support, per-variant inventory conditions.

- **`01c1516`** — detect a product-card root by **walking up to the price element**, not by
  matching class-name regexes. Class names differ per theme; **structure doesn't**.
- **`f4a7a39`** — bulk-prefetch `/products.json` (ShineTrust-style) instead of N per-product
  fetches.
- **`d673680` + `7183c9d`** — MutationObserver for dynamically-loaded products, plus
  re-attaching when lazy images finish loading.
- **`249d462`** — collection-targeted badges were leaking onto every product.
- **`990cb74`** — inventory conditions moved server-side because the Storefront API hides
  inventory; `11c81fc` falls back to DOM data attributes.
- **`48eaaf6`** — handle extraction broke on themes using classes like
  `sp-product-card-media`. Another class-name-coupling casualty.

---

## Phase 5 — Edge migration & the cache-invalidation lesson (May 4-9)

7 commits. Vercel's free-tier compute cap forced `widget.js`, `/api/widgets` and the
inventory feed onto a **Cloudflare Worker**.

### The cache bug worth understanding

**`e182b36`** added a per-shop config version in Workers KV, appended to the origin-fetch
URL. Merchants still waited out the full TTL.

**`2ca8470` found why:** the version only affected the **worker → Vercel subrequest**. The
worker's *own response* was edge-cached by `s-maxage`, keyed on the **incoming URL** — which
has no version in it. So a bump could never invalidate it.

Fix: manage the edge cache explicitly via `caches.default` with the **config version inside
the cache key**, and drop `s-maxage`. A bump changes the key → guaranteed miss → fresh
fetch; unchanged configs still serve from edge for the full TTL.

> ### 🔑 Lesson
> **`s-maxage` alone cannot be invalidated.** If you need instant publishes, the
> invalidation token must be part of the **cache key**, not just the upstream URL.
> Every admin save calls `bumpConfigVersion(shop)` → worker `/internal/bump` (guarded by
> `BUMP_SECRET`). Missing KV/secret degrades gracefully to plain TTL.

---

## Phase 6 — Delivery Estimate (Jul 13-15)

Delhivery Expected TAT: shopper enters a PIN code, gets a delivery date.

- **`843c2d9`** initial feature · **`b3f664f`** auto-inject (no theme block needed; skips
  when `[data-delivery-estimate]` exists) · **`dcecdec`** placement setting (migration 0009)
- **`2b0a694`** Standard/Express/Both via Delhivery's `mot=S` / `mot=E`
- **`560e271`** merchant-editable copy (migration 0013)

**Bugs and decisions:**

- The result row **wrapped to two lines** — icon and text needed a flex row, not inline
  elements.
- With "Show both", two labelled rows confused shoppers. Now shows the **fastest** date with
  **no** standard/express labels — the merchant asked for exactly this: *"don't mention
  express or standard"*.
- **`ed3816b` / `3219bfb` — Section Rendering.** Release-family themes rebuild
  `<product-info>` on every variant change, **wiping injected widgets**. All renderers were
  made **idempotent**, watched by a debounced MutationObserver, with bounded retries when the
  anchor isn't in the DOM yet. The countdown interval clears itself on detach so repeated
  swaps don't leak.
- `below-description` had to resolve to the block's **outer container** — otherwise the
  widget lands inside a collapsed accordion and is invisible.

> ### 🔑 Lesson
> **On Dawn-descendant themes, assume your injected DOM will be destroyed at any moment.**
> Renderers must be idempotent and self-healing, never fire-and-forget.

---

## Phase 7 — Order Management & the PCD wall (Jul 13-16)

~25 commits, the hardest sustained problem in the project.

**`d2e1c1e`** shipped customer self-service cancel + address edit via the app proxy
(`authenticate.public.appProxy` + `logged_in_customer_id` + ownership check + server-side
eligibility re-check). Then Shopify's **Protected Customer Data** review approved **Level 1**
(customer ID, order number) and **denied Level 2** (Name, Address).

### The non-obvious breakage

The order lookup requested `shippingAddress` in the **same GraphQL query** that powered
cancellation. **Shopify rejects the entire query** when it contains unapproved PCD fields —
so **cancel broke too**, for a reason that had nothing to do with cancelling.

**`14d62ac`** split it into `ORDER_FIELDS_BASE` (Level-1 only) vs
`ORDER_FIELDS_WITH_ADDRESS`, behind a single flag `ADDRESS_EDIT_ENABLED = false`. Flip it to
`true` if/when Level-2 is granted — nothing else changes.

Earlier, **`9f2b8bd`** made the failure *diagnosable*: without PCD, Shopify redacts
`order.customer` entirely, so the ownership check couldn't distinguish "exists but redacted"
from "not yours" — both returned `order-not-found`. Now returns a distinct `protected-data`
signal.

### The checkout-extension saga (18 commits)

Getting a cancel button onto the **thank-you page** — because a theme app embed **cannot**
run there:

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| 1 | Extension never registered, absent from every deploy | **44-char malformed `uid`** — a real v4 UUID with 8 stray chars appended | `25c3dd0` |
| 2 | Entire app version wouldn't release | `network_access` capability needs **Shopify approval** | `6bf67c4` → approved → `1714534` |
| 3 | Block rendered completely blank | Read `data.orderManagement`; the API nests it at **`data.widgets.orderManagement`** | `d1fabc8` |
| 4 | `orderId` always null | Wrong API paths. Thank-you needs `useSubscription(api.orderConfirmation).order.id`; account page needs `useOrder().id` | `dd415f7` |
| 5 | "Failed to fetch" on every request | Extensions run at **null origin**. `authenticate.public.checkout` **throws a Response with no CORS headers**, so even the unauthenticated OPTIONS preflight failed | `09792e3`, `a0e1cff` |
| 6 | Still failing after correct fixes | **The extension hadn't been redeployed** | — |
| 7 | POST reached the server with a valid token, then 500'd | Post-auth exception, masked as "Failed to fetch" because Remix's 500 page carries no CORS headers | `946101e` (TEMP diagnostics) |

**Also required:**
- `api_version >= 2025-07` for checkout UI extensions
- `@remote-ui/react` needs **`react-reconciler`** as an explicit dependency
- **Shopify CLI ≥ 3.84.1** — the Partners API refuses older versions outright
- `extensions/` excluded from the app `tsconfig.json` (they build separately)

**Guest authorization design.** Guests have **no `sessionToken.sub`**, so ownership can't be
verified the normal way. A guest may cancel only if **all** hold: order `createdAt` ≤ 60 min,
unfulfilled, and cancellable under the merchant's `cancelScope`. A stranger is very unlikely
to know a fresh order's gid, and only already-cancellable orders qualify.

> ### ⚠️ Still live: `TEMP:` diagnostics
> `946101e`, `0f47e7f`, `97764e8`, `c7cb58f` surface **raw error codes to real shoppers**
> (`"Couldn't cancel (server: …)"`), and `corsSafe` returns **HTTP 200 on crashes**. These
> were debugging aids. **Clean them up.**

---

## Phase 8 — Wishlist (Jul 13)

**`683b098`** — replaced the third-party Wishlist Hero: localStorage for everyone, plus
cross-device sync for logged-in customers via the app proxy. Two proxy routes
(`/wishlist` renders an application/liquid page inside the theme layout; `/wishlist-sync`
GETs/POSTs the handle list, validated and capped at 250). Deleted products are pruned on 404.

**Seven of the eight commits were about making the header badge look native** — an
instructive escalation:

1. `d23bccd` — Release uses `ul.header__utils-items`, not Dawn's `.header__icons`
2. `8b127c4` — position it *before* the cart icon; clone the cart badge's colours
3. `ba2f376` — colours weren't enough: clone size, font, radius, corner offset
4. `fd220f9` — **empty carts hide the badge** (`display:none`, 0×0), skipping the clone.
   Force-measure it invisibly, **snapshotting computed values before restoring** because
   `getComputedStyle` is live
5. `4223870` — offset was relative to the cart *link*, whose padding differs from our anchor.
   Measure against the **icon glyph** instead
6. `3d84550` — on Dawn the document-wide selector matched **Wishlist Hero's own hidden
   element**, flinging our badge across the header. Scope the lookup inside the cart link,
   exclude wishlist/badgehq elements, and **clamp implausible offsets** (>30px)

> ### 🔑 Lesson
> Cloning theme styling is far harder than it looks. Elements may be **hidden when you
> measure**, `getComputedStyle` is **live** (snapshot before restoring), offsets are
> relative to whichever box you measured, and **other apps' elements can match your
> selectors**. Always clamp results and keep a sane fallback.

---

## Phase 9 — Back in Stock: three delivery rewrites (Jul 17-19)

~25 commits. The feature shipped three times with three different delivery mechanisms.

### Attempt 1 — Shopify-native email (`dab50ff`)

**Because Shopify has no API to email a shopper directly**, delivery went:
`inventory_levels/update` webhook → **Flow trigger** (`flowTriggerReceive`) → merchant's
marketing automation → Shopify Email. That path only reaches **marketing subscribers**, so
signup also subscribed the shopper (stated plainly in the form).

**The Flow trigger schema took 3 attempts — the docs actively mislead:**

| Wrong | Right | Commit |
|---|---|---|
| `type = "string"` | **`single_line_text_field`** | `634697a` |
| Keys with spaces (`"Product title"`) | **single words** (`producttitle`) — spaces are ambiguous in the email's Liquid | `cd8a5cb` |
| `[[settings.field]]` singular, nested under `[[extensions]]` | **`[[settings.fields]]` plural, TOP-level `[settings]`** | `8f17e29` |

> **The third one is vicious:** get it wrong and Shopify **silently drops every field**. No
> error. The variable picker just shows `shop`, and "Send marketing email" fails with
> "Customer needed". Also: `customer_id` must be the **numeric legacyResourceId, not the gid**.

**Then the whole approach collapsed:**
- Automations requires **Shopify Flow**, unavailable on some plans
- Shopify **moved marketing automations into Messaging** (May 1 2026) — the guide had to be
  rewritten (`5c393c6`)
- Signups kept landing as **"Waiting (not subscribed)"**

**`9f6d235` found that last root cause:** `customers(query:)` returns **nothing for customers
who do exist** — it depends on the search index *and* PCD access. So the code fell through to
`customerCreate`, Shopify replied *"Email has already been taken"*, and a **null customerId**
was stored, making the shopper permanently unreachable. Fix: treat that rejection as "the
customer exists" and look them up via **`customerByIdentifier`** (exact match, no index).

**Also fixed in this era:**
- **`4d887cc`** — the worker only routed a fixed list of **GET** paths, so the signup
  **POST** 404'd. *Every* "Notify me" submission failed.
- **`0f9b0d2`** — never compare the ATC button's **label**: this store retranslates
  "Sold out" → "Restocking soon". Only the `disabled` attribute is trustworthy. And
  `available` alone can't distinguish out-of-stock from continue-selling, so it fetches
  `/products/<handle>.js` for authoritative `inventory_quantity/management/policy`.
- **`7f9a8e7`** — Section Rendering themes update the ATC only after a network round-trip, so
  the DOM describes the **previous** variant for 200-600ms. Listen to the radio `change`
  event instead.

### Attempt 2 → 3 — WhatsApp (`2f14b89`, design ported from ReturnHQ)

Replaced email entirely with **WhatsApp via Interakt or DoubleTick**. The shopper types their
own number — **first-party data** — so notifying needs **no PCD at all**.

| | Interakt | DoubleTick |
|---|---|---|
| Endpoint | `api.interakt.ai/v1/public/message/` | `public.doubletick.io/whatsapp/message/template` |
| Auth | `Authorization: Basic <key>` — key is **already base64, never re-encode** | `Authorization: <key>` (raw) |
| Body vars | `template.bodyValues` | `templateData.body.placeholders` |
| Image header | `template.headerValues: [url]` | `templateData.header {type:"IMAGE", mediaUrl}` |
| URL button | `buttonValues: {"0": [suffix]}` (**0-based index**) | `templateData.buttons[{type:"URL",parameter}]` |
| Extra | — | requires a **sender number** |

> ### 🔑 WhatsApp/Meta gotchas
> - **Meta rejects a send if ANY body variable is empty.** Every value is whitespace-
>   flattened with a non-empty fallback, and **`"Default Title"`** (Shopify's single-variant
>   placeholder) is treated as empty.
> - **A dynamic URL button sends only the SUFFIX**, not a full URL. The approved template
>   holds `https://<shop>/products/` and we send `handle?variant=id` (**128-char cap**).
> - **Body-value count must match the template exactly.** Dropping `{{3}}` from the template
>   means dropping it in code (`55afd76`) — a mismatch is rejected.
> - The image header needs a **fallback image**, or products without a featured image fail
>   silently and those shoppers wait forever.
> - **`notifiedAt` is set only when the provider accepts**, so failures retry next restock
>   instead of being lost.
> - Interakt 401/403 usually means the plan lacks API access (Growth+), not a bad key.

**`f68d426` — email removed entirely.** Phone became the identity
(`@@unique([shop, variantId, phone])`), `email` and `customerId` columns dropped, the
customer-mirror and Flow trigger deleted, and `extensions/badgehq-flow` removed so no
merchant could wire up emails that would never send. Migration 0019 also **deletes rows with
no phone** (unreachable) and collapses duplicates before applying the new key.

**PCD-free, honestly.** Scope-gating (from ReturnHQ's `0f1266a`) means a shop without
`write_customers` makes **zero** customer API calls: a live
`currentAppInstallation.accessScopes` check per webhook batch, and the cached session scope
on the shopper's request path (latency matters there).

---

## Phase 10 — AI chat & a self-inflicted outage (Jul 18-19)

### Automated Replies (`90fa6a4`)

A chat bubble answering from merchant-written store info, using the **merchant's own Gemini
key** — so it costs us nothing and needs no quota system. Guarded system prompt forbids
inventing policies/prices/dates. Server-enforced caps (1000 chars/message, 10 turns / 4000
chars history) because each call spends the merchant's quota. Transcript lives in
**`sessionStorage` only** — nothing server-side, so no privacy or PCD surface.

- **`71ae4dd` — Google shut down `gemini-2.0-flash` on 2026-06-01.** It now 404s, which the
  code lumped into "upstream" and reported as ***"Couldn't reach Gemini. Check the key"*** —
  blaming a key that was perfectly fine. Now on **`gemini-2.5-flash`**, with 404 mapped to a
  distinct `bad-model` error so a future retirement names itself.
- **`2e722c8`** — links rendered as raw text. Now parsed from markdown into **real DOM
  anchors** — deliberately **never `innerHTML`**, since the text is LLM output. Only
  `http(s)`/`mailto`/`tel` are linkified; `javascript:` URLs and stray HTML stay inert text.
  Verified with injection tests.

### 🔴 The outage — read this twice

**`c6af1db`.** I appended `waFallbackImage` to migration **0017 after it had already been
applied**. Prisma tracks migrations **by name**: it saw 0017 as done, logged
***"No pending migrations to apply"***, and **never created the column**.

Every query touching `BackInStockSettings` then threw — which **500'd `/api/widgets`**,
taking down **every storefront widget on every shop**, not just Back in Stock.

Fix: ship the column as its own migration `0018`, and **restore 0017 to exactly what was
applied** so its checksum still matches.

> ### ⚠️ RULE: applied migrations are immutable. New column = new migration file. Always.
> **Symptom to recognise:** *"No pending migrations to apply"* in the Vercel build log while
> the code references a column that doesn't exist. Check the build log **before** debugging
> the app.

**Related trap — `3adf061`.** Merchant-editable copy (`consentText`, `successText`) is stored
per-shop, so **changing a default does nothing for shops that already saved**. Shoppers were
still promised an email after the WhatsApp switch. Required a **data migration** to rewrite
any copy still mentioning email.

---

## Phase 11 — Theme performance & UI polish (Jul 19)

### Theme fixes (live in the theme, **not** this repo)

**Symptom the merchant reported:** *"the image came in the network tab in a flash, but showed
on the website after 2-3 seconds."* That observation was the breakthrough — it proved the
bytes had already arrived, so this was never a network problem.

**Two bugs compounding:**

1. `section-product.css` hides the gallery until JS runs:
   `.swiper { opacity: 0 }` → `.swiper-initialized { opacity: 1 }`
2. `product-media-gallery.js` waited for **`window.load`** — which doesn't fire until
   **every** image, font and third-party script finishes (Snapmint, Shopflo, Subify,
   Essential badges).

So the hero image sat fully downloaded at `opacity: 0`, waiting on the slowest app on the
page. Fixed by initialising on **`DOMContentLoaded`**. The **same bug existed in `global.js`**
for site-wide sliders, where it hides the entire `<section>`.

**Every gallery image was `loading="eager"` + `fetchpriority="high"`** — hero, thumbnails,
off-screen slides (9 images, 0 lazy). When everything is top priority, nothing is. The theme
*has* correct lazy-loading logic, but it was **dead code**: every caller passed
`media_index: media_index_for_image`, a variable **never assigned anywhere in the theme**. So
the `section_index < 2` branch forced eager on everything.

**Sold-out variants couldn't be selected** — this needed **two** fixes, and the second only
surfaced from runtime evidence:
1. `product-option.liquid` rendered a real `disabled` attribute → removed (kept the class)
2. `base.css`: `.product-option__input.disabled + label { pointer-events: none }` — and since
   the radio is `visually-hidden`, **the label is the only click target**

> ### 🔑 Lesson
> Removing a `disabled` **attribute** is only half the job — check whether CSS keys off a
> `disabled` **class** too. Confirmed only by running this in the console:
> ```
> disabled attr: false          ← the Liquid fix worked
> pointer-events on label: none ← but clicks were still blocked
> checked after click: true     ← the input worked when clicked directly
> ```

**Other measured findings:** HTML TTFB 0.16s and image TTFB 0.4s (server and CDN are fine);
**72 script tags / ~570 KB JS**; one hero **PNG at 1,250 KB vs 144 KB** for an equivalent JPG;
`image_optimization` was set to `false`, serving full-resolution originals.

**A theme-export trap:** uploading the exported theme as a preview **404'd every product
page** — the snapshot didn't carry custom product-template assignments
(`27may26-relaxed-fit`). Verified my edits weren't at fault: Shopify's own `theme check`
reported **38 errors on the pristine vendor theme and the same 38 with my changes**. Prefer
editing a **duplicate of the live theme** via Edit code.

### Widget UI fixes (`public/widget.js`)

- **Buttons unreadable** (`7ccd2ca`, `ed878d3`) — `bisStyleLikeAtc` copied the ATC's
  background colour onto text+border. On a sold-out variant the ATC is **disabled** — light
  grey (`rgb(224,224,224)` on Release) — so the button rendered grey-on-white. Now guarded by
  `bisReadableColor()` (BT.601 luminance ≤ 160). **The identical bug existed in the wishlist
  button** — I fixed it in one place first and didn't check for the pattern elsewhere.
- **Panel layout took four attempts** (`4b68041` → `ed878d3` → `9b7fc95` → `6fef3ab`). The
  button must match the ATC's slot, but the *panel* should span the full row. That needs
  **both a width and a negative left offset** — width alone overflowed and pushed the submit
  button off-screen. And the offset must be measured **after** the ATC is hidden, or the
  wrapper hasn't taken its place yet.
- **Placeholder wording** — "WhatsApp number" didn't tell shoppers the format, so they
  guessed `+91`/spaces and failed validation. Now "10-digit mobile number", with the error
  naming the mistake: *"without +91 or spaces"*.

> ### 🔑 Lesson
> CSS in `widget.js` lives inside **JS string concatenation**. A `//` comment *between*
> concatenated strings is fine; **inside** the CSS string it silently breaks the entire
> stylesheet. I made this mistake once — always verify the **runtime** CSS, not the source.

---

## Standing rules

1. **Never edit an applied migration.** New column → new migration file. *(Cost: a full
   storefront outage.)*
2. **Deploys are two-headed.** Backend → `git push`. **`public/widget.js` → also
   `cd cloudflare-worker && npm run deploy`.** Forgetting the second means testing yesterday's
   code — this wasted multiple debugging rounds.
3. **`widget.js` is browser-cached for 1 hour.** Always hard-refresh (`Ctrl+Shift+R`) or use
   incognito after a worker deploy.
4. **Verify the runtime, not the source.** Rendered HTML, computed styles, the served bundle,
   the build log. Multiple long hunts ended in *"the fix was never deployed"* or *"the code
   was in a different file."*
5. **A storefront-visible setting touches six places** (schema → migration → admin loader +
   action → `api.widgets.tsx` → `widget.js` → `bumpConfigVersion`). Miss one and it silently
   no-ops.
6. **Merchant-editable text is stored per-shop.** Changing a default does nothing for existing
   shops — that needs a data migration.
7. **PCD:** never query `shippingAddress` or customer names without approval — it fails the
   **whole query**, breaking unrelated features. Gate customer API calls on the granted scope.
8. **Theme edits are lost on theme update.** `THEME-CHANGES-HOW-TO-APPLY.md` is the
   re-application guide. Prefer duplicating the live theme over uploading an export.
9. **Don't couple to theme class names.** Walk the DOM by structure (price element, glyph,
   form) — class names differ per theme and change on updates.
10. **Assume injected DOM will be destroyed.** Section Rendering themes rebuild
    `<product-info>` on every variant change. Renderers must be idempotent and self-healing.
11. **When cloning theme styles:** the source may be hidden (0×0), `getComputedStyle` is live
    (snapshot before restoring), and other apps' elements can match your selectors. Clamp
    implausible values and keep a fallback.
12. **Fix the pattern, not just the instance.** The ATC-colour bug and the `window.load` gate
    each existed in two places. After fixing one, grep for the other.

---

## Debugging playbook

Ordered by how often it actually found the problem:

1. **Is the new code even live?** Check `X-Widget-Hash` on the worker, the Vercel build log,
   and whether the extension was redeployed.
2. **Read the build log for migrations.** *"No pending migrations to apply"* + a missing
   column = the Phase 10 outage.
3. **Get runtime evidence before theorising.** A five-line console snippet
   (`getComputedStyle`, `getBoundingClientRect`, `hasAttribute`) has repeatedly beaten source
   reading — it's what solved the sold-out-variant and "form not showing" issues.
4. **Compare against pristine.** Diff your edits against the original export; run
   `theme check` on both to distinguish your errors from the vendor's 38.
5. **Check the live API directly.** `curl /api/widgets?shop=…` shows exactly what the
   storefront receives — this proved the AI-chat config was fine and I'd queried the wrong
   shop domain.
6. **Hard-refresh before believing a negative result.**

---

## Open items

| Item | Why it matters |
|---|---|
| **PNG → JPG** for product photos | Biggest remaining speed win: measured **1,250 KB vs 144 KB** for the same image, same dimensions |
| **`TEMP:` diagnostics** in order-cancel | Shows raw error codes to real shoppers; `corsSafe` returns 200 on crashes |
| **Back in Stock end-to-end test** | Interakt template approval → Send test → real restock. Never yet proven live |
| **Level-2 PCD re-request** | Address editing stays disabled behind `ADDRESS_EDIT_ENABLED` until granted |
| **Third-party script audit** | ~570 KB across 72 script tags on the product page |
| **`widget.js` size** | 160 KB raw / 43 KB gzip — async, so not blocking, but worth splitting per enabled feature |
| **`write_customers` scope** | Now unused by any code; left in place because removing it forces a merchant re-auth |
| **Theme edits** | Applied via Edit code — will be lost on a vendor theme update |

---

## Reference

**Key files**

| Path | Role |
|---|---|
| `public/widget.js` | ~3,800 lines — every storefront feature |
| `app/routes/api.widgets.tsx` | Config → storefront. **Nested under `data.widgets`** |
| `app/utils/whatsapp.server.ts` | Interakt + DoubleTick clients |
| `app/utils/back-in-stock.server.ts` | Restock resolution + send |
| `app/utils/order-actions.server.ts` | `ADDRESS_EDIT_ENABLED` lives here |
| `app/utils/ai-replies.server.ts` | Gemini client + guarded prompt |
| `app/utils/config-version.server.ts` | Cache-bust on save |
| `cloudflare-worker/src/index.js` | Edge cache + API proxy |
| `extensions/badgehq-widget/` | Theme app extension (embed + blocks) |
| `extensions/order-actions-ui/` | Checkout/customer-account UI extension |

**Environment:** `DATABASE_URL` · `DATABASE_POSTGRES_URL_NON_POOLING` · `SCOPES` ·
`BUMP_SECRET` · `SHOPIFY_API_KEY` / `SHOPIFY_API_SECRET`

**Scopes:** `read_products, write_products, write_script_tags, read_script_tags,
read_themes, read_orders, write_orders, read_inventory, write_customers`

**Commands**
```bash
git push origin main                          # backend → Vercel (auto)
cd cloudflare-worker && npm run deploy         # storefront widget.js
npx shopify app deploy                         # extensions (CLI >= 3.84.1)
npx prisma migrate dev --name <name>           # NEW migration — never edit an old one
npx vercel@latest inspect --logs badge-hq.vercel.app   # build/migration logs
```
