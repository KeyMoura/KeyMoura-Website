# Commerce transformation — implementation ledger

Pass 1: `commerce-catalog-transformation` → PR #5, merged as `706919e`.
Pass 2: `commerce-completion-20260803` → PR #6, merged as `c4b98d1`, in production.
Base: `3d51665` (final-quality pass, production verified)

This file is the running record of the catalog and commerce build. It exists so
the work can be picked up mid-flight without re-auditing finished areas. Update
the phase table as each phase lands.

## Phase status

| # | Phase | State |
|---|-------|-------|
| 1 | Architecture and schema design | complete |
| 2 | Additive migrations and category backfill | complete — applied and verified |
| 3 | Staff category tools and purchase modes | purchase modes complete; category *management page* still pending |
| 4 | Public catalog redesign | purchase-mode actions complete; category sidebar/routes pending |
| 5 | Canonical cart and pricing | complete — service and `/api/cart` |
| 6 | Cart drawer/page | complete. Shared carts pending |
| 7 | Wishlist and sharing | pending |
| 8 | Discount engine and staff management | engine + checkout redemption complete; staff UI pending |
| 9 | Reviews and moderation | schema complete; API and UI pending |
| 10 | Stripe checkout and direct orders | complete |
| 11 | Search, navbar, Appearance integration | navbar complete; search/category integration pending |
| 12 | Security review | purchase path reviewed and probed in production; rest pending |
| 13 | Tests and browser validation | 275 tests; cart UI browser-verified |
| 14 | Preview validation | build verified; deeper preview validation blocked by Vercel SSO |
| 15 | Migration application | complete — no new migrations in pass 2 |
| 16 | Merge and production verification | complete — `c4b98d1` live and smoke-tested |

## Pass 2 — what shipped

The direct-purchase path is complete and live, but **inert**: both production
products are still `request_only`, so nothing can enter a cart until staff
deliberately opt a product in from the product editor.

Three defects in the pass-1 foundation were found and fixed:

1. `loadPricedProducts` read the entire `product_option_values` table with no
   `option_group_id` filter. Past PostgREST's row cap it truncated silently,
   making a required option unresolvable and rejecting valid cart lines.
2. Cart lines were keyed by product id, but `cart_items` has no unique
   constraint on `(cart_id, product_id)` — one product configured two ways is
   two rows. The storage row id is now threaded through pricing as `lineId`,
   and merging keys on product *and* options.
3. `logAuditEvent` silently dropped every `staff.*` event unless the actor was
   admin/support/moderator, discarding the category API's audit trail.

Production probes confirming enforcement (run against keymoura.com after merge):

- A `request_only` product posted straight to `/api/cart` → 409 with a reason.
- The same with `unitPriceCents`/`totalCents` forged in the body → still 409;
  client prices are not read at all.
- `POST /api/cart/checkout` unauthenticated → 401 `requiresSignIn`, no session.
- A refused add creates no cart row: validation runs before `findOrCreateCart`.

## Still to build

Wishlist, shared carts, reviews, cancellations, returns/refunds, shipping, tax,
inventory UI, the transactional email lifecycle, support tickets, Facebook auth
and connected accounts, Vercel Web Analytics, Turnstile and rate limiting,
staff audit-log surfacing, SEO structured data, and the policy pages.

Also outstanding, and independent of this work:

- **Migration ledger drift.** `supabase_migrations.schema_migrations` records
  versions (`20260802172246`…) that do not match the repo filenames
  (`20260802020000`…), several repo migrations are absent from the ledger, and
  a `complete_order_notifications_schema` is recorded that has no repo file.
  The *schema itself* is correct — it was verified column by column — but
  `supabase db push` would misbehave until the ledger is reconciled.
- **Guest checkout is unrepresentable**, not merely unimplemented:
  `orders.customer_id` is `NOT NULL` and the webhook refuses a session whose
  `customer_id` does not match the order. Supporting it would need a schema
  change and a second look at the webhook's identity check.

## What exists on the branch right now

Shipped and green (242 tests, typecheck clean, focused lint clean):

- All five migrations, applied to the live project and verified: record
  counts unchanged, backfill correct, hierarchy guards proven in the database.
- `src/lib/commerce/purchaseModes.ts` — the three modes and their gates.
- `src/lib/commerce/pricing.ts` — the pricing engine. Pure, no client input.
- `src/lib/commerce/discounts.ts` — eligibility and amount. Pure.
- `src/lib/commerce/categories.ts` — hierarchy, slugs, deletion safety.
- `src/lib/commerce/cartService.ts` — the canonical cart: resolve, merge,
  serialize. Every price comes from a live product row.
- `src/app/api/staff/catalog/categories/**` — list, create, reorder, edit,
  archive, move products, delete-with-guard. All behind
  `catalog.categories.manage`.
- Three new permission keys registered in the typed permission list and
  seeded in the database.

## Next steps, in order

1. Cart HTTP routes (`/api/cart`) over `cartService`, plus the guest cookie.
2. Product editor: purchase-mode field and the hierarchical category selector.
3. Staff category management page.
4. Catalog redesign with the category sidebar and category routes.
5. Cart drawer, `/cart`, shared carts, wishlist.
6. Discount and review staff tools; review submission and moderation.
7. `/api/cart/checkout` creating a `direct_purchase` order, then the webhook
   branch that settles it.
8. Search, navbar, and Appearance integration.
9. Security review, browser validation, preview, merge, production.

**The branch must not be merged until at least the checkout path is complete
and verified.** Half a commerce system in production is worse than none: the
schema is additive and inert, but a partial cart would be reachable.

## Audit of what already existed

- `products` — free-text `category`, `is_custom`, `starting_price_cents`,
  availability and inventory fields, `archived_at`. RLS: public read when
  `is_published and archived_at is null`; staff manage.
- `product_media`, `product_option_groups`, `product_option_values` — options
  are gated on `p.is_custom` in RLS, so a non-custom product's options are
  invisible to the browser client. Phase 2 relaxes this to `p.is_published`.
- `orders` — **one product per order** (`product_id`, `product_name`,
  `quantity`, `specifications` jsonb). Statuses: requested, accepted,
  customer_review, awaiting_payment, in_progress, final_review, ready,
  completed. RLS: customers read own, may insert only `status='requested'`
  with a null `order_number`; staff manage all.
- Stripe — `/api/orders/[id]/checkout` creates a session for an order that
  already has `agreed_price_cents`; the webhook dedupes on
  `stripe_webhook_events.stripe_event_id` and settles money through the
  `record_stripe_order_payment` RPC.
- `is_staff_user()` exists and is the standard RLS staff predicate.

## Design decisions

**Direct purchase reuses `orders`.** A cart checkout creates a real order with
`order_kind='direct_purchase'`, `status='awaiting_payment'`, and a canonical
`agreed_price_cents` *before* the Stripe session is created. The existing
webhook then settles it through the same RPC and the same idempotency table, so
direct purchases inherit every payment-hardening guarantee the request flow
already has instead of growing a second, weaker payment path.

**Cart items store no prices.** `cart_items` holds only product, quantity, and
selected options. Every price, option surcharge, discount, and total is derived
server-side from live product rows at display and again at checkout. Client
price tampering is structurally impossible rather than merely validated away.

**Shared carts are snapshots.** A share link points at an immutable copy of the
items, never at the owner's live cart, and carries no owner identity. Prices and
availability are re-resolved from live products when the link is viewed and
again when a viewer copies items.

**Purchase mode backfills to `request_only`.** Every existing product keeps
exactly today's behavior: nothing becomes directly purchasable without a staff
decision. Staff opt each product in from the product editor.

**One subcategory level, enforced in the database.** A trigger rejects a parent
that itself has a parent, which also makes cycles unrepresentable.

## Migrations

Applied in filename order.

| File | Purpose |
|------|---------|
| `20260802020000_product_categories.sql` | Category tables, hierarchy guard, `products.category_id`, backfill from free-text |
| `20260802020100_product_purchase_modes.sql` | `products.purchase_mode`, `product_option_values.requires_request`, options RLS fix |
| `20260802020200_carts_and_wishlists.sql` | Carts, cart items, shared cart snapshots, wishlists |
| `20260802020300_discount_codes.sql` | Discount codes, targeting, redemptions, atomic redemption RPC |
| `20260802020400_direct_orders_and_reviews.sql` | `order_items`, order commerce columns, product reviews and reports |

All are additive. No column is dropped; the legacy `products.category` text
column is retained for compatibility and kept in sync during this pass.

### Backfill rules (categories)

1. Trim, collapse internal whitespace, and title-case each distinct non-empty
   `products.category`.
2. Group case-insensitively, so `CNC`, `cnc`, and ` Cnc ` become one category.
3. Slug = lowercased, non-alphanumerics collapsed to `-`, trimmed. Collisions
   get a `-2`, `-3`, … suffix.
4. Every backfilled category is a top-level parent; no subcategory is invented.
5. Products with a null or blank category keep `category_id = null` and surface
   under "Uncategorized" in staff tools. They are never hidden from the catalog.
6. `display_order` follows product count descending, so the busiest categories
   sort first.

Records needing manual review after backfill are listed in the phase-2 report:
any category whose name differed only by case or whitespace from another.
