# First-run installation

## Deployment and bootstrap

1. Create a new Supabase project. Record its project reference and confirm it is
   not the production S-Chassis project.
2. Set deployment secrets. `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_DB_URL`, and
   `INSTALL_TOKEN` are server-only; never use a `NEXT_PUBLIC_` prefix for them.

   ```bash
   export NEXT_PUBLIC_SUPABASE_URL=https://PROJECT.supabase.co
   export NEXT_PUBLIC_SUPABASE_ANON_KEY=...
   export SUPABASE_SERVICE_ROLE_KEY=...
   export SUPABASE_DB_URL='postgresql://postgres:...@db.PROJECT.supabase.co:5432/postgres'
   export INSTALL_TOKEN="$(openssl rand -base64 32)"
   ```

3. From a trusted workstation, apply the minimal bootstrap. The web application
   never receives or uses the database URL.

   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 \
     -f supabase/installer/00000000000000_installer_core.sql \
     -f supabase/installer/00000000000001_security_bootstrap.sql \
     -f supabase/installer/00000000000002_application_baseline.sql
   ```

4. Garage is already included in the application baseline. The standalone
   module file remains available for repairing an older partial installation:

   ```bash
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f supabase/installer/modules/garage.sql
   ```

5. Deploy/start the Next.js application and visit `/install`. Unlock with
   `INSTALL_TOKEN`, complete the checks and wizard, review selected/skipped
   modules, and finalize. The token is submitted once over HTTPS and exchanged
   for a 30-minute HttpOnly, Secure, SameSite=Strict session; it is never returned,
   persisted in site settings, or sent to Supabase.
6. Sign in with the owner account. Successful finalization stores the owner UUID
   in protected role tables and permanently makes `/install` return 404.

## Recovery and concurrency

Database finalization holds a transaction-scoped PostgreSQL advisory lock and a
row lock on the singleton installation state. A concurrent request cannot claim
a second owner. If Auth creates the user but the database transaction fails,
retry with the same email: the server finds that Auth user and idempotently
finishes its profile/role/configuration. It never creates a second account for
that email. Do not delete the Auth user as a recovery mechanism.

## Selected versus skipped objects

Core plus the required security bootstrap always create `installation_state`, `schema_versions`,
`installed_modules`, `site_settings`, `profiles`, `roles`, `permissions`,
`role_permissions`, `user_roles`, `user_permissions`, the `avatars` bucket, and
`complete_first_install`, along with `site_security_settings`, `ip_bans`,
`user_bans`, and `get_ip_ban_detail`. Garage adds `garage_cars`, `garage_car_likes`, and the
`garage-covers` bucket. The application baseline adds Shops plus the Forum,
Knowledge Base, Messaging, Notifications, Moderation, audit, and staff to-do
schemas used by the current code.

Skipped modules have no `installed_modules` row. Middleware returns 404 before
their page/API code runs, preventing database calls. Disabling a module changes
only its registry state and never drops tables, buckets, functions, or data.
Destructive uninstall is intentionally not implemented.

## Rollback

There is no automated production rollback because deleting installer/core
objects can destroy identity and authorization data. Before completion on a
disposable database, discard the project to roll back. After completion, restore
a database backup or write an explicitly reviewed forward migration. Optional
module files are additive; disabling a module is the safe operational rollback.
The existing timestamped S-Chassis migrations remain unmodified.

## Verification status and exact blockers

Static verification covers payload validation, dependency resolution, lock/resume
semantics, additive SQL, advisory/row locking, RLS enablement, least-public RPC
grants, TypeScript, lint, tests, and production compilation.

An end-to-end fresh installation, owner login, catalog/RLS probes, email delivery,
and screenshots of post-unlock steps specifically require either:

- `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
  `SUPABASE_SERVICE_ROLE_KEY`, and `SUPABASE_DB_URL` for a disposable project,
  together with its project reference and the production project reference to
  enforce a denylist; or
- Docker plus the Supabase CLI for a local stack (neither executable exists in
  the supplied environment).

The application baseline now contains the blank-project schemas used by Forum,
Knowledge Base, Messaging, Notifications, Moderation, Shops, Garage, audit, and
staff tools. The schema-coverage test fails when application code names a table
or RPC that no installer SQL defines.
