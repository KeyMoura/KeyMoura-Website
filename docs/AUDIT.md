# Baseline stability and security audit

**Audit date:** 2026-07-29  
**Scope:** repository-static audit; no production or staging Supabase credentials/schema were available.

## Baseline checks

| Check | Result | Notes |
|---|---|---|
| `npm ci` | Pass | Locked dependencies installed and the PDF worker postinstall completed. |
| `npm run lint` | Fail | 245 errors and 1,685 warnings. Dominant categories include explicit `any`, unescaped JSX, hook dependency issues, and unused code. |
| `npx tsc --noEmit` | Pass | Current TypeScript configuration accepts the baseline. |
| `npm run build` | Pass with configured placeholders | The build completes when all three documented Supabase variables are present; without them, route-data collection correctly fails fast. |

## Critical findings

1. **The database is not reproducible (critical).** Application code references 39 `.from()` targets and 16 RPCs, but only three incremental forward migrations are tracked. RLS, the baseline schema, most functions, storage configuration, scheduled cleanup, and seed data cannot be reviewed or recreated from source.
2. **Service-role authorization is fragmented (high).** Several routes instantiate their own anon/service clients or query `user_roles` inline instead of using `routeAuth`. This expands the chance of an authentication or permission mismatch. The service key is server-only in observed code, but every bypass depends on route-local correctness.
3. **Escalation fails open (high).** Report escalation logs and returns success when the schema update fails (including a missing column), while still notifying administrators. UI, audit, and stored report state can disagree. De-escalation fails closed, making the pair asymmetric. Both endpoints use hard-coded role membership rather than permission keys.
4. **Recycle-bin durability is best effort (high).** Moderation deletion proceeds when backup storage is missing or errors. This can create unrecoverable deletes while the UI suggests recoverability. No migration creates `moderation_recycle_bin`, and no scheduled cleanup is present.
5. **Restore is not transactional (high).** Content is restored before the recycle record is deleted. A cleanup failure leaves a stale restorable entry. Restoration also reconstructs only soft-delete flags rather than the recorded payload, and no compare/update guard detects conflicting permanent changes.
6. **Schema drift is deliberately masked (high).** Multiple handlers continue when expected columns/tables are absent. This hides deployment mismatch and makes runtime behavior installation-dependent.

## Known-area verification

- **`/reports/[id]`:** a very large client page combines reporter/staff views, messaging, status changes, escalation, notes, and role-sensitive UI. The corresponding API does enforce membership/staff visibility, but the distributed logic is difficult to prove consistent.
- **`/staff/moderation/reports`:** uses additional resolution endpoints and service-role-backed target resolution. Report actions are duplicated across admin and staff namespaces.
- **`/staff/security/recycle-bin`:** the restore endpoint requires `recycle_bin.restore`; support safety therefore depends on role-permission seed data that is absent from source. The endpoint itself does not hard-code support access.
- **Escalation/de-escalation:** verified asymmetrical error behavior and the misspelled public route/event name `descalate`, which should be preserved temporarily via compatibility routing when corrected.
- **Deleted-by attribution:** recycle records accept the acting user ID, but this cannot be end-to-end verified without the missing table migration and production schema. Soft-deleted source records are not consistently updated with deletion attribution.
- **Admin/staff information updates:** parallel admin and staff handlers contain overlapping workflow logic and can drift.
- **Community soft-delete data:** threads/posts rely on `is_deleted`; backups are optional and source schema is absent.
- **Browser client:** a singleton anon-key client is used across many large client pages. This is acceptable only with comprehensive RLS, which is not present for audit.
- **Staff roles/permissions:** both role-name checks and permission checks exist. Support/moderator/admin behavior is therefore not centrally guaranteed.
- **Command palette:** category and thread search logic is embedded in a large component. Result ordering/omission needs focused tests before refactoring.
- **Header/navigation overlap (fixed during stabilization):** the desktop navigation was absolutely centered independently of the right-side utilities. Authentication, staff controls, narrower viewports, and browser zoom could therefore make the two groups occupy the same horizontal space. The header now uses one in-flow flex layout, switches to the collapsible menu below the desktop width, and progressively reduces search/account/staff labels. Browser geometry and screenshot coverage exercises common desktop widths and zoom equivalents while retaining the Ctrl+K palette shortcut.
- **Permanent cleanup:** no Vercel cron configuration, scheduled function, or migration-driven `pg_cron` job was found.

## Duplication and maintainability

- Admin and staff moderation delete routes are parallel implementations for posts, threads, and messages.
- Reports have admin list/update/bulk routes plus staff list/update/escalation routes.
- Supabase privileged-client creation exists in multiple libraries and individual endpoints.
- Role resolution is repeated across middleware, routes, providers, pages, and staff UI.
- Several pages exceed 1,000 lines; the forum thread page exceeds 4,000 lines. UI, data access, and permissions are tightly coupled.

## Phased remediation plan

1. Make builds deterministic, introduce a checked-in environment contract, add test tooling, and reduce lint errors without disabling rules.
2. Add a central site configuration and theme/feature tokens while preserving S-Chassis defaults.
3. Centralize server authentication and permission policies; add unit tests proving support cannot restore and escalation is restricted.
4. Add additive Supabase baseline migrations for recycle bin/report escalation and scheduled cleanup, with explicit rollback notes and staging verification.
5. Consolidate report and moderation services behind shared domain functions and transactional RPCs.
6. Extract reusable domain modules and migrate branding/navigation to configuration.
7. Reconstruct remaining schema/RLS/RPC/storage migrations from a sanitized production schema dump, seed a local/staging instance, and run integration tests.

## Blockers and limitations

A complete RLS audit, exact schema consistency check, destructive cleanup test, and data migration rehearsal require a sanitized production schema dump or credentials for a disposable Supabase staging project. No destructive database action should occur until that is available.
