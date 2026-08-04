# Commerce transformation — implementation ledger

Pass 1: `commerce-catalog-transformation` → PR #5, merged as `706919e`.
Pass 2: `commerce-completion-20260803` → PR #6, merged as `c4b98d1`, in production.
Pass 3: `commerce-launch-readiness-20260803` → merged as `f47005e`, in production.
Pass 4: `product-experience-lifecycle-20260803` → in progress, based on `f47005e`.

This file is the running record of the catalog and commerce build. It exists so
the work can be picked up mid-flight without re-auditing finished areas.

## Pass 3 — closed out

Merged as `f47005e`. 364 tests pass, typecheck clean, production build clean.
Lint: 350 pre-existing problems in `src`, unchanged.

**Both pass-3 migrations are applied.** Verified against production on
2026-08-03 by checking the objects themselves, not the ledger row — the
distinction matters, because a recorded version proves bookkeeping, not DDL:

- `rate_limit_hits` table — present
- `consume_rate_limit(p_bucket, p_subject, p_limit, p_window_seconds)` — present
- `touch_shared_cart(p_token)` — present
- `wishlists.share_token`, `.share_expires_at`, `.shared_at` — present, nullable
- `shared_carts.owner_hash`, `.snapshot_subtotal_cents` — present, nullable

The migration ledger and the repository agree exactly: 34 files, 34 rows,
versions matching filenames. Nothing outstanding from pass 3.

## Pass 4 — product experience and customer lifecycle

Branch `product-experience-lifecycle-20260803`, from `f47005e`.

### Phase 1 — catalog card click target — complete

**Root cause.** `.product-card:hover .product-card-action { filter:
brightness(1.1) }`. A computed `filter` other than `none` makes an element
establish a stacking context (Filter Effects L1). An element that establishes a
stacking context with `z-index: auto` paints in CSS 2.1 Appendix E step 8,
together with positioned `z-index: 0/auto` boxes, **in tree order**. The
call-to-action `<span>` follows the anchor in the DOM, so on hover it painted
*above* the anchor's `inset: 0` `::after` overlay and swallowed the click.

That is why the symptom looked so odd: every other part of the card navigated,
and only the button was dead — and it was dead only for a pointer, because
hovering is the thing that created the stacking context. A programmatic hit test
finds nothing wrong, since `:hover` never applies.

**Fix.** Two independent guards, either of which closes it:

1. `.product-card-link::after` gets `z-index: 1`, making the overlay's layer
   explicit instead of leaving it to paint order.
2. `.product-card-action` gets `pointer-events: none`, so it cannot become a hit
   target no matter what future style lands on it.

Independent controls move to a named `.product-card-aside` (`z-index: 2`), so
the card's whole layering contract is stated in one place and is testable:
aside > overlay > everything decorative.

The card keeps **exactly one anchor**. The call-to-action is `aria-hidden`
decorative markup rather than a second link, because a second link to the same
product would give it two tab stops, two screen-reader announcements, and two
analytics activations for one click. Keyboard users get one focus ring drawn on
the overlay, so the visible target matches the clickable one.

**Verified in a real browser** (desktop 1280 and mobile 375, dev server): with
the hover filter applied, the button hit-tests to the anchor and a dispatched
click navigates to the product; the wishlist control hit-tests inside its
`<button>` and never to the anchor; both live purchase modes render their own
wording; no horizontal overflow.

- Changed: `src/app/globals.css`, `src/components/ProductCard.tsx`.
- Tests: `tests/product-card-interaction.test.ts` (14 new), plus one assertion
  updated in `tests/commerce-wishlist.test.ts`. 378 pass, 0 fail.
- The new suite was confirmed to **fail** against the pre-fix CSS, so it tests
  the bug rather than the fix.
- One test generalizes the lesson: it scans every rule that sets a
  stacking-context property inside `.product-card` and fails on any that is not
  in an allow-list with a stated reason.
- No schema change. No migration.

### Phase 2 — cart cover images — complete

Cart lines now show the product's cover image in both the drawer and `/cart`.

**The loader was already duplicated.** `loadDisplayFields` existed byte-identical
in `wishlistService` and `sharedCartService`, and the cart would have been a
third copy. Extracted to `src/lib/commerce/productDisplay.ts` as
`loadProductImageSources` — three answers to "which image wins" is how one of
them quietly stops agreeing with the catalog. Both services now import it.

Resolution itself is unchanged and still goes through `productImages.ts`:
gallery media by `sort_order` first, `products.image_url` only as a fallback.
No competing resolver was introduced.

**Query shape.** Two batched queries for the whole cart regardless of line
count, run in parallel with the pricing load rather than after it. Ids are
de-duplicated first, because a cart may hold the same product configured two
ways. A fifty-line cart costs the same as a one-line cart.

**Wire shape.** `image: ProductImageSource` — `{ image_url, product_media }`,
the same shape the wishlist already sends, so the client keeps `ProductImage`'s
fall-forward behaviour when the first gallery URL is broken. Public catalog
columns only: no signed URLs, no storage credentials, no owner identity. Both
the `items` list and the `unavailable` list carry one, so an out-of-stock line
is still recognisable and a deleted product falls back to the brand mark.

**Accessibility.** The thumbnail links to the product but is `aria-hidden`,
`tabIndex={-1}`, and `alt=""` — the product name beside it is the labelled link
to the same place, so a screen reader announces each line once, not twice.

**Layout.** `.cart-thumb` is square (4rem page, 3.25rem drawer, 2.5rem on the
unavailable list) with `aspect-ratio` reserving the box, so a loading image
cannot shift the quantity and Remove controls.

- Changed: `src/lib/commerce/productDisplay.ts` (new),
  `src/lib/commerce/cartService.ts`, `wishlistService.ts`,
  `sharedCartService.ts`, `src/components/commerce/CartIndicator.tsx`,
  `src/app/cart/page.tsx`, `src/app/globals.css`.
- Tests: `tests/cart-product-images.test.ts` (18 new). 396 pass, 0 fail.
- No schema change. No migration.

**One defect found and fixed in browser testing.** At 320px a `basis-48` text
column no longer fitted beside the thumbnail, so the row wrapped and left the
image stranded on a line of its own. Narrowed to `basis-40`; re-measured with
rectangle-intersection rather than edge comparison, which is what distinguishes
a wrap from a real overlap.

**Verified locally:** thumbnail boxes 64/40px as specified, all three media
cases render (gallery-only with a null `image_url`, `image_url`-only, and the
`KM` fallback for no media), `object-fit: cover`, empty alt, no horizontal
overflow, no text/thumbnail overlap. The optimizer serves 8.8 KB at DPR 2 for a
64px box rather than the full-size original.

**Still to verify on preview:** the live API data path and the full
320/375/768/1024/1440 matrix with images actually painting. `.env.local` carries
a deliberately fake `SUPABASE_SERVICE_ROLE_KEY`, so every `routeServiceClient`
read fails locally — `/api/cart` returns an empty cart and `POST` answers "that
product is no longer available". Local rendering was therefore verified by
seeding the React Query cache with a payload built from real production media
URLs, which exercises the real components but not the real query.

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
| `20260803010000_wishlist_sharing_and_rate_limits.sql` | Wishlist share expiry, `rate_limit_hits`, `consume_rate_limit` | yes |
| `20260803020000_shared_cart_ownership.sql` | `shared_carts.owner_hash`, snapshot subtotal, `touch_shared_cart` | yes |

All are additive. No column is dropped; the legacy `products.category` text
column is retained for compatibility and kept in sync.

## Next steps, in order

Pass 4, in priority order:

1. ~~Catalog card click target~~ — complete.
2. Product cover images in the cart drawer and `/cart`.
3. Staff discount percentage input.
4. Navbar responsive repair.
5. Product-detail redesign, then reviews, cancellations, returns.
