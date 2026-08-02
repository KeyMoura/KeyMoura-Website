# KeyMoura

The KeyMoura website: a product catalog, custom-order workflow, project library,
and community, built on Next.js 16 (App Router). Supabase provides
authentication, PostgreSQL, RPCs, and object storage. Stripe handles checkout and
payment webhooks. Vercel hosts the runtime.

## What the site does

- **Catalog** (`/catalog`) — published products with options, media, inventory,
  and availability.
- **Custom orders** (`/orders/new`) — a guided request, staff quote, customer
  approval, payment, and fulfillment workflow with a per-order hub.
- **Projects** (`/projects`) — the reviewed build and reference library, with
  submissions, updates, categories, and staff moderation.
- **Community** (`/community`) — categories, threads, replies, voting, and
  moderation.
- **Account and staff tools** — orders, messages, notifications, reports,
  roles and permissions, security, audit, appearance, and catalog management.

`/info` remains as a permanent redirecting alias for the older Projects URLs.
`/projects` is canonical; link to it everywhere.

## Prerequisites

- Node.js 20 or later
- npm (use the committed `package-lock.json`)
- A disposable Supabase project for development and verification

## Local development

1. Install exactly the locked dependencies:

   ```bash
   npm ci
   ```

2. Copy the environment template and fill in your development project values:

   ```bash
   cp .env.example .env.local
   ```

   `SUPABASE_SERVICE_ROLE_KEY` is server-only. Never prefix it with
   `NEXT_PUBLIC_`, commit it, or expose it to browser code.

3. Start the application:

   ```bash
   npm run dev
   ```

4. Open <http://localhost:3000>.

## Verification

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

The browser regression in `e2e/header-layout.spec.js` additionally requires
`@playwright/test` and a Playwright Chromium installation. It is intentionally
not part of the locked dependencies; see [`docs/FINAL_QA.md`](docs/FINAL_QA.md).

## Configuring identity and appearance

Most brand configuration is runtime data, not code. Staff with the
`appearance.manage` permission change it from `/staff/appearance`:

- business name, tagline, description, public URL, support email, copyright
- logo, wordmark, footer logo, favicon, and Apple icon paths
- section labels (Community, Projects, Trusted Shop)
- colors, typography, spacing, radius, and shared component styles
- the public navbar palette, including its independent utility-control colors
- named **appearance templates** that can be saved, applied for preview, renamed,
  and deleted without publishing

[`src/site.config.ts`](src/site.config.ts) only supplies the build-time fallback
used before the database is reachable. Shared component styling lives in
`src/app/globals.css` and `tailwind.config.ts`; change tokens there rather than
recoloring individual pages.

## Supabase and first administrator

New deployments use the protected first-run installer. Follow
[`docs/FIRST_RUN_INSTALLER.md`](docs/FIRST_RUN_INSTALLER.md) to apply the additive
server-side bootstrap and complete `/install`. Do not paste a database URL or
service-role key into the browser.

The core bootstrap is complete for identity, roles, permissions, installation
state, module versions, settings, and avatar storage. Some optional-module
schemas still require the sanitized compatibility export identified in the
installer guide. Never use production data to test bootstrap or destructive
flows.

## Deployment and upgrades

- Configure the variables from `.env.example` in the hosting platform.
- Build with `npm ci && npm run build`.
- Apply migrations to staging in timestamp order, run the automated suite and
  [`docs/MANUAL_CHECKS.md`](docs/MANUAL_CHECKS.md), then promote the same build.
- Back up the database before upgrades. Apply migrations; do not edit already
  deployed migration files. Rollback files are operator references and must be
  reviewed before use.
- Create staff users and manage roles, permissions, verified perks, security,
  audit, and recycle-bin workflows from `/staff` after bootstrap.

## Documentation

- [`docs/FINAL_QA.md`](docs/FINAL_QA.md): release decision, evidence, limitations,
  browser matrix, and exact pre-merge checks
- [`docs/INVENTORY.md`](docs/INVENTORY.md): routes, handlers, and database/RPC usage
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md): runtime and trust boundaries
- [`docs/AUDIT.md`](docs/AUDIT.md): security and maintainability findings
- [`docs/MANUAL_CHECKS.md`](docs/MANUAL_CHECKS.md): seeded-environment checklist
- [`docs/MINI_PROFILE_ACTIVITY.md`](docs/MINI_PROFILE_ACTIVITY.md): throttled
  last-online behavior
