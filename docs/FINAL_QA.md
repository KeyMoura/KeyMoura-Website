# Final QA and template-readiness report

**Date:** 2026-07-29  
**Baseline:** `2ca19ae` (merged centered-header and mini-profile work)  
**Target:** `codex/stabilize-template`  
**Decision:** **Conditionally ready for UI review; not ready for a fresh production database install.**

## Method and evidence

This pass installed locked dependencies with `npm ci`, enumerated every App
Router page/layout/handler and shared component, reviewed the existing static
security and consistency audits, and ran the repository verification commands.
`docs/INVENTORY.md` is the route/API/database inventory; `docs/ARCHITECTURE.md`
describes layouts, global components, and trust boundaries.

No Supabase URL, test users, seed/bootstrap process, or empty staging database
was provided. Consequently, claims involving persisted data, RLS enforcement,
role-specific browser sessions, scheduled jobs, mail delivery, or destructive
workflows are explicitly **not verified**, rather than inferred from UI code.

## Findings by severity

### Critical — confirmed

1. **A fresh database cannot be reproduced from this repository.** Application
   code references the relations, storage bucket, and RPCs in `INVENTORY.md`,
   while only three forward migrations are checked in. The complete base schema,
   RLS, grants, functions, storage policies, and role seed are absent. Evidence:
   static `.from()`/`.rpc()` inventory and `supabase/migrations`.

### High — confirmed

1. **Full authorization/RLS verification is blocked.** Service-role use is
   server-only in the reviewed helpers, but route-local authorization patterns
   remain and cannot compensate for missing auditable RLS definitions.
2. **Moderation recovery requires staging rehearsal.** Recycle-bin restoration,
   permanent purge, report escalation, audit attribution, and scheduled cleanup
   depend on deployment schema/state. No production data was modified.

### Medium — confirmed

1. **Committed browser regression infrastructure is incomplete.** The header
   Playwright spec exists, but `@playwright/test` is not locked. An attempted
   installation returned registry HTTP 403, so dependencies were not partially
   updated and the test was not represented as passing.
2. **Feature flags control navigation, not complete module shutdown.** Garage and
   trusted-vendor flags hide configured navigation. Direct pages and APIs still
   require their normal authorization and deployment controls.
3. **Lint remains a legacy-quality gate.** The full ESLint run is resource-heavy
   and the prior repository audit records a large existing violation set. Rules
   were not disabled and types were not weakened.

### Low — confirmed

1. Node's test runner reports module-type reparsing warnings for TypeScript test
   files. Adding `"type": "module"` would break the CommonJS Playwright config
   unless that configuration is migrated together, so this was documented rather
   than changed speculatively.

### Uncertain candidates — retained

- The production-guarded `/dev/menuselect` component harness.
- Overlapping legacy `/api/admin/*` and newer `/api/staff/*` handlers.
- Unreferenced framework SVG assets.
- Compatibility fallbacks for partially migrated database schemas.

These may have external consumers, development value, or deployment-version
dependencies. No code, route, migration, asset, export, or package was removed in
this pass.

## Route and interaction coverage

Static reachability and boundaries were reviewed for the complete page and route
tables in `INVENTORY.md`. The root layout, staff layouts, API handlers, middleware,
global header/footer, command palette, lockdown/security watchers, broadcast,
block provider, last-seen updater, dialogs, shared cards, and staff navigation
were included in the inventory review.

The following runtime matrix remains mandatory against a seeded preview:

| Dimension | Required values |
|---|---|
| Viewer | logged out, regular user, support, moderator, administrator |
| Width | 1440 desktop, 1100 narrow desktop, 768 tablet, 390 and 320 mobile |
| Desktop zoom | 100%, 125%, 150% |
| Input | mouse, touch emulation, keyboard only |

For each combination, inspect overflow/clipping, header geometry, focus order,
labels, touch targets, dialogs, tables, empty/loading/success/failure states,
console/hydration errors, failed requests, and redirects. Preserve the centered
desktop navigation with Search on the left and user controls on the right.

## Functional/security checks requiring seeded accounts

1. Sign-up/login/callback/logout, profile and username updates, account deletion,
   bans, restrictions, session revocation, and lockdown.
2. Thread creation, replies, editing, voting, accepted answers, soft deletion,
   restoration, permanent purge, and attribution in the audit log.
3. Report creation/messaging, escalation/de-escalation, bulk/status actions, DM
   target resolution, notifications, and failure feedback.
4. Prove support receives `403` for recycle restoration and administrator-only
   actions; verify moderator and administrator permission differences.
5. Knowledge-base submit/update/review/PDF/search analytics; messages and unread
   notifications; command-palette keyboard/empty/error behavior.
6. Mini-profile bio and last-online display, privacy expectations, and throttled
   activity writes described in `MINI_PROFILE_ACTIVITY.md`.
7. Garage create/edit/like and Shops/vendor staff workflows when enabled; confirm
   hidden modules cannot be reached if an installation promises full disablement.
8. Trace browser requests to confirm no service-role credential is present, then
   exercise anon/authenticated RLS directly for every referenced relation.

## Template readiness

- **Complete:** identity, terminology, canonical URL, navigation, and module
  switches are centralized in `src/site.config.ts`; brand theme tokens are
  centralized; `.env.example` contains placeholders and labels the service key
  server-only; migrations have ordered timestamps.
- **Partial:** some S-Chassis wording is legitimate instance content; module flags
  do not yet disable direct routes/APIs; installation, deployment, administration,
  customization, and upgrade guidance is now discoverable from `README.md`.
- **Blocked:** complete baseline migrations/RLS, a safe role/bootstrap seed,
  documented schema-specific first-admin SQL, and fresh-install verification.

## Migration and deployment requirements

1. Export a sanitized production schema including functions, triggers, grants,
   RLS, storage policies, cron jobs, and seed/reference rows.
2. Convert it to an idempotent baseline for a new disposable project; do not
   rewrite migrations that have already been deployed.
3. Reconcile the baseline with the three tracked forward migrations and validate
   rollback notes separately.
4. Bootstrap five QA accounts, run the role/browser matrix and destructive-flow
   rehearsal, and retain screenshots/audit records.
5. Only then approve a production rollout. No destructive migration is proposed
   by this QA pass.

## Preview and screenshots

A trustworthy shareable preview URL cannot be produced without deployment
credentials and a configured Supabase preview project. Local startup alone is
not a working preview for data-backed routes. Representative screenshots also
remain blocked because Playwright is not installed and its registry request was
denied. Once available, run the committed header spec and capture `/`, `/info`,
`/community`, and one permitted `/staff` page at 1440×900 and 390×844.

## Exact final manual gate

Follow `MANUAL_CHECKS.md`, then record: preview URL; commit SHA; migration set;
five non-production account IDs/roles; browser versions; all console/network
failures; desktop/mobile screenshots; tested destructive records; and audit-log
IDs. Any unexpected success by a lower role, missing audit event, service key in
a response/bundle, or schema fallback is a release blocker.
