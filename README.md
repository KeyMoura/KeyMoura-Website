# KeyMoura Website

A Next.js storefront and order workspace for KeyMoura, with configurable products,
Stripe Checkout, customer messaging, notifications, and optional community tools.
Supabase provides authentication, PostgreSQL, RPCs, and object storage.

> **Template status:** the application UI builds and its static tests pass, but
> this repository is not yet a one-command fresh database install. The checked-in
> migrations do not define every relation, RPC, storage bucket, and RLS policy
> used by the application. Read [`docs/FINAL_QA.md`](docs/FINAL_QA.md) before
> deploying a new instance.

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
not part of the locked dependencies yet; the final QA report records why it was
not added during this pass.

## Configure a new site

1. Change identity, shared terminology, navigation, canonical URL, and module
   visibility in [`src/site.config.ts`](src/site.config.ts).
2. Replace instance artwork in `public/brand` and `public/hero-silvia.png`.
3. Adjust centralized theme tokens in `src/app/globals.css` and
   `tailwind.config.ts` rather than recoloring individual pages.
4. Review editorial and legal content before production releases.
5. Keep authorization on every route even when a module is hidden. Current
   feature switches control discoverability; they are not security controls.

## Supabase and first administrator

New deployments use the protected first-run installer. Follow
[`docs/FIRST_RUN_INSTALLER.md`](docs/FIRST_RUN_INSTALLER.md) to apply the additive
server-side bootstrap and complete `/install`. Do not paste a database URL or
service-role key into the browser.

The core bootstrap is complete for identity, roles, permissions, installation
state, module versions, settings, and avatar storage. Some legacy optional-module
schemas still require the sanitized compatibility export identified in the
installer guide. Never use production data to test bootstrap or destructive
flows.

## Deployment and upgrades

- Configure the three variables from `.env.example` in the hosting platform.
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
