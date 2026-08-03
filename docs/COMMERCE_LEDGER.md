# Commerce transformation — implementation ledger

Pass 1: `commerce-catalog-transformation` → PR #5, merged as `706919e`.
Pass 2: `commerce-completion-20260803` → PR #6, merged as `c4b98d1`, in production.
Pass 3: `commerce-launch-readiness-20260803` → **open, unmerged**, based on `a02a400`.

This file is the running record of the catalog and commerce build. It exists so
the work can be picked up mid-flight without re-auditing finished areas.

## Pass 3 — state right now

Branch `commerce-launch-readiness-20260803`, four commits:

| SHA | What |
|-----|------|
| `586f441` | Reconcile the migration ledger with the repository |
| `180b197` | Add wishlists, sharing, and a durable rate limiter |
| `64d01fe` | Add shared carts and discount-code management |
| `ce53e00` | Fix two gaps found in browser verification |

**Not merged. Two migrations written and not applied.** Everything else is
complete, tested, and built.

- 364 tests pass (was 275 at `a02a400`; 89 added).
- Typecheck clean. Production build clean.
- Lint: 350 pre-existing problems in `src`, unchanged — this branch adds none.

### Requires approval before the branch can be finished

1. Apply `20260803010000_wishlist_sharing_and_rate_limits.sql` to production.
2. Apply `20260803020000_shared_cart_ownership.sql` to production.

Both are additive: two nullable columns on `wishlists`, two on `shared_carts`,
one new table (`rate_limit_hits`), two new functions. No column is dropped, no
type changed, no existing row touched. Until they are applied, the wishlist
share-expiry field, the rate limiter, and shared-cart revocation do not work.

## Migration history — repaired 2026-08-03

The ledger had drifted three ways and `supabase db push` would have misbehaved
on all three. **Repaired with approval; production now holds exactly 32 rows,
one per repo file, versions matching filenames.**

What was wrong, and what was done:

| Problem | Count | Fix |
|---------|-------|-----|
| Applied but never recorded (`20260731110000`–`20260801080000`) | 17 | Inserted as applied |
| Recorded under an `apply_migration` timestamp, not the filename version | 6 | Re-keyed in place with `UPDATE` |
| Recorded with no repo file (`complete_order_notifications_schema`) | 1 | File restored from the row's own `statements` |
| Two repo files sharing version `20260801010000` | 1 | `order_final_review` renamed to `20260801015000` |

Before touching anything, every object those migrations create was verified
against the live database: 25 tables, 7 functions, 46 columns, 14 indexes, 6
named constraints, 2 triggers, plus the exact definition of
`orders_status_check`. All present — the schema was never wrong, only the
bookkeeping.

The repair was dry-run first inside a `do $$ … $$` block ending in
`raise exception` to force a rollback: 15 rows before, 32 after, symmetric
difference against the repo file set zero. The applied run carried the same two
assertions as guards. No DDL ran, no migration was replayed, and **no row was
deleted** — the six mis-versioned rows were re-keyed with an `UPDATE`, so
`statements`, `created_by`, `idempotency_key`, and `rollback` all survive.

**The trap to avoid next time:** the MCP `apply_migration` tool stamps a fresh
timestamp as the version instead of using the repo filename. Applying a repo
migration through it silently records it under a version no file has. That is
what caused six of the seven problems above.

## Phase status

| # | Phase | State |
|---|-------|-------|
| 1 | Architecture and schema design | complete |
| 2 | Additive migrations and category backfill | complete — applied and verified |
| 3 | Staff category tools and purchase modes | purchase modes complete; category *management page* still pending |
| 4 | Public catalog redesign | purchase-mode actions complete; category sidebar/routes pending |
| 5 | Canonical cart and pricing | complete |
| 6 | Cart drawer/page | complete |
| 7 | Wishlist and sharing | **complete (pass 3)** |
| 8 | Shared carts | **complete (pass 3)** |
| 9 | Discount engine and staff management | **complete (pass 3)** |
| 10 | Reviews and moderation | schema complete; API and UI pending |
| 11 | Stripe checkout and direct orders | complete |
| 12 | Search, navbar, Appearance integration | navbar complete; search/category integration pending |
| 13 | Migration-history repair | **complete (pass 3)** |

## What pass 3 built

### Wishlists

A wishlist is **not** a cart and deliberately does not inherit its rules. A cart
may only hold what can be bought outright; a wishlist may hold anything
published, including the `request_only` products that are most of this catalog.
No entry is dropped for being unpurchasable — it is kept and annotated, and only
the move-to-cart action is gated. The annotation is computed by the same
`priceLine` the cart uses, so the two cannot disagree.

- `src/lib/commerce/wishlistService.ts` — resolve, add, remove, merge, share.
- `src/lib/commerce/wishlistSession.ts` — ownership, mirroring `cartSession.ts`
  deliberately. A divergence between how carts and wishlists decide ownership is
  how a cross-account leak happens.
- `/api/wishlist`, `/api/wishlist/share`, `/api/wishlist/move-to-cart`,
  `/api/wishlist/shared/[token]`.
- `/wishlist`, `/wishlist/shared/[token]` (noindex).
- `WishlistButton` (icon on cards, labelled on product pages), `WishlistIndicator`
  (navbar, desktop + mobile).

Guest lists merge into the account lazily on the first authenticated request.
The guest row is **deleted** on merge rather than marked abandoned — unlike a
cart there is no status column, and leaving it would strand a live share link
pointing at a list its owner can no longer reach.

### Shared carts

A share link points at an **immutable snapshot**, never the owner's live cart.
The public loader touches `shared_carts` and `products` and never `carts` or
`cart_items`, which makes that structural rather than conventional.

The snapshot records what each line cost when shared. That number is
display-only — the page uses it for "this went up since this was shared" — and
the copy path never reads it. Lines that have since gone request-only,
unpublished, or out of stock are shown and explained rather than dropped.

`shared_carts.created_by` is null for a guest, so `owner_hash` was added: a
salted digest of `user:<id>` or `guest:<token>`. Hashed because a guest token is
a bearer credential for a live cart. Its salt differs from the rate limiter's so
the two tables cannot be joined.

### Discount codes

The engine and checkout redemption shipped in pass 2. Pass 3 adds the staff
surface: full targeting with inclusions and exclusions, windows, minimums, caps,
total and per-customer limits, first-order-only, stacking, and a usage report.
Behind `catalog.discounts.manage`; every change writes an audit event carrying
the code and its terms and no customer data.

Archived, never deleted — `discount_redemptions` references the code and an
order's discount must stay explainable. The usage report totals actual
redemptions rather than reading `total_uses`, which is decremented when an
unpaid order releases a code and so answers "how many are still held".

### Rate limiting

`rate_limit_hits` + `consume_rate_limit`, in Postgres rather than module scope —
on serverless an in-memory limiter's real threshold is the configured one times
however many instances are warm. Check-and-record is atomic under a
transaction-scoped advisory lock keyed on bucket and subject. Only a salted
digest of the identity is stored. It **fails open**: it is not an authorization
control, and a Postgres blip must not log customers out of their own wishlist.

Buckets in use: `wishlist.write`, `wishlist.share`, `wishlist.copy`,
`cart.share`, `cart.share.copy`, `discount.attempt`. Submitting a discount code
is limited because the reply distinguishes "not recognized" from "expired",
which is the oracle a guessing loop wants; clearing a code is not counted.

## Two bugs found and fixed in pass 3

1. **`buildDiscountDraft` truncated over-long codes.**
   `normalizeDiscountCodeInput` slices to 40, which is right when a *customer*
   submits a code. Applied to staff input it stored the first 40 characters of a
   longer one, and staff would hand out a code that never matches. Now refused.
2. **A refused wishlist save on a product card was silent.** The icon variant
   set an error and rendered nothing. Now surfaced via tooltip, amber ring, and
   an `aria-describedby` live region. (`aria-invalid` is a form-field property
   with no meaning on a button.)

Also fixed: the cart share panel only rendered alongside cart items, so a link
shared earlier became unrevocable once its owner checked out or cleared the cart.

## Still to build

Reviews and moderation, customer cancellations, returns and refunds, shipping
and fulfillment, Stripe Tax, inventory UI, the transactional email lifecycle,
support tickets, Facebook auth and connected accounts, Vercel Web Analytics and
Speed Insights, Sentry completion, Turnstile, staff audit-log viewer, SEO
structured data, and the policy pages.

Independent of this work, still outstanding:

- **Guest checkout is unrepresentable**, not merely unimplemented:
  `orders.customer_id` is `NOT NULL` and the webhook refuses a session whose
  `customer_id` does not match the order. Supporting it needs a schema change
  and a second look at the webhook's identity check.
- **Pre-existing hydration mismatch** on `data-motion` on the root `<html>`,
  reproducible on `/terms` and every other page. It predates pass 3 and lives in
  the Appearance/theme runtime, not in any commerce code.
- **Pre-existing lint baseline**: 350 problems in `src` (179 errors, 171
  warnings), unchanged by pass 3.

## Environment notes

- `npm test` needs Node 22.6+ for `--experimental-strip-types`. This machine has
  Node 20, so use `npx tsx@4 --test tests/*.test.ts`.
- The Supabase CLI is **not installed**, and there is no local `supabase` in
  `node_modules`. `supabase db push` and `supabase migration repair` cannot be
  run here; ledger changes were made as guarded SQL through the MCP tool.
- `.env.local` carries a deliberately fake `SUPABASE_SERVICE_ROLE_KEY`, so any
  route using `routeServiceClient` fails locally. Pages render and error states
  are exercisable; data paths are not. Verify those on preview or production.

## Design decisions (carried forward)

**Direct purchase reuses `orders`.** A cart checkout creates a real order with
`order_kind='direct_purchase'`, `status='awaiting_payment'`, and a canonical
`agreed_price_cents` *before* the Stripe session is created. The existing webhook
settles it through the same RPC and idempotency table, so direct purchases
inherit every payment-hardening guarantee the request flow already has.

**Cart and wishlist items store no prices.** Every price, surcharge, discount,
and total is derived server-side from live product rows at display and again at
checkout. Client price tampering is structurally impossible rather than merely
validated away.

**Shares are snapshots and read capabilities.** A share link never carries owner
identity and never authorizes acting as the owner: the viewer's own cart and
wishlist are resolved from their own cookies, and every copied line is
revalidated. Revoking clears the token rather than only lowering a flag, so a
leaked link cannot be revived by a later bug.

**Share rules live in one pure module.** `src/lib/commerce/sharing.ts` holds
token shape, expiry, clamping, and liveness for both wishlist and cart shares.
Two implementations is how one of them quietly becomes the weak one. An
unparseable expiry counts as expired.

**Purchase mode backfills to `request_only`.** Both production products remain
`request_only`, so the cart and checkout stay inert until staff opt a product in.

**One subcategory level, enforced in the database.** A trigger rejects a parent
that itself has a parent, which also makes cycles unrepresentable.

## Migrations

| File | Purpose | Applied |
|------|---------|---------|
| `20260802020000_product_categories.sql` | Category tables, hierarchy guard, `products.category_id`, backfill | yes |
| `20260802020100_product_purchase_modes.sql` | `products.purchase_mode`, `requires_request`, options RLS fix | yes |
| `20260802020200_carts_and_wishlists.sql` | Carts, cart items, shared cart snapshots, wishlists | yes |
| `20260802020300_discount_codes.sql` | Discount codes, targeting, redemptions, atomic redemption RPC | yes |
| `20260802020400_direct_orders_and_reviews.sql` | `order_items`, order commerce columns, reviews and reports | yes |
| `20260803010000_wishlist_sharing_and_rate_limits.sql` | Wishlist share expiry, `rate_limit_hits`, `consume_rate_limit` | **no** |
| `20260803020000_shared_cart_ownership.sql` | `shared_carts.owner_hash`, snapshot subtotal, `touch_shared_cart` | **no** |

All are additive. No column is dropped; the legacy `products.category` text
column is retained for compatibility and kept in sync.

## Next steps, in order

1. Apply the two pass-3 migrations to production (needs approval).
2. Verify the Vercel preview build on `commerce-launch-readiness-20260803`.
3. Smoke-test wishlist, shared wishlist, shared cart, and discount staff UI
   against a real service-role key.
4. Merge, verify production Ready, smoke-test.
5. Then: reviews and moderation (schema already exists), cancellations, returns.
