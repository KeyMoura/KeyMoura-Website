# Commerce transformation — implementation ledger

Branch: `commerce-catalog-transformation`
Base: `3d51665` (final-quality pass, production verified)

This file is the running record of the catalog and commerce build. It exists so
the work can be picked up mid-flight without re-auditing finished areas. Update
the phase table as each phase lands.

## Phase status

| # | Phase | State |
|---|-------|-------|
| 1 | Architecture and schema design | complete |
| 2 | Additive migrations and category backfill | complete |
| 3 | Staff category tools and purchase modes | pending |
| 4 | Public catalog redesign | pending |
| 5 | Canonical cart and pricing | pending |
| 6 | Cart drawer/page and sharing | pending |
| 7 | Wishlist and sharing | pending |
| 8 | Discount engine and staff management | pending |
| 9 | Reviews and moderation | pending |
| 10 | Stripe checkout and direct orders | pending |
| 11 | Search, navbar, Appearance integration | pending |
| 12 | Security review | pending |
| 13 | Tests and browser validation | pending |
| 14 | Preview validation | pending |
| 15 | Migration application | pending |
| 16 | Merge and production verification | pending |

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
