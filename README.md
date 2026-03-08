# BadgeHQ - Shopify App

A Shopify app built with [Remix](https://remix.run), ready for publishing on the [Shopify App Store](https://apps.shopify.com/).

## Tech Stack

- **Framework**: [Remix](https://remix.run) with [Vite](https://vitejs.dev/)
- **UI**: [Shopify Polaris](https://polaris.shopify.com/) + [App Bridge](https://shopify.dev/docs/apps/tools/app-bridge)
- **Database**: [Prisma](https://www.prisma.io/) with SQLite (development) — swap to PostgreSQL/MySQL for production
- **API**: Shopify Admin [GraphQL API](https://shopify.dev/docs/api/admin-graphql)
- **Auth**: Managed by [@shopify/shopify-app-remix](https://www.npmjs.com/package/@shopify/shopify-app-remix)

## Prerequisites

- [Node.js](https://nodejs.org/) v20.19+ or v22.12+
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli) (`npm install -g @shopify/cli`)
- A [Shopify Partner account](https://partners.shopify.com/signup)
- A development store

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Connect to Shopify

```bash
npm run config:link
```

This links the app to your Shopify Partner dashboard app.

### 3. Start development

```bash
npm run dev
```

This will:
- Generate the Prisma client
- Run database migrations
- Start the Remix dev server
- Create a tunnel for your local app

### 4. Install on a dev store

Press `p` in the terminal running `shopify app dev` to open the app install URL.

## Project Structure

```
├── app/
│   ├── routes/
│   │   ├── app.tsx                          # App layout with auth + navigation
│   │   ├── app._index.tsx                   # Home page
│   │   ├── app.additional.tsx               # Example additional page
│   │   ├── auth.login/                      # Login page
│   │   ├── webhooks.app.uninstalled.tsx     # App uninstall handler
│   │   ├── webhooks.app.scopes_update.tsx   # Scope update handler
│   │   ├── webhooks.customers.data_request.tsx  # GDPR: Customer data request
│   │   ├── webhooks.customers.redact.tsx    # GDPR: Customer data deletion
│   │   └── webhooks.shop.redact.tsx         # GDPR: Shop data deletion
│   ├── db.server.ts                         # Prisma client singleton
│   ├── shopify.server.ts                    # Shopify app configuration
│   ├── entry.server.tsx                     # Remix server entry
│   ├── root.tsx                             # Root layout
│   └── routes.ts                            # Route configuration
├── prisma/
│   └── schema.prisma                        # Database schema
├── extensions/                              # Shopify app extensions
├── shopify.app.toml                         # Shopify app configuration
├── shopify.web.toml                         # Web process configuration
├── vite.config.ts                           # Vite configuration
├── Dockerfile                               # Production Docker image
└── package.json
```

## Deployment

### Building for production

```bash
npm run build
```

### Using Docker

```bash
docker build -t badgehq .
docker run -p 3000:3000 --env-file .env badgehq
```

### Deploying to Shopify

```bash
npm run deploy
```

This pushes your app configuration and extensions to Shopify.

## App Store Submission Checklist

Before submitting to the Shopify App Store:

- [ ] Update `shopify.app.toml` with your app's `client_id` and URLs
- [ ] Configure proper OAuth scopes (only request what you need)
- [ ] Implement GDPR webhook handlers (customer data request, customer redact, shop redact)
- [ ] Switch from SQLite to a production database (PostgreSQL recommended)
- [ ] Add app listing metadata (description, screenshots, etc.) in Partner Dashboard
- [ ] Test with multiple stores and various Shopify plans
- [ ] Ensure the app works in both embedded and non-embedded modes
- [ ] Follow [Shopify's app requirements](https://shopify.dev/docs/apps/launch/app-requirements)

## Environment Variables

Copy `.env.example` to `.env` and fill in your values:

| Variable | Description |
|---|---|
| `SHOPIFY_API_KEY` | Your app's API key from Partner Dashboard |
| `SHOPIFY_API_SECRET` | Your app's API secret |
| `SCOPES` | OAuth scopes (comma-separated) |
| `SHOPIFY_APP_URL` | Your app's public URL |

## Resources

- [Shopify App Development docs](https://shopify.dev/docs/apps)
- [Remix documentation](https://remix.run/docs)
- [Polaris components](https://polaris.shopify.com/)
- [Admin API reference](https://shopify.dev/docs/api/admin-graphql)
- [App Store submission guide](https://shopify.dev/docs/apps/launch)
