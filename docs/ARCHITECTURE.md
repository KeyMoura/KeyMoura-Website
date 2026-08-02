# Architecture

## Runtime shape

The KeyMoura website is a Next.js 16 App Router monolith. React client pages and server-rendered pages live under `src/app`; 96 route handlers form the application service layer. Supabase supplies Auth, PostgreSQL, RPCs, and object storage. Vercel hosts the Next.js runtime and Speed Insights integration.

The root layout composes global authentication-adjacent UI (lockdown gate, block provider, last-seen updater), navigation, command palette, broadcasts, and footer. `middleware.ts` refreshes Supabase sessions and performs security checks. Browser access uses `src/lib/supabaseClient.ts`; privileged server access is split across `supabaseAdmin.ts`, `supabaseServer.ts`, `adminForumGuard.ts`, and the preferred `lib/api/routeAuth.ts` helpers.

## Functional areas

- **Forum/community:** categories, threads, posts, voting, flags, blocking, accepted answers, moderation.
- **Projects:** published project pages, draft review, update proposals, PDF generation, search analytics.
- **Identity/community:** profiles, roles, permissions, restrictions, bans, notifications, direct messages.
- **Moderation/security:** reports, recycle bin, audit log, security settings, login events, lockdown, staff role administration.
- **Optional modules:** Garage and trusted shops.

## Data flow and trust boundaries

Client components use the anon-key browser client and therefore depend on RLS. Mutations increasingly pass through route handlers. A server route must authenticate the JWT/cookie and authorize a permission before using the service-role client. The service key must never be imported into a client component or emitted through a `NEXT_PUBLIC_` variable.

The current repository contains only three incremental forward migrations while application code references 39 relations/buckets and 16 RPCs. Consequently, the repository is not yet a reproducible representation of production. See `INVENTORY.md` for the complete static inventory and `AUDIT.md` for remediation priorities.

## Target modular boundary

The generalization should retain one deployable application while extracting configuration and domain seams: `config` (site identity/features/theme), `forum`, `knowledge-base`, `moderation`, `reports`, `users`, `permissions`, `notifications`, `messaging`, `audit`, and `security`. Garage and trusted vendors remain optional instance features. Database evolution must be additive migrations with RLS and rollback notes before application code assumes a new schema.
