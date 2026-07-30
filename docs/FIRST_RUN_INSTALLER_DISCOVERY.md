# First-run installer: discovery, classification, and proposed design

**Date:** 2026-07-29  
**Branch:** `codex/first-run-installer`  
**Phase:** discovery only — implementation is intentionally stopped at the requested approval gate

## Scope and evidence limits

This inventory is a repository-static inventory of every database object the
application names and every object defined by the three tracked migrations. It
did **not** connect to or modify production Supabase. No database URL, schema
dump, CLI project link, or disposable staging credentials are present in the
repository. Therefore the repository cannot establish whether an application
relation is a table or view, discover objects unused by the application, or
enumerate production-only triggers, policies, grants, buckets, and cron jobs.

Before schema implementation, export a **schema-only** dump from production (or
a sanitized clone) covering `public`, `auth`, `storage`, `extensions`, and
`cron`, including grants, RLS policies, functions, triggers, extension state,
bucket rows, and required reference data. Compare it with this inventory. That
is a hard gate: no existing schema will be deleted or restructured without that
artifact and explicit approval of this classification.

## Classification rules

- **Required core:** installation state, site settings, identity/profile,
  authorization, and authentication/security controls needed by every site.
- **Optional module:** installed only when selected; disabling it later only
  prevents application access and never drops its data.
- **Shared dependency:** assigned to the lowest layer that safely owns it; for
  example, audit is core even though optional modules emit audit records.
- **Uncertain:** the repository does not contain enough DDL or usage evidence to
  make destructive decisions.

## Relations referenced by the application

The object kind is recorded as `relation` because PostgREST `.from()` does not
distinguish a table from a view and the base DDL is missing.

| Classification | Relations | Decision / dependency |
|---|---|---|
| Required core | `profiles`, `roles`, `permissions`, `role_permissions`, `user_permissions`, `user_roles` | Identity and server-authoritative RBAC. `user_roles`/`user_permissions`, never editable auth metadata, determine access. Exact overlap between the legacy `user_roles.role` model and normalized role tables must be reconciled from the schema dump. |
| Audit / Security | `audit_logs`, `auth_login_events`, `ip_bans`, `site_security_settings`, `user_bans`, `user_blocks`, `user_restrictions`, `site_verified_perks` | Core security boundary. `user_blocks` is also consumed by forum/messaging behavior, but belongs in core so either module can depend on it. Donation/verified-perk coupling is S-Chassis-flavored and must become optional configuration or be retained as compatibility data. |
| Forum | `forum_categories`, `forum_flags`, `forum_moderators`, `forum_post_votes`, `forum_posts`, `forum_thread_lead_scores`, `forum_threads` | Optional `forum`; depends on core, notifications (optional integration), moderation, and audit. Lead scores and accepted-answer karma may be better extracted into a `forum_qa` capability after DDL review. |
| Knowledge Base / Info | `info_page_contributors`, `info_page_drafts`, `info_page_review_events`, `info_page_updates`, `info_pages`, `info_search_click_events`, `info_search_events` | Optional `knowledge_base`; depends on core and audit. Review workflow depends on moderation/RBAC. Search event tables are optional analytics and should not be required for page reads. |
| Garage | `garage_car_likes`, `garage_cars` | Optional `garage`; depends on core and the `garage-covers` bucket. `car` terminology and S-Chassis fields must be moved to module configuration without rewriting compatibility rows. |
| Shops / Vendors | `shops` | Optional `vendors`; depends on core. Current “trusted vendors” terminology should be configurable. |
| Messaging | `dm_messages`, `dm_thread_members` | Optional `messaging`; a DM thread relation is strongly implied by RPCs but absent from static `.from()` calls and must be discovered from the schema dump. Depends on core, audit, and moderation; notifications are an optional integration. |
| Notifications | `notifications` | Optional `notifications`; depends on core. Forum, messaging, moderation, and security may publish to it only when installed. |
| Moderation / Reports | `reports`, `report_messages`, `moderation_recycle_bin` | Optional `moderation`; depends on core and audit. Target constraints may depend on forum and messaging. Recycle-bin payloads intentionally preserve data and need explicit retention configuration. |
| Obsolete or uncertain | `avatars` | The name appears in static relation extraction, but the code also uses an `avatars` storage bucket. Confirm whether a same-named relation really exists before classifying or removing it. |

No referenced relation can be called redundant solely from this evidence.

## Functions / RPCs

| Classification | Functions | Notes |
|---|---|---|
| Audit / Security | `check_lockdown_password`, `get_ip_ban_detail`, `get_site_lockdown_flags`, `touch_last_seen` | Core. `touch_last_seen` is the only one whose complete DDL is tracked. Lockdown/password implementation must be inspected for hashing, grants, and `search_path`. |
| Forum | `award_accepted_answer_karma`, `contains_profanity`, `increment_thread_view`, `revoke_accepted_answer_karma` | `contains_profanity` may ultimately be a shared core/moderation service. Karma naming and lead scoring are candidates for a `forum_qa` sub-capability. |
| Knowledge Base / Info | `search_info_pages` | Optional knowledge-base search. |
| Messaging | `dm_get_or_create_thread`, `dm_get_thread`, `dm_leave_thread`, `dm_list_threads`, `dm_mark_all_read`, `dm_mark_thread_read`, `dm_send_message`, `dm_unread_thread_count` | Optional messaging API. Full DDL, ownership, grants, and RLS interactions are missing. |
| Moderation / Reports | `purge_expired_moderation_recycle_bin` | Tracked security-definer function; service-role-only execute grant. |

All untracked RPC definitions remain **uncertain** until schema export. Each
security-definer function must pin a safe `search_path`, revoke default public
execute, validate `auth.uid()` or an explicit trusted server boundary, and have
negative authorization tests.

## Triggers, policies, buckets, cron, and extensions

| Kind | Observed inventory | Classification and status |
|---|---|---|
| Triggers | None defined or named in tracked files. Auth/profile and updated-time triggers may exist remotely. | **Uncertain; schema dump required.** |
| RLS policies | No named policy is tracked. `moderation_recycle_bin` enables RLS and deliberately defines no anon/authenticated policy. | All other policies are **uncertain** and block a reproducible blank install. |
| Grants | `purge_expired_moderation_recycle_bin`: execute revoked from `public`, `anon`, `authenticated`, granted to `service_role`; `touch_last_seen`: revoked from `public`, `anon`, granted to `authenticated`. | Every other relation/function grant is **uncertain**. |
| Storage buckets | `avatars` (core), `garage-covers` (Garage). Both are expected to provide public URLs. | Bucket creation, size/MIME restrictions, and `storage.objects` policies are missing. Public read plus owner/admin-controlled writes is the proposed baseline. |
| Cron jobs | `purge-expired-moderation-recycle-bin`, daily at `03:17`, conditionally installed when `pg_cron` exists. | Moderation. Existing migration has an explicit rollback that unschedules it. Remote-only jobs remain uncertain. |
| Extensions | `pg_cron` is optional; `gen_random_uuid()` requires platform-provided UUID support. | Record extension availability during system checks; do not silently require optional cron. |

## Application dependencies

| Dependency | Purpose | Installer implication |
|---|---|---|
| Next.js 16 / React 19 | App Router UI, middleware, and server handlers | The installer is a server-rendered `/install` route with server-only mutations; no header redesign. |
| `@supabase/ssr`, `@supabase/supabase-js` | Browser auth plus server/service access | URL and anon key may reach the browser; service key and database URL must never do so. Existing scattered privileged clients should converge on one server-only boundary. |
| Supabase Auth | Accounts and sessions | Installer creates the first auth user server-side, then atomically claims ownership in database state. Authorization never reads user-editable metadata. |
| PostgreSQL/PostgREST RPC | Persistence and privileged operations | Versioned core/module migrations and a locked bootstrap RPC are required. |
| Supabase Storage | Avatars and garage covers | Core and selected-module bucket checks/migrations must run separately. |
| Email provider through Supabase Auth | Verification, recovery, invitations | Perform configuration/dry-run checks without treating delivery as transactional database work. |
| TanStack Query, Zod, PDF.js, React Markdown, Recharts, Lucide, Speed Insights | Existing UI/data validation, documents, analytics, icons, deployment telemetry | Zod can validate installer input; none should become a database-module prerequisite. PDF.js is knowledge-base-only at runtime. |

Environment currently requires `NEXT_PUBLIC_SUPABASE_URL`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY`, and server-only
`SUPABASE_SERVICE_ROLE_KEY`; `NEXT_PUBLIC_SITE_URL` is optional. Add a
server-only `INSTALL_TOKEN`. A direct database URL should be an optional
deployment/migration-runner secret only and must never be serialized into a
client component, response, log, or `NEXT_PUBLIC_*` variable.

## Module dependency map

```text
core
├── audit_security (installed with core)
├── notifications (optional)
├── moderation (optional; requires audit_security)
├── forum (optional; requires audit_security + moderation)
│   └── notifications (optional integration)
├── knowledge_base (optional; requires audit_security)
│   ├── moderation (required only for review workflow)
│   └── info_analytics (optional capability)
├── garage (optional; requires garage-covers storage)
├── vendors (optional)
└── messaging (optional; requires audit_security + moderation)
    └── notifications (optional integration)
```

The wizard will explain and auto-select hard dependencies, while showing soft
integrations separately. In particular, it must not install notification tables
just because forum or messaging is selected. Route and API guards will consult
the installed-module registry, so skipped modules are absent at both schema and
application boundaries rather than merely hidden from navigation.

## Redundant, abandoned, and S-Chassis-specific candidates

These are review candidates, **not deletion approvals**:

1. Legacy `/api/admin/*` and newer `/api/staff/*` handlers overlap for bans,
   restrictions, moderation deletion, reports, and security. Consolidate only
   after callers and audit behavior are compared.
2. `user_roles.role` appears to overlap normalized `roles`, `role_permissions`,
   and `user_permissions`. Preserve the legacy adapter for the S-Chassis
   installation until data is migrated and parity is proven.
3. `forum_thread_lead_scores`, accepted-answer karma RPCs, donation rank, and
   `site_verified_perks` look instance/community-specific rather than minimal
   core. Treat them as compatibility capabilities pending schema/data review.
4. `garage_cars`, `garage-covers`, S-Chassis branding/assets, “car,” “garage,”
   and “trusted vendor” terminology are configured S-Chassis instance choices,
   not generalized core concepts.
5. `avatars` is ambiguous between a storage bucket and possible relation.
6. The production-guarded `/dev/menuselect`, framework sample SVGs, and partial-
   schema compatibility fallbacks may be abandoned but are outside database
   restructuring and should remain untouched in this phase.
7. The implied DM thread backing object is missing from static relation usage;
   it is not obsolete and must be recovered from remote DDL.

## Proposed installer architecture

### Trust boundary and lifecycle

1. Middleware asks a server-only installation-state service whether core is
   installed. Before installation, normal application routes redirect to
   `/install`; static assets, health checks, auth callback necessities, and
   installer endpoints remain narrowly allowed.
2. `/install` requires a constant-time match against server-only
   `INSTALL_TOKEN`, exchanged for a short-lived, HttpOnly, `Secure`, `SameSite`
   signed installer session. The token never enters client state or persistence.
3. Connection checks run only on the server with the service key. Responses
   expose capability/status codes, never credentials or raw database errors.
4. Wizard drafts are stored server-side in a core bootstrap table keyed by a
   random HttpOnly session identifier. Secrets are never stored in the draft.
5. The final action calls one locked bootstrap operation. A PostgreSQL advisory
   transaction lock plus a singleton installation row prevents races. It checks
   `completed_at is null`, records an attempt, applies ordered migrations, creates
   the auth user, writes the immutable owner role by auth user UUID, verifies
   invariants, and completes the singleton. Failed attempts retain sanitized
   progress and can resume idempotently.
6. Because Supabase Auth administration is not in the same PostgreSQL
   transaction as application writes, recovery explicitly handles an auth user
   created before a database failure: resume by verified email/user UUID and
   never create a second owner. Database migration steps are transactional;
   non-transactional storage/email checks are retryable state-machine steps.
7. Completion irreversibly sets `completed_at`, hashes/invalidates the install
   token verifier, removes draft state, and makes `/install` and installer APIs
   return 404 (or a safe home redirect with no state disclosure).

### Wizard steps

1. Welcome and INSTALL_TOKEN unlock.
2. System/environment checks: supported Node runtime, HTTPS/canonical URL,
   required variables, token strength, server-only secret placement, clock, and
   migration runner capabilities.
3. Supabase verification: project URL identity, Auth/API reachability, empty vs
   already-managed database, required extensions, and no production allowlist
   match for tests.
4. Site identity: name, description, canonical URL, logo upload, brand colors,
   and configurable terms (community/forum, knowledge base, garage/showcase,
   shops/vendors). Validate URLs, MIME, size, contrast, and CSS-safe colors.
5. Modules: selected/skipped objects, hard dependencies, soft integrations, and
   storage requirements displayed before confirmation.
6. Authentication: allowed signup methods, email confirmation, redirect URLs,
   password policy guidance, and provider readiness. Never accept provider
   secrets into browser-rendered fields.
7. First owner: email, password, username/display name; create through server-
   only Auth Admin and assign immutable DB authorization.
8. Storage and email checks: bucket capability/policies and a clearly labeled
   test-email result, both safely retryable.
9. Final review: redacted environment summary, site configuration, modules,
   exact schema plan, owner email, and warnings.
10. Progress/result: persisted per-step states (`pending`, `running`, `applied`,
    `failed`, `verified`), sanitized errors with correlation IDs, resume action,
    final verification, and one-way installer lock.

## Migration organization

```text
supabase/
  migrations/
    core/                 # immutable ordered baseline and upgrades
    modules/forum/
    modules/knowledge_base/
    modules/garage/
    modules/vendors/
    modules/messaging/
    modules/notifications/
    modules/moderation/
    compatibility/schassis/ # additive adapter/data migrations only
  rollback/               # development/emergency rollback notes, never automatic data loss
  tests/                   # pgTAP/catalog/RLS/grant/fresh-install assertions
  seeds/                   # non-secret reference data; no owner credentials
```

Core introduces `installation`, `installation_attempts`, `installed_modules`,
`schema_migrations`, `site_settings`, identity/RBAC, audit/security, and avatar
storage. Migration identity is `(module_key, version, checksum)`; a changed
checksum is fatal. Each module manifest declares required modules, migrations,
buckets, verification queries, and compatible app schema range.

The runner applies each SQL migration once under an advisory lock and transaction
where PostgreSQL permits it. Storage/Auth/email steps have idempotency keys and
postcondition checks. Enabling a module runs pending migrations; disabling marks
it inactive and blocks its routes but retains all objects/data. Destructive
uninstallation is a separate administrator operation requiring typed confirmation,
a backup/export, dependency checks, a dry run, and dedicated uninstall scripts.
It is never part of first-run setup or ordinary disablement.

The three existing migrations remain immutable. After reconstructing a complete
baseline, fresh installs receive equivalent module-versioned definitions while
existing S-Chassis deployments record/adopt matching versions through a
non-destructive compatibility migration.

## Required verification plan

Run only against a named disposable empty Supabase project protected by a project
reference allowlist/denylist that excludes production:

1. Install core only; assert every optional relation/function/bucket is absent.
2. Install each supported module combination and assert exact selected/skipped
   catalog objects and dependencies.
3. Interrupt after every state-machine step, rerun, and prove checksums/data are
   stable and only one owner exists.
4. Race two finalization requests; exactly one succeeds and the other receives a
   non-sensitive locked response.
5. Test anon, authenticated owner, unrelated user, moderator, and service role
   against every exposed table/view/RPC and storage operation. Assert RLS is
   enabled, grants are least privilege, and security-definer functions are safe.
6. Inspect browser bundles, HTML, logs, and network responses for service keys,
   database URLs, install tokens, passwords, and raw errors.
7. Verify `/install` and all installer mutations are inaccessible after success.
8. Disable/re-enable modules and prove data remains; rehearse destructive
   uninstall only on a backed-up disposable project.
9. Upgrade the S-Chassis-compatible seeded installation and compare row counts,
   ownership, constraints, routes, and behavior before/after.
10. Capture desktop/mobile screenshots for every wizard step and error/recovery
    state after the runnable implementation exists.

Fresh-install results, screenshots, selected/skipped catalog lists, and live RLS
evidence cannot honestly be produced in this discovery phase because neither the
installer nor a disposable project exists yet.

## Approval gate and unresolved inputs

Implementation is intentionally stopped here. Approval should confirm:

- the classifications and hard/soft dependency choices above;
- whether moderation is a hard dependency of forum and messaging or a core-lite
  subset should be extracted;
- whether knowledge-base review is mandatory or optional;
- the fate of donation/verified perks, lead scoring/karma, and normalized versus
  legacy role storage;
- the sanitized schema-only export and storage/cron inventory;
- disposable staging project credentials/reference and an explicit production
  project denylist value;
- email/provider requirements and supported deployment target.

Until those are supplied, all production schema and data remain untouched and
no deletion, restructuring, installer runtime, or speculative baseline DDL will
be introduced.
