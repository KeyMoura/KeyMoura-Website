# Repository-wide consistency audit

**Audit date:** 2026-07-29  
**Scope:** Static review of all 84 TSX modules, 96 API handlers, shared styles and components, route conventions, dependencies, tests, configuration, and tracked database migrations. Runtime role and browser checks are limited by the absence of configured Supabase credentials and seeded role accounts.

## Confirmed defects

- Global CSS removes every focus outline and focus shadow, including `:focus-visible`. Keyboard users therefore receive no reliable focus indicator on links, buttons, and custom controls.
- `/debug-user` is a production-reachable debugging page that renders the current user and complete client session as JSON. It is not a user feature and unnecessarily exposes authentication details on screen.
- Legal-page metadata and copy, the knowledge-base heading, lockdown copy, notification fallback, and header logo alt text bypass deployment configuration.
- Two access-denied components implement the same state with different punctuation, layout, actions, and terminology.
- React Query developer tools are included in the production provider rather than being restricted to development builds.
- The root document has no skip link or addressable main-content target.

## Inconsistency / polish issues

- Forms commonly repeat long Tailwind strings instead of using the existing `ui-input` primitive. Migration should be incremental because some compact and destructive inputs are intentionally different.
- Cards use both `ui-card` and one-off combinations of zinc borders, black backgrounds, and several radii. Dense staff tables legitimately need more compact surfaces.
- Pages mix `page-container`, `page-container-wide`, and local `max-w-*` shells. Feature work should use the shared shells unless a dense workspace needs additional width.
- Some source comments describe UI as copied “exactly” from another route. Shared behavior should be documented by intent rather than implementation history.
- Button labels mix “Back”, “Back to Staff”, and context-specific destinations. Context-specific labels are preferable, while permission states should share one default.

## Verified dead code

- `@supabase/auth-helpers-nextjs` has no source, test, script, or configuration import. Supabase access uses `@supabase/ssr` and `@supabase/supabase-js`; the deprecated helper package can be removed safely.
- `/debug-user` is standalone, has no inbound application link, performs no application workflow, and explicitly exists to print auth debugging state. Removing it does not remove an API or database capability.

## Possible dead code requiring caution

- `/dev/menuselect` is a component-development harness. It is intentionally guarded with `notFound()` in production; retain it unless component demos move to a dedicated tool.
- Legacy `/api/admin/*` endpoints overlap newer permission-oriented `/api/staff/*` handlers. They may have deployed clients or bookmarks and must not be removed without request telemetry and a deprecation window.
- Default framework assets (`next.svg`, `vercel.svg`, `globe.svg`, `window.svg`, and `file.svg`) have no static references, but hosting metadata or downstream template consumers may rely on them. Leave them for a later asset-manifest review.
- Database compatibility fallbacks and schema-error branches may support installations at different migration levels. Do not remove them until the schema is reproducible and deployment versions are known.

## Intentional behavior

- S-Chassis-specific identity and vehicle examples remain appropriate for the configured instance. Reusable identity, navigation labels, and generic product copy should come from `siteConfig`; domain-specific editorial/legal wording may remain instance content.
- Staff navigation and data tables use denser sizing than public cards to preserve information hierarchy and operational efficiency.
- Destructive actions use red styling rather than the primary brand treatment.
- The MenuSelect development route is available only outside production.

## Architectural improvements

- Make the existing CSS primitives keyboard-accessible and add reduced-motion behavior before expanding their use.
- Consolidate permission-denied presentation behind one component while retaining a compatibility export during migration.
- Treat `siteConfig` as the source for identity and shared terminology; retain content-specific S-Chassis examples where they explain the configured archive.
- Keep authorization consolidation separate from visual cleanup. Overlapping admin/staff APIs need telemetry, migration notes, and focused integration tests before removal.
- Add static regression tests for template identity usage and production route hygiene, alongside existing permission tests.

## Review boundaries and follow-up

Static review can verify route presence, component patterns, imports, package usage, and obvious accessibility failures. It cannot prove Supabase-backed loading, empty, error, or permission states for every role without a representative seeded environment. Before merging or deploying, manually exercise logged-out, member, moderator/support, and administrator accounts at 320 px, 768 px, and desktop widths, plus 200% browser zoom. See `docs/MANUAL_CHECKS.md` for the focused checklist added by this pass.
