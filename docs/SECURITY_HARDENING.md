# Security, RLS, and permissions hardening review

Review baseline: `99af8268c3dc33b54a4b8b82a6caa36a472968cf` (2026-08-11). This is a static and local adversarial review; no production data, Supabase project, Stripe account, email provider, or live identity was accessed.

## Authorization model

The browser uses the anon key and Supabase user session. Customer data is constrained by identity-scoped RLS. Privileged routes authenticate the caller, resolve effective permissions server-side, and only then use the server-only service client. Object IDs are selectors, never credentials. `is_op` is the owner exception; ordinary hierarchy comparisons use `roles.rank`.

| Resource | Read actor | Write actor | Server path | RLS / grant boundary | Application permission |
|---|---|---|---|---|---|
| Own profile/account | owner; staff where operationally required | owner allowlisted fields; authorized staff | `/api/account/*`, `/api/staff/users/*` | proposed own-or-staff profile policy | `users.view`, `users.profile.edit` |
| Authenticated orders/items | owning customer; order staff | customer-specific actions; authorized staff | `/api/orders/*`, `/api/staff/orders/*` | `customer_id = auth.uid()` participant policies; service route rechecks | `orders.view/manage`, lifecycle-specific permissions |
| Guest order | verified guest session; authorized staff | verified guest limited actions; staff | `/api/orders/guest/[id]/*` | access-code table service-role only | verification session or staff permission |
| Cart/checkout/custom request | owner/guest token holder | owner/guest; price computed server-side | `/api/cart/*`, `/api/orders/custom` | owner/token policies and server validation | ownership |
| Support conversation/messages | owning customer (public messages only); support staff | owner; reply/manage/assign staff | `/api/support/*`, `/api/staff/support/*` | identity policies; internal notes separate | `support.view/reply/manage/assign` |
| Internal user/support notes | authorized staff only | authorized staff only | `/api/staff/users/*/notes`, `/api/staff/support/*/notes` | no customer grant/policy | `users.notes.view/manage`, `support.view/manage` |
| Production/files | production staff | production staff | `/api/staff/production/*` | service-only route access; private order assets | `production.view/manage` |
| Fulfillment/inventory | fulfillment/inventory staff | separately authorized staff | `/api/staff/orders/*/fulfillment`, `/api/staff/inventory/*` | service route after permission | `fulfillment.*`, `inventory.*` |
| Catalog/categories/media | public published rows; catalog staff | catalog staff | `/api/staff/catalog/*` | published SELECT; staff writes via server | catalog-specific manage permission |
| Users/status | user-management staff | hierarchy-limited staff | `/api/staff/users/*`, `/api/staff/security/users/*` | service route after permission | `users.*`, moderation-specific permission |
| Roles/assignments | authorized staff; public cosmetic badge projection | hierarchy-limited staff | `/api/staff/security/roles/*` | proposed removal of browser table SELECT | `roles.manage/assign` |
| Permission definitions/overrides | security staff | strictly lower target; actor-held known keys only | `/api/staff/security/*/permissions` | proposed removal of browser table SELECT | `permissions.grant`, `roles.manage` |
| Audit log | audit staff | append-only trusted server/trigger | `/api/staff/audit/*` | RLS + append-only trigger; no customer access | `audit.view/read` |
| Email deliveries/templates | communications staff | manage/resend separately | `/api/staff/emails/*` | service route only | `emails.view/manage/resend` |
| Analytics | analytics staff | n/a | `/api/staff/analytics/*` | server aggregate queries | `analytics.view` |
| Automation/jobs | automation staff; authenticated cron | manage staff/controlled worker | `/api/staff/automation/*`, `/api/cron/automation` | service route after permission/cron secret | `automation.view/manage` |
| Appearance/commerce/security settings | relevant staff | separately authorized staff | `/api/staff/{appearance,commerce,security}/*` | service route only | domain-specific manage permission |
| Payments/refunds/returns | order owner sees customer projection; finance staff | signed webhook or lifecycle-authorized staff | checkout, Stripe webhook, staff order routes | service route; webhook event ledger | `refunds.issue`, `returns.review` |

## Findings and changes

### Privilege escalation and permission overrides

The prior role editor accepted client-supplied rank and staff status after checking only `roles.manage`. The role-permission and direct-override routes accepted arbitrary keys and allowed a manager to grant permissions they did not possess, including to themselves or stronger actors. The shared pure hierarchy rules now refuse self-edit, equal/higher targets, roles at/above actor rank, unknown keys, and grants outside the actor's effective set. Owner (`is_op`) remains the deliberate hierarchy exception, but known-key validation remains. Existing last-administrator and two-admin approval protections remain in place. Adversarial unit tests exercise limited staff, stronger target, self, unknown permission, dangerous permission, and owner cases.

### Customer and guest isolation

Authenticated order/support routes use authenticated identity and participant checks; staff routes do not treat UUID knowledge as authorization. Guest order access requires an HMAC-backed, expiring, HttpOnly session cookie; challenges store digests, are consumed atomically, and retain attempt/cooldown controls. An order UUID or matching email is insufficient. Guest secrets are not placed in URLs. Production cookies are `Secure` and use `SameSite=Lax`.

A schema gap remains pending migration approval: the baseline `profiles readable` policy is `USING (true)` for anon/authenticated, exposing complete profile rows to enumeration. The proposed migration replaces it with own-or-staff access. This can affect community/profile presentation and therefore is intentionally unapplied pending compatibility approval. Public display data should ultimately move to a narrow projection/view rather than reopening the base table.

### RLS and grants

Sensitive commerce, guest verification, support, audit, communications, production, inventory, and automation migrations were reviewed for RLS enablement, policies, and grants. Customer-private policies use `auth.uid()`/participant IDs rather than email ownership. Published catalog/media policies are intentionally public. Staff application access is normally a service-role query after server authorization; browser grants do not substitute for application permissions.

The pending migration removes browser `SELECT` on base `roles` and `permissions`, removes anon profile reads, and revokes residual `service_role TRUNCATE` on security/customer tables. Row-level service maintenance remains possible. Cosmetic role badge data remains a deliberately narrow public API projection without permission membership or descriptions.

### Security-definer functions

Reviewed functions pin `search_path` (`public, pg_temp`, with `extensions` only where required). Guest challenge and inventory/order atomic functions are justified because their backing tables are not browser-writable. Trigger-only option-media validation explicitly revokes API execution. Sensitive RPCs revoke PUBLIC/anon/authenticated execute and grant only service role; intentionally browser-callable admission/activity helpers validate authenticated identity. No dynamic arbitrary SQL entry point was identified. The migration test matrix should be rerun against the deployed catalog before approval to catch schema drift.

### Service role, secrets, and server/client boundary

Service credentials are read only in route/server libraries. Core admin/auth, Stripe, Resend, audit, guest verification, and automation modules carry server-only boundaries or are reachable only from route/server code. No secret uses a `NEXT_PUBLIC_` name, is serialized to client props, or is returned by an API. Operational endpoints return configuration booleans, never values. Searches cover Supabase service role, Stripe secret, Resend key, cron secret, and guest HMAC secret.

### Mass assignment, orders, payment, and webhooks

Sensitive route parsers construct allowlisted records; role/profile/order lifecycle APIs do not spread arbitrary request bodies into database writes. Customer routes cannot set ownership, totals, paid timestamps, audit actors, or internal state. Server-side catalog/discount/shipping calculations are authoritative. Stripe webhook processing requires the signature over the raw body and records event IDs for idempotency. Inventory reservation commit/release and payment accounting use atomic database functions. No live Stripe operation was performed.

### Privacy and rendering

Support customer projections exclude internal notes and staff-only metadata. User APIs select explicit identity/display fields and do not expose auth provider tokens, password material, MFA secrets, refresh tokens, or reset tokens. Audit events use structured change summaries rather than raw email/support/payment bodies. Analytics routes are permission-gated and return UI-focused aggregates rather than raw customer/security rows. React escapes product, customization, support, and note text by default; no unsafe customer-controlled `dangerouslySetInnerHTML` sink was identified.

### CSRF, abuse, redirects, and errors

Cookie mutations use non-GET methods and Supabase cookies' SameSite behavior; guest cookies add HttpOnly and production Secure. Bearer-capable APIs do not rely on UI visibility. Guest verification has expiry, attempt, consume, and cooldown enforcement; checkout/share endpoints retain token/rate controls. Redirect/callback inputs are constrained to local/application-derived destinations. Externally returned errors should remain generic; several legacy routes still return database `.message` and are listed below for follow-up.

### Files, races, and destructive actions

Product media is public by design. Order review/customer assets are private and ownership/staff scoped; sensitive application flows do not expose enumerable bucket listings. Role/override writes now check hierarchy immediately before writing, and role assignment has stale-state protection. Guest consume, payment accounting, webhook deduplication, reservations, and scheduler claims are atomic/idempotent database operations. Refund, cancellation, return, resend, retry, status, role removal, archive, and purge paths require specific server permissions and audit their security-relevant outcomes. No user/order hard delete was added.

## Test matrix

| Threat | Evidence |
|---|---|
| Customer/guest isolation, object enumeration, support/internal-note privacy | Existing guest/support/order behavioral suites plus RLS policy review; live cross-identity verification remains |
| Staff denial, role escalation, permission override | `security-hardening.test.ts`, role/user-management suites |
| Audit/analytics privacy | audit and analytics suites; explicit permission routes and response projections |
| Payment authority, signature/replay | checkout/payment/webhook suites and event-ledger inspection |
| Service/env/client leak | focused source boundary assertions and build bundling |
| Mass assignment/error leakage/open redirect | route parser review and security assertions |
| RLS shape, grants, EXECUTE, search path | SQL static tests plus pending migration |

## Residual risks and deferred hardening

1. **Migration approval required:** profile isolation, browser role/permission grants, and service-role TRUNCATE revocations are written but unapplied. Community profile rendering compatibility must be tested with a narrow public-profile projection before production rollout.
2. Static tests cannot prove the production schema matches migration history. Run read-only catalog queries (`pg_policies`, `information_schema.role_table_grants`, `routine_privileges`, `pg_proc`) in staging before approval.
3. Some legacy API routes return Supabase error messages. Convert these incrementally to stable external errors while retaining server observability.
4. In-memory/process-local rate limits do not coordinate across serverless instances. Guest verification is database-backed; lower-risk public forms may need a shared limiter if abuse appears.
5. Live browser checks require fixture customer A/customer B/guest/limited staff/support/catalog/admin identities. No production penetration testing is authorized.
6. Signed URL lifetime and bucket listing configuration should be confirmed in staging because storage dashboard state is not fully represented by repository SQL.

## Migration approval packet

**Exact objects:** `public.profiles` policy/grants; `public.roles` and `public.permissions` SELECT grants; TRUNCATE privilege on the sensitive tables enumerated in `20260811030000_security_boundary_hardening.sql`.

**Before:** anonymous users can select profile rows; browser roles can select base role/permission definitions; service role retains bulk TRUNCATE on listed tables unless separately revoked.

**After:** profiles are readable only by their owner or canonical staff helper; base role/permission tables are not browser-readable; service role retains row DML but not TRUNCATE.

**Compatibility risk:** public/community profile pages currently query `profiles` directly and will lose other-user display data. Public badge API continues to work through its narrow server projection. Stage a public-profile view/API migration or update community queries before applying.

**Test evidence:** local static and behavioral suites cover policy text and escalation decisions; staging actor-matrix and schema-catalog verification remain mandatory.

# MIGRATION APPROVAL REQUIRED

Do not apply `20260811030000_security_boundary_hardening.sql` until the compatibility risk and staging evidence above are approved.
