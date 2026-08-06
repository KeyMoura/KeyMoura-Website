# Commerce transformation — implementation ledger

Pass 1: `commerce-catalog-transformation` → PR #5, merged as `706919e`.
Pass 2: `commerce-completion-20260803` → PR #6, merged as `c4b98d1`, in production.
Pass 3: `commerce-launch-readiness-20260803` → merged as `f47005e`, in production.
Pass 4: `product-experience-lifecycle-20260803` → merged as `cbf6e26`, in production.
Pass 5: `staff-operations-command-center-20260804` → in progress, based on `8ce4c92`.

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

### Phase 3 — discount value input — complete

**The input control was never broken.** `discountValue` is a plain string in
state and `onChange` writes `event.target.value` verbatim; typing, clearing,
pasting and decimals all land correctly. Confirmed by driving the real field in
a browser before changing anything. The bug was downstream, and there were three
of them.

1. **Decimals were silently truncated.** `discount_codes.discount_value` is an
   `integer` and `discount_codes_value_check` pins percentages to 1–100, so
   12.5% is not representable. `buildDiscountDraft` ran `Math.trunc`, so a staff
   member typed 12.5, saw no complaint, and published a **12%** code. The number
   that came out was not the number that went in — which is exactly "a number
   cannot be typed correctly."
2. **An empty field reported the wrong problem.** `Number("")` is `0`, which is
   finite, so a blank box slipped past the "is this a number" guard and came
   back as *"A percentage discount is between 1 and 100"* — an answer to a
   question nobody asked.
3. **`inputMode="decimal"` on a whole-number field.** Mobile staff got a decimal
   keypad for a column that cannot hold a decimal.

**Decision: percentages are whole numbers.** That is what the schema enforces.
Widening `discount_value` to `numeric` would touch a live pricing path and the
redemption RPC for a feature nobody asked for; refusing the value clearly is the
honest fix. A fixed amount takes dollars and cents and refuses a third decimal
place for the same reason — it would be rounded away silently.

**One validator, two callers.** `parseDiscountValue(type, raw)` in
`discountAdmin.ts` is pure and dependency-free, so the form imports the same
function the route runs. The sentence under the field is the sentence the server
would have returned; they cannot drift.

**Switching type clears the value.** "10" is 10% in one mode and $10.00 in the
other — same digits, very different offer. Carrying it across is how a
ten-percent code ships as a ten-dollar one.

The error waits for a blur or a submit, so a fresh form does not open red and a
field does not flash invalid between being emptied and the first digit landing.
On submit it stops locally, marks `aria-invalid`, and moves focus to the field.

- Changed: `src/lib/commerce/discountAdmin.ts`,
  `src/app/staff/catalog/discounts/page.tsx`.
- Tests: `tests/discount-value-input.test.ts` (24 new). 420 pass, 0 fail.
- No schema change. No migration.

**Verified in a real browser**, driving the live form with the staff permission
seeded into the query cache: `25` accepted; `12.5` → "A percentage has to be a
whole number…"; `150` and `-5` → "between 1 and 100"; empty → "Give the discount
a value."; `abc` → "That is not a number."; `100` accepted at the boundary; the
error clears when the value becomes valid. `aria-invalid` and `aria-describedby`
toggle between the hint and the error. Switching percent→fixed clears the value
and flips the keypad and the hint. Submitting `12.5` is stopped locally, focus
lands on the field, and the typed value is preserved.

Note that an *empty* value is caught by the browser's native `required` handling
before React's guard runs, because the code field is `required` too and fails
first. That path shows the browser's own bubble rather than the inline message.

### Phase 4 — navbar layout — complete

**Root cause, measured.** The desktop bar was
`grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]`, which forces the two side
columns to the *same* width. At 1280 with a signed-in staff account the search
button needs 85px and the utility cluster needs **495px** — and both were given
**306px**. The cluster is `justify-end` and its pills do not shrink, so the
extra 190px overflowed *leftward*, straight over the centred navigation.
Nothing clipped it and the page never gained a horizontal scrollbar, which is
why it presented as controls sitting on top of each other rather than as
overflow. Reproduced before the fix as four concrete collisions, the worst being
"Community" over the cart button by 36px.

**Fix.**

1. `grid-cols-[auto_minmax(0,1fr)_auto]`. Utilities and search size to their own
   content; the navigation is the flexible column — so when something has to
   give, it is the part that has an overflow menu to give into. The utility
   cluster is additionally `shrink-0`, stating the invariant.
2. **Explicit priority.** Catalog and Projects stay on the bar at every desktop
   width; About, Capabilities, Contact and Community are inline from `xl` up and
   collapse into a **More** menu below it. Both sides are driven by the same
   `xl` breakpoint, so exactly one of the two ever shows a given link, and the
   menu is derived from the same list rather than maintained separately.
3. **No measurement.** A measured overflow has to guess a width during server
   rendering and correct it after mount — a hydration mismatch and a visible
   reflow on every load. The split is pure CSS.
4. **A second overflow at `2xl`, found while testing.** `2xl` is where the
   header *grows*: the search button gains its Ctrl+K chip, the account name is
   allowed 140px instead of 110, and the wordmark appears. Measured at 1920 that
   is 1292px of content inside a container capped at 1240px. The bar now widens
   to `94rem` from `2xl`, and an operator wordmark is bounded at `max-w-28` so
   it cannot reopen it. Giving the controls room is the fix rather than shrinking
   them — the point of those breakpoints is that there is space to spend.
5. **Counts cap at `99+`, not `9+`.** `src/lib/navBadge.ts` is now the one
   definition, shared by cart, wishlist, messages and notifications; four copies
   of `count > 9 ? "9+" : count` is how one control ends up saying "9+" beside
   another saying "12". The bubble is absolutely positioned with its width
   reserved at "99+" and `tabular-nums`, so a count arriving after first paint
   cannot resize its button or nudge the bar. Screen readers get the real number
   ("Cart, 128 items"), never the capped text.

- Changed: `src/components/SiteHeader.tsx`, `src/lib/navBadge.ts` (new),
  `src/components/commerce/CartIndicator.tsx`, `WishlistIndicator.tsx`,
  `src/app/globals.css`.
- Tests: `tests/navbar-layout.test.ts` (17 new). 437 pass, 0 fail. Production
  build clean.
- No schema change. No migration.

**Verified in a real browser** at 320, 375, 480, 768, 1024, 1152, 1280, 1366,
1440, 1536 and 1920, with the signed-in staff cluster simulated (messages,
notifications carrying `99+`, a long account name, and the staff pill) and again
with a wordmark: **zero overlaps, zero clipping, no horizontal page overflow at
any width.** Below `xl` only Projects and Catalog remain inline and More
appears; from `xl` all six show and More is gone. The menu reports
`aria-expanded`, `aria-haspopup="menu"`, `aria-controls`, `role="menu"` with a
label, and `role="menuitem"` children; Escape closes it and returns focus to its
trigger; an outside click dismisses it. Growing a badge to `99+` moves the cart
button by 0px.

**Not covered by the local run:** browser zoom at 125%/150% was not driven
directly — it is equivalent to a narrower CSS viewport, which the width matrix
covers, but it was not separately confirmed. The signed-in state was simulated
at DOM level because `.env.local` cannot authenticate; confirm on preview with a
real staff session.

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

## Pass 4 — merged and in production

Branch `product-experience-lifecycle-20260803` → merged as **`cbf6e26`**, which
is the current production SHA.

| SHA | What |
|-----|------|
| `4c766c9` | Fix the catalog card's dead call-to-action |
| `0359e79` | Show product cover images on cart lines |
| `4fe74cf` | Stop the discount form silently changing what staff typed |
| `f69d261` | Stop the navbar stacking its controls on top of each other |
| `8db08ab` | Record pass 4 status and what remains |
| `cbf6e26` | Merge commit |

- **437 tests pass** (was 364 at `f47005e`; 73 added across four new suites),
  re-run on the merge commit itself.
- Typecheck clean. Local production build clean.
- Vercel preview build: success. **Vercel production deployment: Ready.**
- No schema change, no migration, no new dependency in this pass.
- Lint: the 350-problem pre-existing baseline in `src` is unchanged.

### Production smoke test — 2026-08-04, on `cbf6e26`

Deployed bundle confirmed first: the production CSS chunk carries
`pointer-events:none` on `.product-card-action`, plus `.site-nav-badge`,
`.cart-thumb`, `.product-card-aside`, and the `94rem` header cap.

| Check | Result |
|-------|--------|
| Catalog card action button | **Passes.** With the hover `filter` applied, both cards hit-test to their own anchor and a dispatched click navigated to `/catalog/premade-shift-knob`. One anchor per card, zero buttons inside it. |
| Wishlist isolation | **Passes.** The control hit-tests inside its `<button>` and never to the anchor, on both cards. |
| Cart drawer images | **Passes.** 52×52 box, image painted, `sizes="52px"`, `object-fit: cover`, `alt=""`, wrapper `aria-hidden` and `tabindex="-1"`. Badge read "1", label "Cart, 1 item". |
| `/cart` images | **Passes.** 64×64 box, image painted, `sizes="64px"`, no overlap with the product name, quantity and Remove both usable. The optimizer served **4.9 KB** (`w=96`) from a 1920×1080, 2.2 MB source. |
| Navbar | **Passes** at 375, 1024, 1280, 1366 and 1920 with the signed-in staff cluster simulated (messages, notifications at `99+`, long account name, staff pill): zero overlaps, zero clipping, no horizontal page overflow. Below `xl` only Projects and Catalog remain inline and More appears; from `xl` all six show. |
| Safe cart read | **Passes.** `GET /api/cart` → 200 in 407 ms against the real database. |
| Checkout, stopped before payment | **Correct refusal.** `POST /api/cart/checkout` as a guest → **401** `requiresSignIn`. No Stripe session, no order row, no payment. |

**The gap flagged before merge is now closed.** `loadProductImageSources` has
run against the real production database: a cart line for *Premade Shift Knob*
came back carrying both `image_url` and a `product_media` row with the real
Supabase Storage URL, and nothing but public catalog columns. That path had
previously only ever executed against seeded data.

**What could not be verified, and why.**

- **The staff discount create/edit flow.** `/staff/catalog/discounts` correctly
  redirects to `/auth/login` server-side, and signing in would mean handling a
  password, which is out of bounds for an automated session. The fix is present
  in the deployed build — the production CSS is from `cbf6e26` and JS and CSS
  come out of the same build — but the form was not driven on production. It
  *was* driven end to end against a local dev server: `12.5` → "A percentage has
  to be a whole number…", `150`/`-5` → "between 1 and 100", empty → "Give the
  discount a value.", `abc` → "That is not a number.", `100` accepted, error
  clears on a valid value, submit blocked with focus moved to the field.
- **Stripe Checkout Session creation.** Reaching it needs an authenticated
  customer, so the run stopped at the guest refusal. The session-creation path
  itself is unchanged by this pass.

**No product's purchase mode was changed to force a test.** Both products are
still `direct_or_request` and `request_only` exactly as before; the cart test
used *Premade Shift Knob*, which is already directly purchasable.

**Production data after the run:** 2 products, 6 orders, 1 order item, 1
category, 4 media rows, 1 wishlist, 1 shared cart, 0 discount codes, 34
migrations — every count identical to before. The pre-existing account cart
still holds its one item. The only artifact is **one empty guest cart row**
created by the test and then cleared; that is ordinary data, produced by any
guest who touches a cart.

## Still to build — pass 5 onward

Nothing below was started in pass 4. The priority order from the brief, with
what is already in place noted:

1. **Product-detail redesign** — the largest single item. Needs structured
   product content (benefits, specs, fitment, included items, installation,
   care, warranty, FAQ, dimensions, SKU, made-to-order, lead time), which is an
   additive migration plus staff editing surfaces, plus a two-column gallery and
   purchase panel.
2. **Reviews** — `product_reviews` and `product_review_reports` tables already
   exist from `20260802020400`; the API, customer UI, product-page integration,
   and staff moderation queue do not.
3. **Cancellations, returns, refunds** — `20260801050000_order_refunds_and_quote_expiration`
   exists; the customer request workflow, staff decisions, and Stripe refund
   settlement do not.
4. **Shipping, inventory, fulfillment, tax** — `20260731170000_order_fulfillment`,
   `20260731180000_catalog_inventory_editor` and
   `20260731190000_checkout_inventory_reservations` exist and are applied;
   Stripe Tax is not integrated at all.
5. **Transactional email lifecycle** — Resend is wired and
   `20260731160000_order_email_center` exists; the ~25 templates in the brief do
   not.
6. **Support tickets, Facebook auth and connected accounts, Vercel Analytics and
   Speed Insights, Sentry completion, Turnstile, rate-limit expansion, staff
   audit-log viewer, SEO structured data, policy pages** — none started.

Also still outstanding, unchanged from pass 3:

- **Guest checkout is unrepresentable**, not merely unimplemented:
  `orders.customer_id` is `NOT NULL` and the webhook refuses a session whose
  `customer_id` does not match the order.
- **Pre-existing hydration mismatch** on `data-motion` on the root `<html>`,
  reproducible on every page. It lives in the Appearance/theme runtime.
- **Pre-existing lint baseline**: 350 problems in `src`.

## Next steps, in order

1. **Owner check, five minutes.** Sign in as staff and drive
   `/staff/catalog/discounts`: type `12.5` into the percentage field and confirm
   it is refused rather than saved as 12, then create and edit a real
   percentage code. That is the one shipped fix no automated session can reach.
2. **Also worth an owner's eye:** a signed-in customer's navbar at ~1100–1300px
   (the staff cluster was simulated, not authenticated), and one real checkout
   through Stripe if a test order is acceptable.
3. Then start the product-detail redesign, which everything in phases 5–8
   hangs off.

### Noticed in passing, not acted on

*Premade Shift Knob*'s cover image is a **2.2 MB, 1920×1080 PNG**. The optimizer
handles it correctly on every surface (4.9 KB for a cart thumbnail), so nothing
is broken — but it is worth compressing at the source before the catalog grows,
and it is the kind of asset that makes the product-page gallery in phase 5
expensive if left as-is.

---

# Pass 5 — staff operations: production and job tracking

Branch `staff-operations-command-center-20260804`, from `8ce4c92`.

## Scope decision, and why

The brief for this pass asked for twenty phases: a staff dashboard rebuild, an
order command centre, production tracking, a product-management overhaul, bulk
tools, customer management, financial reporting, cost and margin tracking,
imports and exports, a notification centre, central business settings, audit-log
completion, integration health, a launch-readiness checker, printable documents,
a customer UX audit, performance and security reviews.

**The audit found that almost none of the groundwork existed.** Not "started and
unfinished" — absent. Reviews, returns, cancellations, refund workflows, support
tickets, tax, customer management, reporting, imports, notifications,
integration health and launch readiness had no code at all. The one genuine
customer-facing gap that was a *defect* rather than an unbuilt feature was
Vercel Analytics, which was on the required list and not installed.

Twenty systems at production quality is not one pass. The brief's own fallback
applies: *complete the largest coherent deployable staff workflow and document
every remaining item precisely.* Going breadth-first would have left every staff
system half-wired, which the brief explicitly forbids.

**What was built instead: production and job tracking, complete and wired end to
end** — schema, domain rules, API, queue, job workspace, printable documents,
audit events, permissions, dashboard cards, and order-page integration. It is
the system a custom manufacturing business actually runs its day on, it was
entirely absent, and it stands on its own without depending on anything else in
the twenty-phase list.

Everything not built is listed under "Not built in pass 5" below, with what is
already in place noted, so the next pass starts from fact rather than re-auditing.

## Phase 1 carryover — Vercel Analytics — complete

`@vercel/analytics` was **not installed** despite being on the required list;
`@vercel/speed-insights` was, and was already mounted. Installed and mounted
beside it in `src/app/layout.tsx`. One dependency added, nothing else touched.

The rest of the pass-4 carryover list (reviews, cancellations, returns, refunds,
shipping, inventory UI, tax, emails, support, Facebook auth, connected accounts,
Turnstile, SEO structured data) is unbuilt rather than defective — see below.

- Changed: `package.json`, `package-lock.json`, `src/app/layout.tsx`.

## Production and job tracking — complete

### Schema

`20260804010000_production_jobs.sql`. **Additive**: four new tables, one
sequence, two functions, one trigger. No existing table, column or constraint is
altered; a test asserts this by scanning the migration for `drop`, `truncate`,
`delete from`, and any `alter table` against `orders`, `products`, `profiles` or
`order_items`.

| Table | Holds |
|-------|-------|
| `production_jobs` | The job |
| `production_job_tasks` | Manufacturing steps, completion checklist, QC checklist |
| `production_job_files` | CAD/CAM/drawing/reference/customer-approved references |
| `production_job_events` | The operational timeline |

**One task table, not three.** A manufacturing step, a completion-checklist line
and a QC line differ only by which list they are on. Three tables would mean
three sets of policies, indexes and ordering rules that drift apart, and
reordering written three times. A `kind` discriminator costs one CHECK.

**The timeline is separate from `audit_logs` on purpose.** The audit log is a
security record with its own retention and severity concerns; the job timeline
is an operational artifact staff read on every visit to a job. Making the
timeline a filtered query over `audit_logs` would couple a hot operational read
to a table that grows without bound and may be pruned. Consequential actions
write **both**.

**Job numbers come from a sequence**, not `max(job_number) + 1`: two staff
creating a job at the same moment must not race for the same number. Numbers may
skip on a rolled-back insert, which is correct — a job number identifies a job,
it does not count them. Format `JOB-0001`.

**Every link is nullable with `on delete set null`** — order, order item,
product, customer, assignee. A job may exist before an order does (stock work),
and must survive the removal of whatever it was raised against.

Two constraints worth naming:

- `production_job_tasks_done_check` forces `is_done` and `done_at` to agree.
  Without it a row can claim completion while carrying no completion time, and
  the QC printout shows a tick with no date beside it.
- `production_job_files_target_check` — a file row pointing at neither a storage
  path nor a URL is not a file.

**RLS: staff-only on all four tables.** There is deliberately no customer policy,
because there is no customer-facing read — scrap reasons, rework history,
internal notes and materials cost are not customer information. The timeline has
**select and insert policies only**, so an authenticated staff session cannot
rewrite a job's history through PostgREST. Tests assert no policy is granted to
`anon` or `public`, that every policy is gated on `is_staff_user()`, and that
the timeline has no update/delete policy.

**Dry-run result.** Run against production inside a transaction that was rolled
back: tables created, `JOB-0001` generated by the sequence, task and event
inserts accepted, 5 policies, 15 indexes. Verified afterwards that production
was untouched — all four tables absent, sequence absent, zero leftover
functions, still 34 migration rows.

### Domain rules — `src/lib/production/jobs.ts`

Pure and dependency-free, so the API, the queue, the job page and the printable
documents import the same rules and cannot state them differently.

Thirteen states: not started, planning, waiting on customer, waiting on
materials, scheduled, in progress, quality check, rework required, ready for
pickup, ready to ship, completed, on hold, cancelled. Four priorities.

**Transitions are permissive between live states, and refuse only what is
actually wrong.** A shop knob goes not started → in progress → completed; a
one-off fixture wanders through planning, materials, rework and QC. Hard-coding
one path would make the simple job fight the tool. What is refused:

1. **Re-selecting the current status** — so a dropdown touch is never a write.
2. **Leaving a terminal state** by anything but an explicit reopen.
3. **Entering `on_hold`, `rework_required` or `cancelled` without a reason.**

**Completion warnings are advisory, never blocking.** Unticked QC items on a job
that has a QC list are worth a second look; a job with no list raises nothing,
which is what keeps simple work simple. The route answers `409` with the
warnings once; the same call with `acknowledge: true` goes through.

**A bug the tests caught.** `2026-13-45` matched the date regex, and
`new Date(2026, 12, 45)` is not an error in JavaScript — it rolls forward to
2027-02-14. An impossible date typed by staff would have been accepted as a real
one six months away. The parser now round-trips the components back out and
rejects rather than reinterprets.

### API

| Route | Methods | Permission |
|-------|---------|------------|
| `/api/staff/production/jobs` | GET, POST | view / **manage** |
| `/api/staff/production/jobs/[id]` | GET, PATCH | view / **manage** |
| `/api/staff/production/jobs/[id]/status` | POST | **manage** |
| `/api/staff/production/jobs/[id]/tasks` | POST, PATCH, DELETE | **manage** |
| `/api/staff/production/jobs/[id]/files` | POST, PATCH, DELETE | **manage** |
| `/api/staff/production/summary` | GET | view |

**Saving fields cannot move a job through the workflow.** `PATCH` pins `status`
to whatever the row already holds and strips it from the update; status goes
through its own endpoint, which enforces the transition rules. Two tests assert
this.

**Two guards against a stale page.** The browser sends `expectedStatus` (or
`expectedUpdatedAt`), which is compared to the row — and the status update
additionally re-asserts the from-status in the `WHERE` clause, so a change that
landed between the read and the write matches zero rows instead of overwriting
somebody else's work. Both answer `409` with a sentence telling staff to reload.

**The dashboard counts server-side.** `/summary` issues eight `head: true`
count queries in parallel: Postgres counts and no row crosses the wire. The
counts are true totals, not "up to the first hundred" — a card reading 12 when
there are 300 is worse than no card.

**The search box cannot inject filters.** `,`, `(`, `)` and `\` are PostgREST's
own `or()` separators and are stripped before the filter is built.

### Staff surfaces

- `/staff/production` — the queue. **Filters live in the URL**, so every
  dashboard card links to an exact view and a view is bookmarkable and
  shareable. Grouped into overdue / blocked / active / finished, each job in
  exactly one bucket so the counts add up.
- `/staff/production/new` — raise a job. Accepts `orderId`, `productId`,
  `customerId` and `title` so the order page hands off pre-linked.
- `/staff/production/[id]` — the workspace: linked records, status control,
  three checklists, files, details form, and history.
- `/staff/production/[id]/print` — traveller, work order and QC checklist.

**Counts stay stable while loading.** The previous payload is held during a
refetch, so a filter change looks like a filter change rather than the queue
emptying and refilling.

**Consequential actions confirm.** Removing a checklist item, removing a file,
and making a manufacturing file customer-visible each confirm first. Completion
confirms when there are warnings. Saving is explicit — the button is disabled
until the form actually differs from what is stored, `beforeunload` guards a
mid-edit tab close, and nothing autosaves.

### Printable documents

Server-rendered, because `Ctrl+P` on a half-hydrated page is a blank sheet.
Three sections, each starting on a fresh sheet: the traveller rides with the
part, the work order goes to whoever is cutting, the QC sheet is signed and
filed.

**Marked internal on all three sections.** It carries internal notes, scrap and
rework history. The route requires a staff permission and the tables are
staff-only under RLS; verified that an unauthenticated request renders the
refusal and leaks none of the document.

Checkboxes print **empty even when ticked on screen** — the sheet that travels
with the part is signed at the machine.

Print CSS is global (`src/app/globals.css`): navigation, footer and the staff
sidebar are never wanted on paper on any page. That blanket rule is only safe
because the printable pages use no `header`, `footer` or `nav` element of their
own — a test asserts it.

### Audit

Nine event types, all `staff.`-prefixed so `logAuditEvent` retains them (it
drops anything not admin/security/moderation/staff — a differently-prefixed type
would be silently discarded, and a test asserts the prefix):

`create`, `update`, `status`, `task_add`, `task_update`, `task_remove`,
`file_add`, `file_visibility`, `file_remove`.

**Note bodies are never copied into audit metadata.** The update event records
*which fields changed*, not what was written in them — the audit log is read
more widely than the job page.

### Permissions

`production.view` and `production.manage`, registered with labels and
descriptions. Reading and writing are separate so a machinist can be given the
queue without the ability to raise or retire work.

**Admins get both automatically** (`loadPermissionsForUser` returns the full set
for `admin`). **Other roles need a row in `role_permissions`** — see external
setup below.

## Files changed

New:

- `supabase/migrations/20260804010000_production_jobs.sql`
- `src/lib/production/jobs.ts`, `server.ts`, `access.ts`
- `src/app/api/staff/production/jobs/route.ts`
- `src/app/api/staff/production/jobs/[id]/route.ts`
- `src/app/api/staff/production/jobs/[id]/status/route.ts`
- `src/app/api/staff/production/jobs/[id]/tasks/route.ts`
- `src/app/api/staff/production/jobs/[id]/files/route.ts`
- `src/app/api/staff/production/summary/route.ts`
- `src/app/staff/production/page.tsx`, `new/page.tsx`, `[id]/page.tsx`,
  `[id]/print/page.tsx`
- `src/components/staff/production/JobBadges.tsx`, `JobForm.tsx`,
  `ProductionDashboardPanel.tsx`, `OrderProductionJobs.tsx`
- `tests/production-jobs.test.ts`, `tests/production-surfaces.test.ts`

Modified:

- `src/lib/permissions.ts` — two permissions plus metadata
- `src/components/staff/StaffNav.tsx` — Production link
- `src/app/staff/page.tsx` — production panel, loaded outside the orders gate
- `src/app/staff/orders/[id]/page.tsx` — shop-work panel; `product_id` added to
  the local `Order` type (the query was already `select("*")`)
- `src/app/layout.tsx` — Vercel Analytics
- `src/app/globals.css` — print styles
- `package.json`, `package-lock.json`

## Validation

- **522 tests pass, 0 fail** (437 before, 85 added across two suites).
- Typecheck clean. Production build clean, exit 0; all four routes present.
- **Lint unchanged at the 350-problem baseline** (179 errors, 171 warnings). The
  new code introduced 5 warnings, all found and fixed; the production code lints
  completely clean.
- Migration dry-run against production, rolled back, production verified
  untouched.
- Local browser: the queue's permission-denied state renders; print CSS
  confirmed live in the CSSOM (`header, footer, nav, .skip-link, .staff-nav,
  .print-hidden { display: none }` under `@media print`); no horizontal overflow
  at 375px; **every endpoint and the print page answer 403 to an unauthenticated
  caller** (GET, POST, PATCH and DELETE each checked).
- Console: only the **pre-existing** `data-motion` hydration mismatch on the root
  `<html>`, which reproduces on `/` and predates this work. No new errors.

**Not verifiable locally, and why.** `.env.local` carries a deliberately fake
`SUPABASE_SERVICE_ROLE_KEY` and a staff session cannot be forged without a
signed JWT, so the **populated** queue, the job workspace with real data, and a
real status transition were not driven in a browser. The rules behind them are
covered by the 85 tests; the rendering of populated states is not. This is the
same limitation pass 3 and pass 4 recorded.

## External setup still required

1. **Grant the new permissions to non-admin roles**, if wanted. Admins already
   have them. For anyone else, add `production.view` / `production.manage` in
   `/staff/security/roles`. Until then only admins and operators see Production.
2. **A storage bucket for job files.** `production_job_files` records
   *references* — a label plus a link or a storage path. It does not accept
   uploads: a CAD or CAM file is not something to stream through a JSON route,
   and the bucket plus its signed-URL policy were out of scope here. Staff can
   paste a link or a path today; direct upload needs a bucket, an upload route,
   and expiring signed URLs.

## Not built in pass 5

Carried forward, with what already exists noted. Nothing below was started.

1. **Product-detail redesign** — still the largest single item. Needs structured
   product content plus an additive migration and staff editing surfaces.
2. **Reviews** — `product_reviews` and `product_review_reports` exist from
   `20260802020400`; API, customer UI, product-page integration and the staff
   moderation queue do not. `catalog.reviews.moderate` exists as a permission
   with nothing behind it.
3. **Cancellations, returns, refunds** — `20260801050000` exists and
   `/api/staff/orders/[id]/refund` exists; the customer request workflow, staff
   decisions and Stripe refund settlement do not.
4. **Shipping, inventory UI, fulfilment, tax** — three migrations applied;
   Stripe Tax is not integrated at all.
5. **Transactional email lifecycle** — Resend is wired and
   `20260731160000_order_email_center` exists; the ~25 templates do not.
6. **Staff dashboard rebuild (phase 2)** — production cards were added; the rest
   of the dashboard is unchanged. No queues yet for quotes awaiting response,
   unpaid accepted quotes, cancellation/return requests, refund failures, open
   tickets, reviews awaiting moderation, failed emails or failed webhooks —
   most of those have no underlying system yet.
7. **Order command centre (phase 3)** — the shop-work panel was added to order
   detail; saved views, the full filter set, and export are not built.
8. **Product-management overhaul, bulk tools, inventory adjustments (phases
   5–6)** — `/staff/catalog` is unchanged. No category management *page* exists
   (the API does).
9. **Customer management (phase 7)** — nothing. `/staff/security/users` covers
   accounts, not commerce history.
10. **Financial reporting and cost/margin (phases 8–9)** — `businessAnalytics.ts`
    and `/staff/info/analytics` exist and are unchanged; no CSV export, no cost
    tracking, no margin calculation.
11. **Imports/exports, notification centre, central settings (phases 10–12)** —
    nothing.
12. **Audit-log completion (phase 13)** — the viewer exists at
    `/staff/security/audit`; production events now flow into it. Search, actor
    and action filters, severity and before/after detail are not built.
13. **Integration health and launch readiness (phases 14–15)** — nothing.
14. **Printable documents beyond production (phase 16)** — packing slip, pickup
    slip, invoice, return authorisation, refund record and inventory count sheet
    are not built. The print CSS foundation they need is now in place.
15. **Support tickets, Facebook auth, connected accounts, Turnstile, SEO
    structured data** — none started.

Also still outstanding, unchanged since pass 3:

- **Guest checkout is unrepresentable**: `orders.customer_id` is `NOT NULL` and
  the webhook refuses a session whose `customer_id` does not match the order.
- **Pre-existing hydration mismatch** on `data-motion` on the root `<html>`.
- **Pre-existing lint baseline**: 350 problems in `src`.
- **`npm test` needs Node 22.6+**; this machine has Node 20, so use
  `npx tsx@4 --test tests/*.test.ts`. Note that PowerShell does not expand the
  glob for a native command — run it from bash, or expand it first.

## Exact continuation steps

1. **Grant the production permissions** to whichever non-admin roles should see
   the queue.
2. **Drive the populated queue once as a signed-in staff member**: raise a job,
   move it through a status that needs a reason, tick a QC item, and print the
   work order. That is the one path no automated session can reach.
3. Then pick the next coherent system. **Reviews** is the cheapest real win —
   the tables already exist, so it is API plus UI with no migration. **Returns
   and refunds** is the highest-value one, and it has a migration already
   applied.

## Pass 5 — merged and in production

Branch `staff-operations-command-center-20260804` → merged as **`6bb03f4`**,
which is the current production SHA. Merged with `--no-ff`, never force-pushed.

| SHA | What |
|-----|------|
| `f8a4aec` | Mount Vercel Analytics alongside Speed Insights |
| `652c7bc` | Add the production job schema and its rules |
| `0000fbc` | Add the production job API |
| `0196b68` | Add the production queue, job workspace and printable documents |
| `db8b17d` | Wire production into the dashboard, orders and staff navigation |
| `fd11e57` | Record pass 5, the scope decision, and what remains |
| `6bb03f4` | Merge commit |

- Vercel **preview build: success**. Vercel **production deployment: Ready**.
- Migration `20260804010000` **applied to production with approval**, before the
  merge, so production never served a Production page whose tables did not
  exist.

### Migration application — 2026-08-04

Applied through `execute_sql` in a single guarded transaction, **not**
`apply_migration` — that tool stamps its own timestamp as the version, which
caused six of the seven ledger drift problems repaired in pass 3. The ledger row
was inserted by hand under the repository filename's version.

The transaction carried guards on both sides and would have rolled back whole:

- **Before**: `production_jobs` must not already exist; exactly 34 migration rows.
- **After**: exactly 4 tables, 5 policies, 15 indexes, 35 migration rows, and
  products/orders/order_items unchanged at 2/6/1.

All held; the transaction committed. Verified independently afterwards: 4 tables,
15 indexes, 5 policies, 2 functions, RLS enabled, 0 job rows.

**The ledger is exact: 35 repo files, 35 rows, versions and names identical**,
checked by diffing the two sorted sets. No drift introduced.

**Supabase security advisors: no new findings.** The 14 `rls_enabled_no_policy`
notices, the `security definer` warnings and the leaked-password-protection
warning are all pre-existing and none concern the new tables — all four have
policies, and `next_production_job_number` and `touch_production_job` are
deliberately not `SECURITY DEFINER`, so neither appears.

### Production smoke test — 2026-08-04, on `6bb03f4`

| Check | Result |
|-------|--------|
| Site health | **Passes.** `/` 200 in 0.86 s. |
| New staff routes exist | **Passes.** `/staff/production` and `/staff/production/new` answer 307 → `/auth/login`. A missing route would 404. |
| Production API refuses anonymous | **Passes.** `GET` on jobs and summary, and `POST` on jobs and status, all 307 → `/auth/login`. The pre-existing `/api/staff/catalog/discounts` behaves identically, so the new routes are gated exactly like every other staff route. |
| Defence in depth | **Confirmed.** Middleware redirects first in production; the route handlers themselves return **403** to every unauthenticated `GET`/`POST`/`PATCH`/`DELETE`, verified locally against a dev server. |
| Printable document gate | **Passes.** An unauthenticated request renders the refusal and leaks **none** of the document body. |
| Print CSS deployed | **Passes.** The production CSS chunk carries `@media print{header,footer,nav,.skip-link,.staff-nav,.print-hidden{display:none`, `@page{margin:14mm}`, and `print-break-before`. |
| Catalog and cart | **Passes.** `/catalog` 200, `/cart` 200, `GET /api/cart` 200 against the real database. |
| Checkout, stopped before payment | **Correct refusal.** `POST /api/cart/checkout` as a guest → **401** `requiresSignIn`. No Stripe session, no order row, no payment. |

**Production data after the run — every count unchanged:** 2 products, 6 orders,
1 order item, 1 category, 4 media rows, 2 carts, 1 wishlist, 1 shared cart, 3
users, 35 migrations. `production_jobs`, `production_job_events` and
`staff.production.*` audit events are all **0** — the smoke test created nothing,
because every write it attempted was correctly refused.

(`discount_codes` now reads 1 where pass 4 recorded 0. That was not created by
this pass, which never touches the table — it appears to be an owner-created
code from between passes.)

### Vercel Analytics — wired and enabled, end-to-end recording unconfirmed

Precisely what was established, because this one deserves care:

- The package is installed and `<Analytics />` is mounted in the root layout.
- **It runs in production**: `window.va` is installed and a pageview is queued —
  `[["pageview",{"route":"/","path":"/"}]]`.
- **Web Analytics is enabled on the Vercel project**: `/_vercel/insights/script.js`
  serves the real 2,495-byte tracking script, containing `vaq`, `pageview`,
  `beforeSend` and `disableAutoTrack`. A project without it enabled does not
  serve that.
- **The queue was not drained in the automated session, and that is by design.**
  The served script begins by refusing to run when
  `navigator.webdriver || navigator.userAgent.includes("Headless")`. An automated
  browser therefore cannot produce a recorded pageview, whatever the wiring.

So the integration is correct and the platform side is on, but **a recorded
pageview was not observed and could not be**. Worth one glance from a normal
browser: visit the site, then check Vercel → Analytics. Speed Insights, by
contrast, loads its script on every page load and was observed doing so.

---

# Pass 5a — production queue repair

Branch `production-queue-grant-repair-20260804`, from `d63b3a2` → merged as
**`167a6ff`**, which is the current production SHA. Merged with a merge commit,
never force-pushed.

## The failure

`/staff/production` answered **"Could not load the production queue."** for
every request, on every filter, for admins included. Pass 5's own smoke test did
not catch it: every check it ran was an *unauthenticated* one, and those all
correctly returned 307/403 before ever reaching the database. The first request
that got past the permission gate was the first one to touch the table.

## Root cause

`20260804010000_production_jobs.sql` created four tables and a sequence and
enabled RLS on all of them — and issued **no `grant` statements**.

This project's default privileges for a new `public` table are:

```
postgres=arwdDxtm/postgres
anon=Dxtm/postgres
authenticated=Dxtm/postgres
service_role=Dxtm/postgres
```

`Dxtm` is TRUNCATE, REFERENCES, TRIGGER, MAINTAIN. **There is no SELECT, INSERT,
UPDATE or DELETE in it.** A new table in this database starts with no usable
privilege for any PostgREST role — which is why every other table-creating
migration in this repository carries explicit grants. That one was the only one
that did not.

Table privileges are checked **before** row level security, and `service_role`'s
`BYPASSRLS` bypasses policies but **not** grants. So every service-role read died
with `42501: permission denied for table production_jobs` before a policy was
ever consulted.

**RLS, the permission keys, the query columns, the joins, the generated types
and the middleware were all correct, and none of them were ever reached.** The
error string was ambiguous by coincidence: `"Could not load the production
queue."` is both the route's 500 body and the client's fetch fallback. A 403
would have read `"Forbidden"`, which is what ruled the permission path out.

Evidence: nine `permission denied for table production_jobs` entries in the
Postgres log, plus role-switched probes showing `service_role` failing on all
four tables and the sequence while reading `orders` fine.

## Two more defects found on the way in

1. **The job-number sequence had no grants at all** (`relacl` null, owner only).
   Creating a job would have failed on `nextval` even once the tables were
   readable — a second outage waiting behind the first.
2. **`/summary` discarded `result.error` and returned `count ?? 0`.** PostgREST
   resolves rather than rejects, so the dashboard rendered "0 open, 0 overdue"
   while the queue beside it showed an error. A refused count is now a 500.

## The repair — `20260804020000_production_job_grants.sql`

Grants only. No DDL, no policy change, no table or row touched; the original
migration and its data are preserved.

- Only `service_role` is granted. `anon` and `authenticated` are **revoked**,
  which also removes the TRUNCATE they inherited from the default ACL —
  **TRUNCATE is not filtered by RLS**, so that was a real hole no policy closed.
- `production_job_events` gets `select, insert` **only**, so a job's history
  cannot be rewritten even by the service role. Cascade deletes still work: a
  referential action runs as the table owner and does not consult the caller's
  privileges. Verified explicitly.
- The four RLS policies from `20260804010000` are untouched.

Nothing was granted to any non-admin role. Admins already receive both
permissions automatically — `loadPermissionsForUser` returns the full `PERMISSIONS`
set for `admin`, before any `role_permissions` lookup.

## Diagnosability

`logProductionFailure` logs SQLSTATE, message and hint — and deliberately **not**
`details`, which is the one field that echoes row values back (a unique violation
reports the conflicting key, and a job carries internal notes, costs and customer
identifiers). No token, key, cookie or row body is logged. Wired into all six
routes and the reference loader.

The generic sentence is the right thing to show a machinist. It was the wrong and
only thing to have when diagnosing this.

## States

- **Authorized** staff get the queue.
- **Unauthorized** staff get a permission-denied state naming `production.view`,
  not a red retry box — on the queue, the job workspace, the dashboard panel and
  the order-page panel. Previously a 403 rendered the raw word "Forbidden" in a
  danger notice with a Try again button that could never succeed.
- **Empty** queue keeps its empty state. The route distinguishes `error` from
  `[]`, and a test asserts it.

## Validation

- **537 tests pass, 0 fail** (522 before, 15 added in `tests/production-grants.test.ts`).
- Typecheck clean. Focused lint on all production code clean. Production build
  clean, exit 0.
- **Lint unchanged at the 350-problem baseline** (179 errors, 171 warnings).
- Migration dry-run applied and rolled back **twice** against production, with
  production verified untouched after each.

The last test is the generalizable one: it derives what must be granted from what
the schema migration *creates*, so a fifth production table cannot ship ungranted
the way the first four did. It fails against the pre-fix state.

## Migration application — 2026-08-04

Applied with approval through `execute_sql` in one guarded transaction, **not**
`apply_migration` — that tool stamps its own timestamp as the version, which
caused six of the seven ledger drift problems repaired in pass 3.

- **Before**: `production_jobs` exists; exactly 35 migration rows; `20260804020000`
  not recorded; `service_role` does *not* have select (the bug is still present);
  `production_jobs` empty.
- **After**: `service_role` holds all four verbs on jobs/tasks/files; events has
  select+insert and **not** update/delete; sequence usage held; **zero** grant rows
  for `anon`, `authenticated` or `PUBLIC`; 36 migration rows; 5 policies;
  products/orders/order_items unchanged at 2/6/1; jobs and events still 0.

All held; the transaction committed. **The ledger is exact: 36 repo files, 36
rows, versions and names identical.**

The sequence was reset to `1 / is_called=false` after the dry runs, which had
consumed values — `nextval` is not transactional. Safe because the table is
empty, so the shop's first job is `JOB-0001`.

### Post-deploy verification — on `167a6ff`

| Check | Result |
|-------|--------|
| Vercel preview build | **Success.** |
| Vercel production deployment | **Ready.** |
| Site health | `/` 200, `/catalog` 200. |
| Staff routes exist and are gated | `/staff/production`, `/api/staff/production/jobs` and `/summary` all 307 → `/auth/login` for an anonymous caller. |
| Every API database path, as `service_role`, against the real production database | **All OK** — the `POST /jobs` insert (exercising the real default expression, the sequence and the `updated_at` trigger), the `GET /jobs` list with `scope=open`, the `/summary` head count, the `PATCH` update, and the timeline append. Run inside a transaction that was rolled back: **nothing was created**. |
| Append-only still holds | `UPDATE` and `DELETE` on `production_job_events` refused with 42501, as `service_role`. |
| `anon` / `authenticated` | `SELECT` refused, and `anon`'s inherited `TRUNCATE` refused. Zero grant rows for either. |
| Postgres log | **11 `permission denied` entries, all historical.** The last was 2026-08-04 12:21:24 UTC, over five hours before the grants were applied. **Zero since.** |

**Production data after the run — unchanged:** 2 products, 6 orders, 1 order
item, 2 carts, 1 wishlist, 1 discount code, 0 jobs, 0 tasks, 0 files, 0 events,
0 `staff.production.*` audit events, 36 migrations.

### What could not be verified, and why

**A signed-in staff session was not driven.** Reaching the queue as a real staff
member means handling a password, which is out of bounds for an automated
session — the same limit passes 3, 4 and 5 recorded. What was done instead is
strictly stronger than a page screenshot at the database layer and strictly
weaker at the UI layer: the exact queries the routes run were executed against
the real production database as the exact role the routes use, and all passed.

**Still worth one owner check, two minutes:** sign in as staff, open
`/staff/production` — it should render the polished empty state, not an error —
then raise a job and confirm it is numbered `JOB-0001`.

## Job files — storage design, not built

`production_job_files` records *references* (a label plus `storage_path` or
`external_url`), with `is_customer_visible` off by default and a check
constraint that a row must point at one or the other. It does not accept
uploads, and **no bucket was created** — that was explicitly held for approval.

The design when it is wanted: a **private** bucket (`production-job-files`), never
public; no direct client upload — a staff API route with `production.manage`
issues a short-lived signed upload URL, and reads go through short-lived signed
download URLs rather than public links; storage RLS keyed on `is_staff_user()`
so a leaked path is not a leaked file; paths namespaced by job id. That is a
route, a bucket, and a storage policy — none of it exists yet, and none of it
should be created without a decision on retention and file-size limits.

---

# Pass 6 — storefront, navigation and product-detail redesign

Branch `storefront-navigation-product-detail-20260804`, from `e2f2a9b`.

The brief: rebuild the customer-facing storefront so it reads as a premium
ecommerce and custom-manufacturing site rather than the forum template it grew
out of. Navbar information architecture, a complete product-detail redesign,
catalog consistency, mobile behaviour, Appearance integration, accessibility.

## What the audit found

The forum origins were structural, not cosmetic.

**Navigation.** The desktop bar centred the logo between two halves of the
navigation — About / Capabilities / Projects · KM · Catalog / Contact /
Community. That is a masthead: it reads as a community with a shop attached.
Community held prime position; "Catalog" was the word for the shop. The utility
cluster carried search, wishlist, cart, a message bell, a notification bell, an
account pill and a role-coloured staff pill — measured at 495px on a staff
session, which is what caused the pass-4 overlap.

There was **no account menu at all**: `/account` was a bare link, so Orders,
Requests, Wishlist and Sign out had no home in the navigation. The mobile panel
was a `max-h-96` height transition on a plain `<div>` — not a dialog, no focus
trap, no scroll lock, and it **hard-coded a second copy of the navigation** that
had already drifted from the desktop one: no Wishlist, no Orders, no search.

**Product page.** A client component that fetched its product in a `useEffect`.
First paint was the word "Loading…"; a crawler or link preview got nothing. It
bypassed `productImages.ts` and used raw `<img>` with its own `media.filter()`,
so it could disagree with the catalog about which photograph is the cover. No
breadcrumb, no category, no SKU, no structured content, and four hard-coded
information cards — "Lead time", "Pricing basis", "Customization", "Before
payment" — that rendered on every product whether or not there was anything to
put in them. Three of the four were static prose.

**Catalog.** Also client-fetched. Filters were bare `<select>` elements on a
page where every other dropdown is a `MenuSelect`, and the category list was
derived from the legacy free-text `products.category` column rather than from
`product_categories`, so it was whatever strings happened to be in use.

No category routes exist. That remains true — see deferred work.

## Phase 1 — navigation — complete

**Logo left, not centred.** A centred logo forces the navigation to split around
it, which is what made the bar symmetric and fragile: the pass-4 overlap came
from two side columns being forced to equal widths. One flexible column between
two content-sized ones removes that class of bug.

Primary navigation is **Products, Custom Projects, Gallery, About**.
Capabilities, the design guide, Contact and Community move into a More menu.
**Community keeps every route it had** — it is reachable from More, the mobile
drawer and the footer.

Utilities are **Search, Wishlist, Cart, Notifications, Account**. Messages and
staff access moved inside the account menu; the trigger carries an unread dot,
so nothing became undiscoverable. Staff access is deliberately not in the
customer link row: there it reads as a store category to every customer who
cannot use it, and its role colour made it the loudest thing in the header.

`src/lib/navigation.ts` is the one definition, read by the desktop bar, the More
menu, the drawer, the account menu and the footer. A test asserts no customer
href is hard-coded in `SiteHeader` any more.

The drawer is a real dialog: focus trap, focus restoration, body-scroll lock
that preserves the scroll position, `100dvh` bound, internal scrolling,
safe-area padding, 44px rows.

**One bug that only measurement finds.** The drawer rendered **60px tall** with
its list clipped away. The header carries `transition-transform` for auto-hide,
and a transformed ancestor becomes the containing block for `position: fixed`
descendants (CSS Transforms L1 §3) — so `inset: 0` resolved against the bar
rather than the viewport. Fixed with a portal onto `document.body`; a test
asserts both the portal and that the header still transforms, so the fix cannot
be removed as redundant.

`NavMenu` is one implementation for every dropdown. Its first cut threaded an
`itemProps(index)` render prop and asked each caller to declare its item count —
a hand-maintained number sitting a hundred lines from the markup it described,
which the account menu already had to remember to increment for Sign out. It now
queries `[role="menuitem"]` out of the open panel, which cannot disagree with
what was rendered.

**Appearance.** Six new tokens: navbar hover background and text, badge
background and text, menu background and text. Count badges previously borrowed
the *utility hover* colours, so darkening the search button's hover silently
dulled the cart count with it. The notification panel stopped hard-coding zinc
borders and amber hovers. A test asserts every hex in the navbar CSS is a
`var()` fallback, and that a `theme_config` saved before this pass keeps its
values while the new keys fall back to defaults.

## Phase 2 — product-detail — complete

**Server-rendered, through the anon key rather than the service role.** That is
deliberate on two counts: RLS becomes a second guard behind every filter, so a
missing `.eq("is_published", true)` returns nothing rather than serving a draft;
and the query is exercisable locally, because the deliberately fake
service-role key in `.env.local` is what made passes 3, 4 and 5 each record
"the data path could not be verified here". `src/lib/supabasePublicServer.ts`.

- Gallery: 4:3 box reserved before load, vertical thumbnails from `lg` and a
  horizontal scroller below, pointer-position zoom (disabled under reduced
  motion and on coarse pointers), fullscreen dialog with focus trap and arrow
  keys, keyboard-navigable thumbnails, fall-forward through broken URLs. It does
  **not** resolve images itself — the page passes them in, resolved by
  `productImages.ts`.
- Purchase panel: options, quantity, wishlist, share, validation that moves
  focus to the offending group.
- Structured sections on native `<details>`: keyboard operable and correct to a
  screen reader before hydration, deep-linkable via `:target`. Empty sections
  never render, so a sparse product gets a short page rather than a broken one.
- Quick-information row built only from facts that are set.
- Mobile sticky action, mirroring whichever primary action the product offers.

**Purchase modes.** `request_only` never renders a cart control, and the wizard
owns configuration — rendering the option groups in the panel *as well* would
ask for a material twice, in two controls that do not talk to each other. An
option value flagged `requires_request` swaps Add to Cart for the request action
and names the choice that did it, rather than leaving a disabled button.

A pricing inconsistency was found and fixed on the way: the card said "From
$20.00" for a priced request-only product while the page said "Priced after
review". The page now agrees with the card and keeps the caveat on the line
below.

### Migration `20260804030000_product_detail_content.sql`

Additive: 14 columns on `products`, all nullable or defaulted, plus three
CHECKs. No table, column or existing constraint is altered.

Columns rather than five new tables (benefits, specifications, compatibility,
included, FAQ). These are ordered display blocks, always read whole with the
product and never queried independently — and, per the pass-5a outage, a *new*
table that ships without explicit grants is unreadable by every PostgREST role,
because this database's default privileges carry no SELECT. **A column addition
inherits the table's ACL, so that failure mode is unreachable here.** The
migration issues no grants at all, and a test asserts it.

`detail_content` is `jsonb` with a `jsonb_typeof(...) = 'object'` CHECK — the
floor, not the specification. `src/lib/commerce/productContent.ts` is the one
gate every reader goes through: it is total (any input yields a valid empty
structure), drops blank rows, and truncates on read so a row written before any
editor limit still renders bounded.

**Dry run against production, rolled back:** 39 columns, 3 checks, both live
rows valid on the defaults, and all three constraints verified to actually
refuse a negative weight, an unknown difficulty and a JSON array. Production
confirmed untouched afterwards — 25 columns, 36 migration rows.

Staff editor at `/staff/catalog` covers every field. Nothing in it can clear
`description` or `short_description`, and none of it gates publishing.

## Phase 3 — catalog, homepage, footer — complete

- `/catalog` server-rendered; filtering stays client-side, which is correct for
  a list already in memory.
- Categories from `product_categories`, with a parent including its children.
- `MenuSelect` throughout; zero native selects.
- "Customizable only" became a purchase-type filter — buy now / buy or
  customize / quoted — which is the distinction a customer shops on.
- Auto-fill grid, so a two-product catalog does not leave a third of a row empty.
- Footer rebuilt around the business: Shop, The shop, Support, carrying the
  policy pages a customer looks for before committing. Three *named* nav
  landmarks. Community lands here as a secondary destination.
- Homepage drops the forum vocabulary: "From the catalog" becomes Products,
  "Projects" becomes Gallery.

No fabricated counts, ratings, urgency, scarcity or testimonials. The catalog
count is a count of what is on screen. No star rating is rendered anywhere:
`product_reviews` exists but holds zero rows and has no UI, so a star row would
be decoration standing in for data that does not exist. A test asserts it.

## Validation

- **593 tests pass, 0 fail** (537 before; 56 added across `product-detail` and a
  rewritten `navbar-layout`).
- Typecheck clean. Production build clean, exit 0.
- **Lint improved: 332 problems, from the 350 baseline** (178 errors, 154
  warnings). The drop is the deleted client product page and message bell. All
  new files lint clean.
- Browser-verified at **320, 375, 480, 768, 1024, 1152, 1280, 1366, 1440, 1920**
  with a signed-in staff cluster simulated (99+ badges, a long account name):
  zero overlaps, zero clipping, no horizontal overflow at any width.
- Menus: ArrowDown opens and focuses the first item, End jumps to the last,
  ArrowDown wraps to the first, Escape closes and restores focus to the trigger.
- Drawer: dialog semantics, focus to Close on open, body locked at the scroll
  offset, last row reachable by scrolling, Escape restores focus and scroll.
- Gallery: thumbnail click and arrow keys, 3D model view, fullscreen dialog with
  `object-fit: contain`, arrow keys inside it, Escape restoring focus and
  unlocking the body.
- Product page against **real production data**, both live products: correct
  badges, prices, actions, quick facts, breadcrumb with category, and empty
  sections hidden.
- Accessibility on the product page: one h1, no heading-level skips, no image
  without alt, no control without an accessible name, named landmarks.
- Reduced motion, `safe-area-inset`, and `100dvh` confirmed **in the served
  CSS**, not just the source.

### What could not be verified here, and why

- **The mobile sticky bar's reveal.** `IntersectionObserver` delivers no
  callbacks in a browser pane that is not compositing frames — confirmed by
  observing an element that was demonstrably on screen. This is environmental,
  not a code defect, and the failure mode is safe: the bar stays hidden and the
  real buttons still work. The rule it would have checked is asserted directly
  as a pure function instead.
- **A signed-in customer or staff session.** Unchanged limitation from passes
  3–5: signing in means handling a password. The staff cluster was simulated at
  DOM level with real dimensions.
- **Browser zoom at 125% and 150%** was not driven directly. It is equivalent to
  a narrower CSS viewport (1280 becomes 1024, then 853), which the width matrix
  covers.

## Deferred, and why

- **Category routes** (`/catalog/category/[slug]`) still do not exist. The
  breadcrumb and the footer link to `/catalog?category=…`, which the catalog
  reads and applies. Real routes are a separate piece of work with their own
  metadata and canonical-URL decisions.
- **Reviews.** Tables exist, zero rows, no API and no UI. The product page
  deliberately renders nothing rather than an empty five-star row.
- **Returns, cancellations, support, tax, shipping integrations, reporting,
  imports/exports** — all explicitly out of scope for this pass.
- The 2.2 MB 1920×1080 PNG cover noted in pass 4 is still uncompressed at the
  source. The optimizer handles it on every surface.

### Pre-existing, unchanged

- The `data-motion` hydration mismatch on the root `<html>`.
- The site broadcast banner's Dismiss button is 20×20, under WCAG 2.2 AA's 24px
  minimum. Outside the storefront and outside this pass.
- Guest checkout remains unrepresentable: `orders.customer_id` is `NOT NULL`.

---

# Pass 6a — product content editor repair

Branch `product-content-editor-repair-20260804`, from `edf78c3`.

Reported: on `/staff/catalog`, every Add button in the structured product
content editor did nothing when clicked — benefits, specifications,
compatibility, included items and FAQ alike.

## Root cause

**The editor used the storage-layer parser as its state reducer.**

`ProductContentEditor`'s `setList` rebuilt editor state by running
`parseDetailContent` on every mutation. That function is a *boundary* function:
it runs when content is read out of `products.detail_content` and again when it
is written back, and it deliberately drops incomplete rows so the product page
never renders a "Specifications" heading over nothing.

A freshly added row is blank. So the parser deleted every row the Add buttons
created, in the same tick it was created. Reproduced before any edit, against
the real parser:

| Click | Result |
|-------|--------|
| Add a benefit | `[]` |
| Add a specification | `[]` |
| Add compatibility entry | `[]` |
| Add included item | `[]` |
| Add a question | `[]` |

Deterministic, and in the state layer. The hypotheses in the brief were checked
and **ruled out**: every button was already `type="button"`; the editor is not
inside the create-product form and there are no nested forms (1 form on the
page, 0 nested); both files carry `"use client"`; the Add button hit-tests to
itself with `pointer-events: auto` and nothing overlapping; `disabled` is only
the legitimate `catalog.manage` gate.

The same one line caused three more failures, all worse than the reported one:

1. **The FAQ list was destroyed by a single keystroke.** `setList` passed FAQ
   rows back through the parser as `{title, body}` while the parser reads FAQs
   as `{question, answer}`, so every row parsed to blank and was filtered out.
   Typing one character into a saved question emptied the whole list — and a
   subsequent Save would have written the empty list back.
2. **A space could not be typed.** The parser trims, and it ran on every
   keystroke, so `"Shift "` became `"Shift"` and the next character produced
   `"Shiftk"`. No multi-word value was enterable in any list field.
3. **A specification vanished mid-edit.** Clearing either half to retype it
   dropped the row, because a spec needs both halves to survive parsing.

## A second, independent defect found while testing

**Every FAQ staff saved was silently discarded on the next read.**

`serializeDetailContent` returned the *in-memory* type, so it wrote FAQ rows to
the column under `title`/`body`. `parseDetailContent` reads that column looking
for `question`/`answer`. A saved FAQ therefore came back empty — invisible on
the product page, gone from the editor on reload. Benefits were unaffected,
because their in-memory and stored keys happen to be identical.

The round-trip test that should have caught this compared the serializer's
output against editor state instead of re-parsing it. Both sides held FAQs as
`title`/`body`, they agreed with each other, and neither agreed with the
database. That test now goes through `JSON.parse(JSON.stringify(...))`, as
`jsonb` does, which is what makes it able to fail.

**No production data was lost to this.** Both products hold zero FAQ rows, so
the bug would have eaten the first FAQ anyone saved, not any existing content.

## A third defect, found only in the browser

**A double-click on Add produced one row, not two.** Every handler derived from
the `content` prop captured at render, so two activations inside one React batch
both computed from the same starting point and the second overwrote the first.
Measured live: two clicks gave one row; five different Add buttons in one tick
gave one row in total.

`onContentChange` now takes an **updater** rather than a value, so each change
composes on the latest state. The page already passed `setContent` straight
through, and `useState`'s setter accepts updaters, so no page change was needed.
Re-measured after the fix: double-click gives two rows; five Adds in one tick
give five rows, one per list.

## The fix

**`src/lib/commerce/productContentEditing.ts` (new).** Pure, dependency-free
editor-state operations: `addRow`, `updateRow`, `removeRow`, `moveRow`,
`replaceList`, plus the per-list wording and the incomplete-row predicates. One
rule runs through all of it: **editor state is verbatim.** What staff typed is
what is held, spaces and blank rows and all. Normalization happens exactly
twice — reading from the column, and `serializeDetailContent` on save — and
never in between.

`replaceList` is the single write path and carries the four untouched lists
across *by reference*, which makes "adding a benefit reset my FAQs" structurally
impossible rather than merely tested for.

**Rows are capped at the parser's own limit.** `addRow` refuses at 60 and the
button says why, instead of appending a 61st row that a save would discard.
Field lengths are capped at the same numbers the parser truncates at, exported
from `productContent.ts` as `CONTENT_LIMITS` so there is one copy of each.

**Empty rows are refused out loud.** Dropping incomplete rows on save stays —
an unlabelled specification has nothing to render — but each list now says what
will not be saved and why, before Save is pressed. A test pins the count to what
`serializeDetailContent` actually removes, so the notice cannot drift from the
behaviour it describes.

**Accessible names.** Both entry lists previously rendered a button reading
"Add an entry", so fitment and included-items were indistinguishable to a screen
reader, and `aria-label="Remove this entry"` was repeated identically on all
fifteen rows. Every control now names its list and its 1-based position: "Move
benefit 2 up", "Remove included item 1". The first row's up arrow used to be
labelled "Move to position 0", a position that does not exist.

**Focus follows a new row.** The added row's field does not exist when the
button is clicked, so the target is parked in a ref and claimed by that field's
own ref callback as it mounts — no state, no effect, no extra render.

**`ListControls` moved to module scope.** A component declared in a render body
is a new type every render, so React remounted it and threw away focus the
moment a control was used. ESLint's `react-hooks/static-components` caught the
same mistake being reintroduced as an `AddButton` component mid-fix; it is a
function returning elements now.

## Files changed

- `src/lib/commerce/productContentEditing.ts` — new
- `src/components/staff/ProductContentEditor.tsx` — rewritten mutation path
- `src/lib/commerce/productContent.ts` — `StoredDetailContent`, the FAQ wire
  shape, exported limits, and a parser that reads either FAQ key pair
- `tests/product-content-editor.test.ts` — new, 40 tests
- `tests/product-detail.test.ts` — the round-trip assertion made able to fail

`src/app/staff/catalog/page.tsx` is **unchanged**. No schema change, no
migration, no new dependency, no permission touched.

## Validation

- **633 tests pass, 0 fail** (593 before; 40 added).
- Typecheck clean. Production build clean, exit 0.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings). The new
  code lints clean.
- The new suite was confirmed to **fail against the shipped build**: 9 of 38
  failed against `edf78c3`'s component — including "the editor never re-parses
  its own state", which is the root cause stated as an assertion — and the FAQ
  persistence tests failed against `edf78c3`'s `productContent.ts`.

### Driven in a real browser, against the live editor

Dev server, `/staff/catalog`, with staff permissions seeded into the React Query
cache and both real products loaded through the anon key. **Nothing was saved,
and production data is unchanged** — verified afterwards against the database:
both products still hold zero benefits, specs, compatibility, included items and
FAQs, with their original `updated_at`.

| Check | Result |
|-------|--------|
| All five Add buttons | **Pass.** Each adds exactly one row. |
| Focus after Add | **Pass.** Lands on the new row's first field, all five lists. |
| Multi-word typing | **Pass.** "Machined billet", "M10 x 1.25" — spaces kept. |
| Second row added | **Pass.** First row's values untouched. |
| Cross-list isolation | **Pass.** Four lists unchanged through every operation. |
| Reorder | **Pass.** Move up, move back; only the intended list moved. |
| Remove first / middle / last | **Pass.** Only the intended row; values travel with their own row. |
| Double-click Add | **Pass** (after the updater fix). Two rows. |
| Incomplete-row notices | **Pass.** Correct and specific per list. |
| Hit test on Add | **Pass.** Resolves to the button, `pointer-events: auto`. |
| Forms | **Pass.** Editor is outside the create-product form; 1 form on the page, 0 nested. |
| Button types | **Pass.** All 24 editor buttons are `type="button"`. |
| Tab order | **Pass.** title, Remove, description, Add, then the next list. Disabled arrows correctly skipped. |
| Console | Only the **pre-existing** `data-motion` hydration mismatch, which reproduces on `/`, plus a local 503 from the deliberately fake service-role key. Nothing from the editor. |

### What could not be verified here, and why

- **Enter/Space activating a button.** Proven environmental, not a code defect:
  a plain native `<button>` injected as a control received a **trusted** Enter
  keydown and still registered zero clicks, so this pane does not dispatch the
  browser's default activation. Tab navigation *does* work and was used. What
  makes keyboard activation correct is asserted instead: every control is a real
  `<button type="button">`, with no `tabindex` and no `role="button"` stand-ins.
- **Screenshots.** The pane was not compositing frames. The rendered state was
  captured from the DOM instead.
- **A real save as a signed-in staff member.** Unchanged limitation from passes
  3 to 6: signing in means handling a password.

## Noticed, not acted on

Thirteen buttons elsewhere on `/staff/catalog` — Save changes, Duplicate,
Archive, Delete permanently, Add option, the media and option controls — carry
no explicit `type`, so they default to `submit`. All of them are currently
**outside** any form, so nothing can be submitted and there is no live defect.
It is the exact hazard the brief named, one refactor away from mattering.
Outside this repair; flagged separately.

---

# Pass 7 — order lifecycle: cancellations, refunds, returns

Branch `order-lifecycle-cancellations-refunds-returns-20260805`, from `bbf2b57`.

## Scope decision, and why

The brief asked for sixteen phases: state normalization, cancellations,
refunds, returns, shipping and fulfillment, inventory, discount restoration,
Stripe Tax, ~40 transactional emails, staff and customer UI, policy settings,
printable documents, audit, reconciliation, security review and validation.

**The audit found three live financial defects, not just missing features.**
That changed what "largest coherent deployable lifecycle" meant.

1. **A refund could be issued twice for the same money.** The webhook handled
   no refund events at all, so a refund issued from the **Stripe Dashboard**
   never reached this database: `orders.amount_refunded_cents` stayed where it
   was, and the staff refund form would happily send the same amount again.
2. **A refund was recorded as complete because the API call returned.**
   `order_refunds` had no status column; the route called Stripe and, on a
   resolved promise, wrote the accounting. A Stripe refund can come back
   `pending` and settle later, and it can fail after acceptance. "We asked" was
   being stored as "it happened", with no state that could ever say otherwise.
3. **Direct-purchase checkout never touched inventory.** `create_checkout_order`
   decrements stock for the *custom request* path, but `/api/cart/checkout`
   writes its order directly and moves nothing. A tracked product could be
   bought any number of times without its count changing.

Alongside those: customers could not cancel an order at all — no route, no UI,
nothing — and returns did not exist in any form.

The brief's own fallback ordering is cancellations and refunds, then returns,
then fulfillment, then inventory, then tax, then emails. **This pass completes
the first three in full, plus the inventory commit/restore loop those two
depend on to be correct.** Shipping configuration, the full inventory
management surface, Stripe Tax and the complete email catalogue are deferred
and specified below.

Going breadth-first would have left every financial workflow half-wired, which
the brief explicitly forbids — and would have left the double-refund hole open.

## Phase 1 — state model — complete

**Five independent state fields, not one enum.** An order can be paid, in
production, carrying an open cancellation request and partly returned at the
same moment. A single `status` column needs a value per combination and is
still wrong the first time a new combination happens.

`orders.status` is **unchanged**: same eleven values, every existing reader
keeps working. The new columns answer the questions it was being asked to
answer as a side effect.

| Field | States |
|-------|--------|
| `payment_status` | not_required, unpaid, payment_pending, partial, paid, partially_refunded, refunded, payment_failed, payment_canceled |
| `fulfillment_status` | not_required, unfulfilled, processing, ready_for_pickup, picked_up, shipped, delivered, returned, partially_returned |
| `cancellation_status` | none, requested, under_review, approved, denied, withdrawn, refund_pending, refund_failed, completed |
| `return_status` | none, requested, under_review, approved, denied, awaiting_shipment, in_transit, received, inspected, refund_pending, completed, closed |
| `order_refunds.status` | pending, succeeded, failed, canceled |

**Two states the old `payment_status` was forced to lie about.** A partly
refunded order read as plain `paid`. A declined async payment left it `unpaid`,
with no way to tell "never tried" from "tried and was refused". The CHECK is
only **widened** — every previously legal value stays legal, so no stored row
can fail it, and a test asserts exactly that.

Production reuses the existing thirteen production-job states from pass 5
rather than inventing a parallel set.

### Transition graph

Defined once in `src/lib/commerce/orderLifecycle.ts` and imported by the
routes, both UIs and the tests, so none of them can hold a different opinion.

**Fulfillment moves forward only.**

    not_required     -> unfulfilled
    unfulfilled      -> processing | not_required
    processing       -> ready_for_pickup | shipped
    ready_for_pickup -> picked_up | shipped
    picked_up        -> returned | partially_returned
    shipped          -> delivered | returned | partially_returned
    delivered        -> returned | partially_returned
    partially_returned -> returned
    returned         -> (terminal)

A shipped order silently becoming "unfulfilled" is how a second label gets
printed for a parcel already in the post, so backward moves are not in the
graph at all. A mistake is corrected by editing the tracking details, which is
audited.

**Returns.**

    requested         -> under_review | approved | denied
    under_review      -> approved | denied
    approved          -> awaiting_shipment | in_transit | received
    awaiting_shipment -> in_transit | received | closed
    in_transit        -> received | closed
    received          -> inspected
    inspected         -> refund_pending | completed | closed
    refund_pending    -> completed | closed
    completed         -> closed
    denied, closed    -> (terminal)

`received` cannot be skipped on the way to `inspected` — the receipt is what
proves the parcel actually arrived. `denied` is terminal: a denied return
cannot silently reopen, and asking again means a new row with its own reason
and timestamp.

**Cancellation requests.**

    pending   -> approved | denied | withdrawn
    approved  -> completed | failed
    failed    -> completed        (a failed refund can be retried)
    denied, withdrawn, completed -> (terminal)

### Snapshots

`order_return_items` copies `product_name` and `unit_price_cents` at request
time. What was returned has to stay describable after the product is renamed,
repriced or deleted. `order_returns.return_address` is snapshotted at approval:
a later change to the shop's address must not redirect a parcel already in the
post.

## Phase 2 — cancellations — complete

Two paths, chosen server-side from live rows by `evaluateCancellation`.

**Unpaid and eligible → cancelled immediately.** There is no money to unwind
and nothing for staff to weigh up. Inventory is released, the discount
redemption is returned according to policy, and the event is recorded as a
completed request so the order's history reads the same whichever path
cancelled it.

**Paid → a request.** The customer never triggers a refund. Approving one is a
staff decision, and whether it carries a refund is a separate choice within it.

Eligibility considers order type, payment state, fulfillment state, production
state (read from the linked `production_jobs`), materials commitment, custom or
personalized status, and a configurable unpaid window. A shipped or delivered
order is refused and pointed at returns instead.

**Duplicate prevention is structural.** A partial unique index on
`order_cancellation_requests(order_id) where status = 'pending'` means two
tabs, a double click and a retried fetch all collapse to one row — the loser
gets `23505`, not a second request. Withdrawing and deciding are both
conditional on `status = 'pending'`, so anything that landed in between matches
zero rows instead of overwriting it.

**A denial requires a customer-visible reason**, and it is exactly what the
customer is shown. The internal note is a separate column that the customer
endpoint does not select at all.

## Phase 3 — refunds — complete

Rewritten from "call Stripe and hope" to a two-phase settlement.

1. **`begin_order_refund`** locks the order, recomputes what is refundable, and
   inserts one `pending` row per payment the refund draws from, each with its
   own idempotency key. It refuses outright if the amount exceeds what is left.
2. The route calls Stripe once per leg, passing **the same key** as Stripe's own
   idempotency key, so a retried fetch cannot create a second refund on either
   side.
3. **`settle_order_refund`** writes Stripe's answer. It is the only place
   `orders.amount_refunded_cents` grows, and it is a no-op on a refund that is
   not still `pending`.

**Refundable subtracts pending refunds as well as settled ones.** Money handed
to Stripe and not yet confirmed is already committed; counting it as available
is exactly how one order gets refunded twice by two people reading the same
screen.

**A Stripe exception releases the claim.** An unreleased hold would block every
later refund on that order forever, so the failure path settles the leg as
`failed` rather than leaving it pending.

**`reconcile_stripe_refund` adopts refunds this application never created.**
The webhook now handles `refund.created`, `refund.updated`, `refund.failed` and
the older `charge.refund.updated` — which one an account receives depends on
its API version — so a Dashboard refund lands in the local accounting instead
of leaving a hole the refund form would fall into.

**`refunds.issue` is its own permission.** Refunds used to need
`orders.manage`, which meant anyone who could update a tracking number could
also send money out. It is granted to no non-admin role by default.

The old `record_stripe_order_refund` RPC is left in the database (dropping it
would not be additive) but **nothing calls it any more**, and a test asserts
the route does not.

## Phase 4 — returns — complete

Customer: choose eligible items and quantities, pick a reason, submit; then
watch the decision, the instructions, the receipt, the inspection and the
refund. The response never promises a refund and the confirmation says so.

Staff: review, approve or deny with a customer-visible reason, set per-line
approved quantities, issue instructions and a snapshotted return address, mark
awaiting shipment / in transit / received with per-line received quantities and
condition, then inspect — choosing the outcome, whether stock goes back, and
whether to refund and how much.

**Custom and personalized products are excluded by default** rather than
inheriting the catalogue's 30-day rule. A bespoke part cannot be resold, and
`allowCustomProducts` is off unless the owner turns it on.

**Quantities are validated inside `create_order_return`**, under a row lock,
summing existing returns that are neither denied nor closed. Doing that check
in a route would leave a window between the read and the insert wide enough to
return the same item twice from two tabs.

**Stock returns only at inspection, and only on an explicit decision.**
Restocking at approval would put a part back on the shelf that is still in the
post; restocking damaged goods would oversell the next customer.

## Inventory — commit and restore loop only

Not the full Phase 6. What was built is what cancellations and returns need to
be correct, and it closes the overselling hole.

`inventory_adjustments` gives stock a history: delta, before, after, reason,
actor, and a reference to the order, item, return or cancellation.
`adjust_product_inventory` is the only writer of `products.inventory_quantity`
— one statement reads, changes and records, under a row lock.

- **Committed** at confirmed payment, keyed per order item, so a webhook
  delivered five times decrements once.
- **Restored** on cancellation, reading the *ledger* for what was actually
  committed rather than the order lines — an order that never decremented stock
  cannot invent it.
- **Restocked** on return inspection, once per line.

A made-to-order or unlimited product is skipped rather than driven negative,
and that is reported as a normal outcome, not an error.

**Reservation at checkout is deliberately deferred.** Committing at checkout
would hold stock for every abandoned Stripe session, which needs expiry,
sweeping and abandoned-checkout handling to be safe. Committing at confirmed
payment means stock moves exactly when the money does. The tradeoff is honest:
**two customers can both check out the last unit**, and the second one's
payment succeeds. Reservations with expiry are the fix and are specified below.

## Discount restoration

`release_order_discount` deletes the redemption row *and* decrements
`total_uses`, rather than only lowering the counter. A code capped at one use
per customer has to stop counting the cancelled order, not merely free a global
slot. It is guarded on the row still existing, so calling twice restores once.
Staff choose whether to release it as part of approving a cancellation.

The first-order-only check in `cartService` was fixed at the same time: it
counted only `payment_status = 'paid'`, so any earlier partial refund would
have let a one-per-customer code be used a second time.

## Policy settings

`site_settings.commerce_policy` (jsonb, defaulted) holds cancellation, return
and inventory rules in one place instead of spelling them out in each route.
`parseCommercePolicy` is **total** — any input at all yields a usable policy —
because the column has only an object CHECK behind it and a hand-edited row
must not be able to take cancellations offline.

Defaults are deliberately conservative: custom work is not returnable, the
return window is 30 days, materials-committed blocks online cancellation.
**No staff editing surface was built for this yet** — see deferred work.

## Files changed

New:

- `supabase/migrations/20260805010000_order_lifecycle_cancellations_refunds_returns.sql`
- `src/lib/commerce/orderLifecycle.ts` (pure), `orderLifecycleServer.ts` (server)
- `src/app/api/orders/[id]/cancellation/route.ts` (POST, DELETE)
- `src/app/api/orders/[id]/returns/route.ts`
- `src/app/api/orders/[id]/lifecycle/route.ts`
- `src/app/api/staff/orders/[id]/cancellation/route.ts`
- `src/app/api/staff/orders/[id]/returns/[returnId]/route.ts`
- `src/app/api/staff/orders/[id]/lifecycle/route.ts`
- `src/components/staff/OrderLifecyclePanel.tsx`
- `src/components/commerce/OrderLifecycleActions.tsx`
- `tests/order-lifecycle.test.ts`, `order-lifecycle-schema.test.ts`,
  `order-lifecycle-routes.test.ts`

Modified:

- `src/app/api/staff/orders/[id]/refund/route.ts` — rewritten
- `src/app/api/webhooks/stripe/route.ts` — refund events, inventory commit,
  `payment_failed`
- `src/lib/permissions.ts` — seven permissions plus metadata
- `src/lib/commerceEmail.ts` — twelve template keys
- `src/lib/commerce/rateLimit.ts` — two buckets
- `src/lib/orderHub.ts`, `src/lib/commerce/cartService.ts`,
  `src/app/staff/orders/[id]/page.tsx` — `payment_status` readers corrected
- `src/app/orders/[id]/page.tsx` — lifecycle actions mounted
- `tests/payment-monitoring.test.ts`, `tests/v1-business-safety.test.ts`

## Permissions

`fulfillment.view`, `fulfillment.manage`, `cancellations.review`,
`returns.review`, `refunds.issue`, `inventory.view`, `inventory.manage`.

Reading, deciding and paying are separated on purpose: a shop hand who updates
tracking should not thereby be able to refund a customer. **Admins get all of
them automatically** (`loadPermissionsForUser` returns the full set for
`admin`). **No non-admin role has any of them** until one is granted in
`/staff/security/roles`.

## Validation

- **756 tests pass, 0 fail** (633 before; 123 added across three suites).
- Typecheck clean. Production build clean, exit 0; all seven new routes present.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings). New code
  lints clean.
- Vercel **preview build: success**.

### Concurrency and idempotency, against real Postgres

Run against the **production database** as `service_role`, inside a transaction
ended with a sentinel exception to force rollback. Every check passed:

| Check | Result |
|-------|--------|
| Commit inventory | 10 → 7 for a quantity-3 order |
| **Replayed webhook** (2nd and 3rd commit) | **no further decrement** |
| Pending hold honoured | with $50 pending on $300 paid, refundable read $250 and a $260 refund was refused |
| **Duplicate idempotency key** | returned the *same* refund row; `order_refunds` count stayed at 1 |
| Money before Stripe confirms | `amount_refunded_cents` = 0 after the claim |
| Settle | $50 applied, `payment_status` → `partially_refunded` |
| **Repeated settle** (webhook replay) | no-op, no double count |
| Second partial | $150 total |
| Refund beyond remaining | refused |
| **Failed refund** | marked `failed`, moved no money, **released its hold** so a retry was accepted |
| **Dashboard refund** | adopted by `reconcile_stripe_refund` → $200 total, and idempotent on redelivery |
| Return created | `RMA-0001` from the sequence |
| Second open return | refused |
| Over-quantity return | refused (2 of 3 already spoken for) |
| Restock | 7 → 9, and idempotent |
| Cancellation restore | 9 → 12, and idempotent |

**Production verified untouched afterwards:** 6 orders, 2 products, 1 order
item, 0 refunds, 0 cancellation requests, 0 returns, 0 inventory adjustments,
no leftover test product. The return sequence was reset to 1 — `nextval` is not
transactional, so the rolled-back run had still consumed `RMA-0001`, and the
table is empty so the shop's first real return gets that number.

### Local browser

Dev server, unauthenticated. All eight lifecycle endpoints refuse correctly:

    GET    /api/orders/<id>/lifecycle          -> 401
    POST   /api/orders/<id>/cancellation       -> 401
    DELETE /api/orders/<id>/cancellation       -> 401
    POST   /api/orders/<id>/returns            -> 401
    GET    /api/staff/orders/<id>/lifecycle    -> 403
    POST   /api/staff/orders/<id>/cancellation -> 403
    POST   /api/staff/orders/<id>/refund       -> 403
    POST   /api/staff/orders/<id>/returns/<r>  -> 403

The refund route refuses **before** Stripe is reached. Console carried only the
pre-existing `data-motion` hydration mismatch and the local 503 from the
deliberately fake service-role key.

### Three existing tests updated, not weakened

Each asserted the *old* refund mechanics. All three were re-pointed at where
the property now lives and made **stricter**:

- `refund accounting is atomic…` — now also asserts the two-phase RPC pair and
  that `record_stripe_order_refund` is **absent** from the route.
- `Sentry covers every Next.js runtime…` — now asserts the shared
  `logLifecycleFailure` wrapper *and* that Postgres `details` is never logged.
- `staff refunds are permission checked…` — now requires `refunds.issue` and
  asserts `orders.manage` is **not** accepted.

## Migration application — 2026-08-05

Applied with approval through `execute_sql` in guarded transactions, **not**
`apply_migration` — that tool stamps its own timestamp as the version, which
caused six of the seven ledger drifts repaired in pass 3. The ledger row was
inserted by hand under the repository filename's version.

- **Before**: `order_cancellation_requests` absent; exactly 37 migration rows;
  orders/products/order_items at 6/2/1.
- **After**: 4 tables, 9 functions, 4 policies; 4 `service_role` SELECT grants;
  **zero** grants for `anon` or `PUBLIC`; 38 migration rows; 22 email
  templates; orders/products/order_items unchanged at 6/2/1.

All guards held. **The ledger is exact: 38 repo files, 38 rows, versions and
names identical.**

A follow-up transaction revoked `authenticated`'s inherited TRUNCATE,
REFERENCES and TRIGGER on the three customer-readable tables and granted back
only SELECT. TRUNCATE is not filtered by RLS, so a policy does not close it.

**Supabase security advisors: no new findings.** All four new tables have
policies, and none of the nine new SECURITY DEFINER functions appears in either
"executable by anon/authenticated" warning, because all nine are revoked from
both. Every listed finding is pre-existing.

## What could not be verified, and why

- **A signed-in customer or staff session.** Unchanged limitation from passes 3
  to 6: signing in means handling a password, which is out of bounds for an
  automated session. What was done instead is stronger at the database layer
  and weaker at the UI layer — the exact RPCs the routes call were exercised
  against the real production database as the exact role the routes use.
- **A real Stripe refund.** Reaching one needs a real paid order and a real
  card. The refund *arithmetic*, idempotency, hold release and reconciliation
  were exercised against real Postgres with synthetic payments; the Stripe API
  call itself was not made.
- **The populated staff and customer panels.** Both render from endpoints that
  need a session. Their rules are covered by the 123 new tests; the rendering
  of populated states is not.

## Deferred, with what already exists

1. **Shipping configuration and the fulfillment state machine.** The
   `fulfillment_status` column, its transition graph and its labels exist and
   are tested. What does not: flat-rate methods, free-shipping thresholds,
   supported destinations, origin address, package defaults, and staff controls
   that *write* `fulfillment_status`. Today fulfillment is still driven by the
   pass-1 `shipment_action` on `PATCH /api/staff/orders/[id]`, which sets
   `shipped_at`/`delivered_at` but not the new column. **Wiring that PATCH to
   the new state field is the single highest-value next step** and is a small
   change — the graph and the labels are already there.
2. **Inventory management surface.** The ledger, the atomic function and the
   commit/restore loop exist. No staff overview, low-stock view, manual
   adjustment form, CSV export or low-stock notification. No reservation at
   checkout — see the honest tradeoff recorded above.
3. **Stripe Tax.** Not integrated at all; no `automatic_tax` anywhere. Owner
   decision recorded on 2026-08-05: leave it out and document it rather than
   ship a disabled code path. What it needs: Stripe Tax enabled on the account,
   at least one tax registration, a product tax code per product, a decision on
   shipping tax behaviour, `automatic_tax: { enabled: true }` plus address
   collection on the Checkout Session, immutable tax snapshots on the order, and
   tax-aware refund arithmetic. **Stripe Tax does not handle registration or
   filing** — that is a business obligation, not a checkbox.
4. **The full email catalogue.** Twelve lifecycle templates were added and are
   sent idempotently. The brief lists roughly forty; production, fulfillment,
   payment-reminder and most staff-alert templates are not written. There is no
   staff preview-before-send and no resend control.
5. **Printable documents.** Packing slip, pickup slip, return authorization and
   refund record are not built. The print CSS foundation from pass 5 is in place.
6. **Reconciliation tooling.** `reconcile_stripe_refund` handles the webhook
   path. There is no sweep that walks Stripe for refunds whose webhook was
   missed, and no report comparing order totals against snapshots.
7. **Everything from pass 6's deferred list** — category routes, reviews,
   support tickets, Facebook auth, Turnstile, SEO structured data — unchanged.

## External setup still required

1. **Grant the new permissions** to whichever non-admin roles should use them,
   in `/staff/security/roles`. Admins already have all seven. **Be deliberate
   with `refunds.issue`** — it is the only permission that moves money out.
2. **Add the refund events to the Stripe webhook endpoint.** The handler is
   deployed, but Stripe only delivers what the endpoint is subscribed to. Add
   `refund.created`, `refund.updated`, `refund.failed` (or
   `charge.refund.updated` on an older API version) in the Stripe Dashboard.
   **Until this is done, the Dashboard-refund hole stays open** — the code can
   reconcile, but it will never be told there is anything to reconcile.
3. **Set the return address** in `commerce_policy.returns.returnAddress`. Until
   it is set, approving a return snapshots `null` and staff must type the
   address into the instructions each time. There is no editing UI yet, so this
   is a direct `site_settings` update.

## Owner decisions still required

- Cancellation window for unpaid orders (`unpaidWindowHours`, default 0 = no
  window).
- Whether production start blocks online cancellation
  (`blockAfterProductionStart`, default off; materials-committed is on).
- Return window (default 30 days) and whether custom work is returnable
  (default no).
- Who pays return postage (default customer) and whether a restocking fee
  applies (default 0%).
- Customer-facing policy text for `/refunds` and `/shipping`. **No legal policy
  was invented** — those fields are empty strings.

## Exact continuation steps

1. **Subscribe the Stripe webhook to the refund events** (item 2 above). This
   is the one step that leaves a real hole open until it is done.
2. **Wire `PATCH /api/staff/orders/[id]`'s `shipment_action` to
   `fulfillment_status`**, using `canTransitionFulfillment` from
   `orderLifecycle.ts`. Small, and it completes the state model end to end.
3. **Drive one cancellation and one return as a signed-in staff member.** That
   is the one path no automated session can reach.
4. Then pick up shipping configuration and the inventory surface, in that
   order — both now have their schema and their rules in place.

---

# Pass 8 — shipping, fulfillment, inventory reservations, commerce settings

Branch `shipping-fulfillment-inventory-reservations-20260805`, from `e207fc5`.

## Verified starting state — 2026-08-05

| Check | Result |
|-------|--------|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `e207fc5` |
| Baseline present | `e207fc5` is HEAD, the pass-7 merge |
| Production health | `/` 200, `/catalog` 200, `GET /api/cart` 200 |
| Migration ledger | **exact** — 38 repo files, 38 rows, versions and names identical |
| Refund webhook events | handler present: `event.type.startsWith("refund.")` covers `refund.created`, `refund.updated`, `refund.failed`, plus `charge.refund.updated` |

The owner has since subscribed the Stripe endpoint to the three refund events,
closing the item pass 7 recorded as external setup #2.

## Phase 1 — audit of what actually exists

Read from code, live schema, routes and grants — not from ledger labels.

### The three misleading migration names

`20260731170000_order_fulfillment`, `20260731180000_catalog_inventory_editor`
and `20260731190000_checkout_inventory_reservations` are all applied, and pass
4 recorded them as covering "shipping, inventory, fulfilment". They do not.

**`checkout_inventory_reservations` is not a reservation system.** It adds
`orders.checkout_token` and `orders.inventory_reserved_quantity`, and
`create_checkout_order` decrements `products.inventory_quantity` *immediately*
at custom-request order creation, restoring it by trigger on cancel/decline or
delete. There is no expiry, no sweep, no checkout-session link, and no
availability calculation. It is an eager decrement with a misleading name.

**`order_fulfillment` is shipment columns only** — `fulfillment_method`
(`shipping`/`pickup`), `shipping_address`, `shipping_carrier`,
`tracking_number`, `tracking_url`, `shipped_at`, `delivered_at`, plus two email
templates. No state machine, no price, no snapshots, no origin, no packages.

### Two inventory writers already exist, and they do not overlap

| Writer | Path | Moves stock |
|--------|------|-------------|
| `create_checkout_order` (pass 1) | custom request | at order creation, direct `update products` |
| `commit_order_inventory` (pass 7) | direct purchase | at confirmed payment, through `inventory_adjustments` |

They cannot double-count **because they cover disjoint order kinds**:
`order_items` rows are written only by `/api/cart/checkout`, so
`commit_order_inventory` finds nothing on a custom-request order, and
`create_checkout_order` is never called for a direct purchase. That is a real
invariant this pass must not break, not a coincidence to leave undocumented.

### Lifecycle map — cart to restoration, as built today

    cart add/update ........ no inventory check beyond display; no reservation
    checkout creation ...... prices revalidated from live rows; order +
                             order_items written; Stripe session created.
                             NO inventory movement. NO address. NO shipping
                             price. NO fulfillment method chosen.
    payment confirmed ...... record_stripe_order_payment, then
                             commit_order_inventory (idempotent per order item)
    checkout abandoned ..... nothing happens. Order stays awaiting_payment
                             forever; cart keeps its items
    session expired ........ NOT HANDLED — no `checkout.session.expired` case
    payment failed ......... payment_status = payment_failed; stock untouched
                             (none was held)
    repeated webhook ....... stripe_webhook_events unique on event id; the
                             accounting RPC and the inventory commit are each
                             independently idempotent
    production complete .... does NOT touch fulfillment_status
    cancellation ........... restores from the ledger, not the order lines
    return inspection ...... restocks per line, on an explicit decision

**The overselling window is real and open:** two customers can both check out
the last unit, and both payments succeed.

### Fulfillment state — the column exists and nothing writes it

`orders.fulfillment_status` (pass 7) defaults to `unfulfilled` and has a
transition graph and labels in `orderLifecycle.ts`. **No route writes it.**
Fulfillment is still driven by `shipment_action` on
`PATCH /api/staff/orders/[id]`, which sets `shipped_at`/`delivered_at` and
moves `orders.status`, and never touches the new column. Customer-facing
fulfillment state is therefore derived from timestamps, while the column that
the cancellation and return eligibility rules *read* stays at `unfulfilled`
forever — so a shipped order still looks cancellable to `evaluateCancellation`.

### Field-by-field audit

| Area | State |
|------|-------|
| Fulfillment states | enum + graph + labels exist; unwritten |
| Shipment data | carrier, number, url, shipped_at, delivered_at on `orders` |
| Local pickup | `fulfillment_method='pickup'` only; no location, no snapshot, no instructions |
| Shipping-address snapshot | `orders.shipping_address` jsonb — written only by the custom-request RPC; **null on every direct purchase** |
| Shipping prices | **nowhere.** No column on `orders`, no calculation anywhere |
| Product shipping fields | `weight_grams`, `dimensions_text`, `package_dimensions_text`, `shipping_notes`, `return_notes` |
| Product inventory fields | `sku`, `inventory_policy`, `inventory_quantity`, `low_stock_threshold` (default 2), `continue_selling_when_out_of_stock`, `made_to_order`, `lead_time_text` |
| Order fulfillment UI | staff: tracking fields + two shipment actions on the order page. customer: read-only timestamps |
| Inventory ledger | `inventory_adjustments` + `adjust_product_inventory` (pass 7) |
| Inventory reservations | **none** |
| Abandoned checkout | **none** |
| Low-stock behavior | threshold column only; nothing reads it |
| Commerce policies | `site_settings.commerce_policy` jsonb + total parser; **no editing surface** |
| Return address | `commerce_policy.returns.returnAddress`, unset |
| Shipping configuration | **none** |
| Transactional emails | `email_templates` + `email_deliveries` (unique `event_key`) + `sendCommerceEmail`; 22 templates; **HTML only, no plain text** |
| Staff notifications | `notifyOrderStaff` / `notifyOrderUser` |
| Printable documents | production traveller/work order/QC only |
| Audit events | `logAuditEvent` retains `staff.`-prefixed types; lifecycle events registered |
| Staff permissions | `fulfillment.view/manage`, `inventory.view/manage` exist from pass 7 **with nothing behind them** |

### Snapshots versus mutable references

`order_items` snapshots name, slug, options and price. `order_returns`
snapshots the return address at approval. Everything shipping-related is a
**mutable reference or absent**: there is no method snapshot, no price
snapshot, no origin snapshot, no package snapshot, and a direct-purchase order
carries no address at all. Order addresses cannot currently change after
purchase only because nothing writes them.

Tracking URLs are validated for `https://` prefix and nothing else — no host
allow-list and no template generation. Local pickup is a `fulfillment_method`
value with no data behind it. Production completion does not affect
fulfillment.


## Scope decision, and why

The brief asked for twenty phases. The audit above found that the three
migrations pass 4 recorded as covering "shipping, inventory, fulfilment" cover
none of it: `checkout_inventory_reservations` is an eager decrement with a
misleading name, `order_fulfillment` is seven columns, and the pass-7
`fulfillment_status` column had a graph, labels and **no writer**.

This pass completes the brief's own fallback ordering — shipping and
fulfillment, inventory reservations, inventory staff UI, commerce settings —
end to end and server-enforced, and defers the rest with its state recorded.

## Phases 2-11 — complete

### Commerce settings

`site_settings.commerce_settings` jsonb beside the existing `commerce_policy`,
read through `parseCommerceSettings`, which is **total**: any input at all
yields usable settings, so a hand-edited row degrades to safe defaults instead
of taking checkout offline. Defaults have shipping and pickup **off**, so an
unconfigured shop refuses clearly rather than quoting a price it invented.

**Three addresses, edited and stored separately** — shipping origin, return
address, pickup location. For a shop run from home these are frequently the
same building, and publishing one because another was configured is how a
private address reaches a public page. `publicCommerceSettings` is the only
projection a customer surface may read and carries no origin address, no return
address, no staff recipients and no reservation timings **by construction**. A
test serialises it and asserts the private street never appears.

Staff surface at `/staff/settings/commerce`. Explicit Save, disabled until
something differs, `beforeunload` guard. The server refuses incoherent
combinations by naming the fix, and audits **which sections changed, never the
values** — an address and a support email are personal data, and the audit log
is read more widely and kept longer than the settings page.

New permissions: `commerce.settings.view`, `commerce.settings.manage`. Admins
inherit both; no non-admin role receives either automatically.

### Shipping and order snapshots

`quoteShipping` is the only place a delivery charge is computed. The client
sends a **method id** and an address; the charge is recomputed server-side from
the configured methods and the server's own subtotal, and no request field
carrying money is read — a test enumerates the amount, total, price,
shippingCents, totals and subtotal request fields and asserts none is
referenced.

Free shipping is earned on subtotal **minus discount**: the alternative rewards
stacking a code onto a barely-qualifying basket. The lower of the global and
per-method thresholds wins. Boundary, discount interaction and determinism are
all tested.

Orders now carry immutable snapshots — method, charged price, list price,
whether free applied and why, origin, package, pickup location. A settings
change six months later cannot rewrite what a customer was charged or redirect
a parcel already in the post. **The origin snapshot deliberately keeps only the
name, city, region, postcode and country** — not the street — because an order
row is read by more code than the settings page.

`tax_cents` and `products.tax_code` are threaded and always 0/null. Stripe Tax
stays out per the pass-7 owner decision; carrying the fields now makes enabling
it later a value change rather than a schema change on live orders.

### Fulfillment

Two states added to the pass-7 graph — `ready_to_fulfill` and `canceled` — and
the CHECK widened, never narrowed. Forward-only is unchanged: a shipped order
cannot become unfulfilled, a picked-up order cannot return to ready-for-pickup,
and a correction is an audited tracking edit rather than a rewind.

`fulfillmentTransitionsFor` narrows the graph by method, so shipping and pickup
controls can never both appear — asserted exhaustively across every state and
method. **A defect the tests found:** an unrecognised method fell through to
*no* restrictions, so a corrupted value unlocked every state at once including
both channels. Unknown now falls back to shipping's restrictions.

`transition_order_fulfillment` re-asserts the from-status in its WHERE clause,
so a change that landed between page load and click matches zero rows and is
refused as `stale`. A repeat reports `already` and returns **before** the
notification and the audit write, so a double-click cannot double-send.

`GET` returns the legal transitions *and the email each would send*, so the
staff page previews the exact consequence before confirming. Marking shipped
without a carrier and tracking number is refused before the state moves.

**One fulfillment group per order.** Split shipments are not supported and are
not pretended to be.

### Tracking

Links are generated from configured templates with the number
percent-encoded, so a "tracking number" carrying an ampersand or a fragment
cannot reshape the URL. A manual URL is allow-listed to https with no embedded
credentials — a URL whose authority reads as the carrier but resolves to an
attacker is refused. A URL stored before this validation existed does not
become trusted by age, because the check runs on every read. Corrections keep
the previous values in the fulfillment history.

### Inventory reservations

The overselling window pass 7 recorded as open is closed. Availability is
on-hand minus active, unexpired holds. Shortages are computed **before**
anything is written, so a refusal leaves existing holds intact. Product rows
are locked in id order, so two carts with overlapping products cannot deadlock.
Duplicate holds are prevented by a partial unique index rather than by
remembering to check.

Checkout reserves before creating the session, pins the session's `expires_at`
to the hold window, links the hold to the order and session, and releases on
every abandoning path. Confirmed payment commits exactly once; a replayed
webhook commits zero. `checkout.session.expired` releases by session id.
A failed payment releases per a documented policy — holding stock through an
indefinite retry lets one failed card keep the last unit from a customer who
can pay.

**Expiry does not depend on a cron service**, because this project has none:
the reservation path sweeps before it measures, the staff page sweeps on load,
and availability ignores a lapsed hold regardless. A scheduled job is optional,
not load-bearing.

Made-to-order, untracked and backorder-enabled products are **skipped, not
refused** — reserving a made-to-order part would make it look sold out the
moment two people opened checkout.

### Low-stock alerts

One open alert per product, enforced by a partial unique index, so evaluating
after every movement cannot produce an alert per page load. `low` escalates to
`out` in place with `notified_at` cleared — the one case where a second message
is correct — and resolves when stock rises. Untracked and made-to-order
products never alert. Notifications go to `inventory.view` holders through the
existing notification centre, deep-linked to the product.

### Staff inventory UI

`/staff/inventory` and `/staff/inventory/[productId]`. On hand, reserved and
available are shown with the distinction stated on the page. Reservation totals
come from one grouped query per page; the ledger is paginated. Adjustments
require a reason, require a description for "other", confirm reductions and
large moves by spelling out before and after, refuse a count that moved since
page load, and refuse going below zero unless backorders are enabled.

**Two mismatches with pass 7, found and fixed:** `adjust_product_inventory`
takes `p_created_by`, not `p_actor_user_id`; and its `reason` CHECK allowed only
six mechanical values, so every operational reason the UI offers would have been
a 500 for whoever picked it first. The CHECK is widened additively and a test
now asserts every reason the route accepts is one the ledger permits.

## Validation

- **847 tests pass, 0 fail** (757 at `e207fc5`; 90 added across three new suites
  plus three strengthened checkout assertions).
- Typecheck clean. Production build clean, exit 0; all seven new routes present.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings). All new
  code lints clean.
- Both migrations dry-run against production inside rolled-back transactions,
  with a behavioural suite covering two customers racing for the last unit, an
  idempotent repeat, a refused increase leaving the hold intact, a removed line
  releasing, commit-exactly-once under replay, an expired hold not reducing
  availability before the sweep, and low to out to resolved producing exactly
  one alert row. **Production verified untouched after every run.**
- All ten new function signatures verified against the exact grant statements:
  `service_role` can execute all ten, `anon` and `authenticated` none.

## Deferred, honestly

Not built in this pass. Each is specified, none is half-wired:

1. **Staff fulfillment panel on the order page.** The API is complete and
   server-enforced; no staff UI drives it yet, so fulfillment state cannot be
   changed from the browser. This is the single highest-value next step.
2. **Customer order-page fulfillment display** — tracking link, pickup
   instructions, delivery timeline.
3. **Product editor shipping fields.** The twelve columns exist and default to
   today's behaviour; the staff editor does not expose them yet.
4. **Printable documents** — packing slip, pickup slip, return authorization,
   refund record.
5. **Reconciliation tooling and the remaining transactional-email catalogue.**
   Eight new templates are seeded; the fulfillment ones send.
6. **Custom-request orders keep the legacy eager decrement.** Reservations sit
   in front of the direct-purchase path only. The two cannot double-count
   because `order_items` rows exist only for direct purchases.

## Pass 8 — merged and in production

Branch `shipping-fulfillment-inventory-reservations-20260805` → merged as
**`856417e`**, which is the current production SHA. Merged with `--no-ff`,
never force-pushed.

| SHA | What |
|-----|------|
| `9dbc534` | Commerce settings, shipping snapshots and reservations schema |
| `a10f156` | Commerce settings and fulfillment APIs |
| `4fb256e` | Reservations and server-priced shipping into checkout and the webhook |
| `b5966e2` | Inventory API and the customer delivery step |
| `b876f7c` | Staff inventory and commerce settings surfaces |
| `82060a7` | Record pass 8 |
| `856417e` | Merge commit |

### Migration application — 2026-08-05

Both applied with approval through `execute_sql` in **two separate guarded
transactions**, not `apply_migration` — that tool stamps its own timestamp as
the version, which caused six of the seven ledger drifts repaired in pass 3.
Each ledger row was inserted by hand under the repository filename's version.

Each transaction carried assertions on both sides and would have rolled back
whole. Migration 1 guards: `commerce_settings` absent, `order_fulfillment_events`
absent, exactly 38 rows, 39 product columns, 56 order columns — then 51 product
columns, 67 order columns, 39 rows, 30 templates, orders/products/order_items
unchanged at 6/2/1, and grants asserted per role. Migration 2 guards: the two
tables absent, exactly 39 rows, `inventory_adjustments` empty — then 2 tables,
9 functions, 40 rows, data unchanged, and least-privilege asserted.

All held; both committed.

**The ledger is exact: 40 repo files, 40 rows, versions and names identical**,
checked by diffing the two sorted sets. No malformed versions, no duplicates.

### Independent verification after applying

| Check | Result |
|-------|--------|
| Existing data | **unchanged** — 6 orders, 2 products, 1 order item, 2 carts, 3 users, 1 discount, 1 wishlist, 0 refunds/returns/jobs/adjustments |
| New tables | 3 present, all empty, RLS enabled, exactly 1 staff-select policy each |
| New columns | products 39 → 51, orders 56 → 67; all 6 orders carry `fulfillment_status`, both products defaulted to shipping/pickup/fulfillment-required |
| `anon` / `authenticated` / `PUBLIC` | **zero grants** on all three new tables, and **zero** execute on all ten new functions |
| `service_role` | select+insert+update on reservations and alerts; select+insert **only** on fulfillment events; **no DELETE anywhere** |
| Append-only, role-switched | `service_role` refused UPDATE and DELETE on `order_fulfillment_events`, and DELETE on reservations and alerts |
| `anon`, role-switched | refused SELECT on reservations and refused EXECUTE on `reserve_cart_inventory` |
| Email templates | 22 → 30, the 8 new keys present |
| Supabase security advisors | **no new findings.** None of the 3 new tables or 10 new functions appears; every listed item is pre-existing |

**A mis-designed probe, and what it actually proved.** The first append-only
check ran `UPDATE` on the events table and *succeeded*. That was the test being
wrong, not the grant: `execute_sql` connects as the table owner, who bypasses
grants entirely. Re-run under `set local role service_role` — the role the
application actually uses — the update and delete were both refused. The
guarantee holds; the first probe was measuring the wrong role.

### Concurrency and idempotency, re-run against the live schema

Every check passed against the deployed functions, inside a rolled-back
transaction: one unit and two customers (second refused), an idempotent repeat
(still one hold), a refused increase leaving the existing hold intact, a
removed line releasing, link + commit exactly once with a replay committing
**zero**, committed rows not releasable, an expired hold not reducing
availability before the sweep, the sweep, a fulfillment transition with a stale
from-status **refused** and a repeat reported as `already` with exactly one
event written, and low → out → resolved producing exactly **one** alert row.

### Sequence hygiene

`nextval` is not transactional, so the rolled-back dry runs still consumed
values. Checked and corrected:

| Sequence | State | First real value |
|----------|-------|------------------|
| `order_fulfillment_events_id_seq` | untouched | 1 |
| `order_return_number_seq` | untouched | RMA-0001 |
| `production_job_number_seq` | untouched | JOB-0001 |
| `keymoura_order_number_seq` | **consumed 7 and 8** by probe order inserts | reset to **KM-0007** |

The reset was guarded on no existing order holding a number ≥ 7, and verified
by reading `last_value`/`is_called` rather than by calling `nextval` — the first
verification attempt used `nextval` and consumed the value it was checking, so
it had to be reset a second time.

### Production smoke test — on `856417e`

| Check | Result |
|-------|--------|
| Storefront | `/` 200 (0.52 s), `/catalog` 200, `/cart` 200, `/shipping` 200, `/refunds` 200 |
| `GET /api/cart` | 200 against the real database |
| `GET /api/cart/fulfillment` | 200; correctly reports nothing available for an empty cart |
| **Public payload privacy** | **no origin address, no return address, no staff recipients, no reservation timings** in the served JSON |
| Staff routes gated | `/api/staff/inventory`, `/api/staff/commerce/settings`, `/staff/inventory`, `/staff/settings/commerce` all 307 → `/auth/login` |
| Checkout, stopped before payment | `POST /api/cart/checkout` as a guest → **401** `requiresSignIn`. No Stripe session, no order, no reservation |
| Every new read as `service_role` | **all OK** — the three new tables, the new order and product columns, `commerce_settings`, and `available_product_inventory` returning real values (0 and 5) |
| Emails sent | **zero** in the deployment window |

Production data after the run — unchanged: 6 orders, 2 products, 1 order item,
2 carts, 0 reservations, 0 alerts, 0 fulfillment events, 0 adjustments, 40
migrations.

### The owner action this deployment requires

**Direct checkout now requires a fulfillment method, and shipping and local
pickup both ship disabled.** Until at least one is configured at
`/staff/settings/commerce`, a cart holding a physical product will refuse at
checkout with "This order cannot be delivered right now."

That is deliberate — an unconfigured shop must not invent a delivery price —
but it makes configuring a method a **launch step, not a follow-up**.

### External setup still required

1. **Configure a fulfillment method** (above). Nothing else in this pass
   matters until this is done.
2. **`checkout.session.expired`** on the Stripe webhook endpoint. The owner
   confirmed on 2026-08-05 they are adding it. Until it is delivering, an
   abandoned checkout's hold lapses on its own expiry rather than releasing
   immediately — degraded, not broken, because availability already ignores a
   lapsed hold.
3. **Grant the two new permissions** (`commerce.settings.view`,
   `commerce.settings.manage`) to any non-admin role that should use them.
   Admins already have both.
4. **No Resend change is required.** Plain-text bodies are code-side and the
   templates were seeded by migration.

### What could not be verified, and why

- **A signed-in staff or customer session.** Unchanged limitation from passes 3
  to 7: signing in means handling a password. What was done instead is stronger
  at the database layer and weaker at the UI layer — every query and function
  the new routes call was executed against the real production database as the
  exact role the routes use.
- **A real reservation through a real checkout.** Reaching one needs an
  authenticated customer and a configured fulfillment method. The reservation
  *mechanics* were exercised against the live schema with synthetic carts.

---

# Pass 9 — staff command centre, navigation, fulfillment UI, documents, reconciliation

Branch `staff-command-center-fulfillment-ui-20260805`, from `3aa5684`.

## Verified starting state — 2026-08-06

| Check | Result |
|-------|--------|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `3aa5684` |
| Baseline present | `3aa5684` is HEAD, the pass-8 verification commit |
| Production health | `/` 200 (0.36 s), `/catalog` 200, `GET /api/cart` 200, `/staff` 307 → login |
| Migration ledger | **exact** — 40 repo files, 40 rows, versions and names identical |

## Phase 1 — the information architecture audit

Read from the routes themselves, not from the brief's assumed list. Three of the
routes the brief named do not exist (`/staff/dashboard`, `/staff/updates`,
`/staff/analytics`); the real ones are `/staff`, `/staff/info/updates` and
`/staff/info/analytics`. Two are redirects (`/staff/moderation` →
`/staff/moderation/reports`, `/staff/info/users` → `/staff/security/users`).

**What was actually wrong.**

1. **Two route lists, already drifted.** `StaffNav` held one and
   `StaffContextBar` held a second, overlapping one. The context bar knew about
   ten routes; the sidebar knew about twenty; neither knew about
   `/staff/settings/commerce`, and the settings index was the only surface that
   did. That page was therefore reachable from exactly one card or by typing the
   URL — the defect the brief opens with, and a direct consequence of having
   more than one list.
2. **Active state needed hand-written exceptions.** `/staff`, `/staff/settings`
   and `/staff/security` each had a bespoke rule, and `/staff/catalog/discounts`
   still lit *Products* as well as itself.
3. **The mobile menu was a second render of the desktop sidebar** inside a
   `<details>`. Every link existed twice in the accessibility tree at all widths,
   the disclosure was announced as a disclosure rather than a navigation, and on
   a phone it pushed the page content a screen down.
4. **`/staff` answered the wrong question.** A revenue chart and a workshop bar
   list — "how did the month go", which is Analytics. Cancellations, returns,
   fulfillment state and stock holds were absent from it despite all four being
   live systems since pass 7.
5. **The pass-8 fulfillment API had no UI at all**, exactly as pass 8 recorded.

### The final information architecture

Six groups. Every entry is a route that exists; there are no placeholders and no
disabled "coming later" rows.

| Group | Destinations |
|-------|--------------|
| Overview | Dashboard `/staff`, To-do board `/staff/info/todo` |
| Commerce | Orders, **Fulfillment** (new), Production |
| Catalog | Products, Discount codes, Inventory |
| Customers & content | Customers & users, Reports & moderation, Community, Shops, Pending submissions, Content updates |
| Business | Analytics, **Reconciliation** (new), Audit log |
| Settings | Settings overview, **Shipping, pickup & policy**, Appearance, Email & notifications, Security controls, Roles & permissions, Verified perks, Recycle bin |

**Deliberately absent**, because the routes do not exist and a menu entry that
goes nowhere costs a staff member the same click every day: Notifications,
Payments, Cancellations, Returns and Refunds as standalone pages (they live in
the order lifecycle panel), Categories (API only), Reviews (no UI), Support
tickets, Reports, Exports, Customers-as-commerce-records.

## Phase 2 — navigation

`src/lib/staffNavigation.ts` is the one definition, read by the sidebar, the
drawer, the breadcrumbs and the settings index. Pure and dependency-free — no
React, no `next/*` — so the routing rules are unit-testable rather than only
observable by rendering a page. A test asserts no staff surface hard-codes a
`/staff` href any more.

**Longest-prefix matching replaces the exception list.** One rule: the entry
whose href is the longest prefix of the path wins. `/staff/catalog/discounts`
lights Discount codes, `/staff/settings/commerce` lights itself rather than
Settings, `/staff` lights only the dashboard, and `/staff/orders/<id>` falls back
to Orders. Matching is `=== href || startsWith(href + "/")`, so
`/staff/ordersomething` is not a sibling match. A test asserts exactly one entry
is ever active across ten paths.

**Permission filtering is derived.** `STAFF_AREA_PERMISSIONS` is computed from
the menu rather than hand-maintained, so a new section cannot ship with its
holders locked out of the shell. A viewer holding no staff permission gets **no
sidebar at all** rather than one row leading to a page that refuses them.

**The drawer is a real dialog.** Portalled onto `document.body` — the header
carries `transition-transform`, and a transformed ancestor becomes the containing
block for a `position: fixed` descendant (CSS Transforms L1 §3), which is what
rendered the customer drawer 60px tall in pass 6. Focus trap, Escape, focus
restoration, body-scroll lock at the offset, `100dvh` bound, 44px rows,
safe-area padding.

**Open state is derived, not set from an effect.** The drawer stores *the path it
was opened on*; navigating closes it by derivation. That removes a render after
every navigation and also handles the back button, which the per-link `onClick`
alone did not.

**Sidebar preferences go through `useSyncExternalStore`**
(`useStoredPreference.ts`). Reading `localStorage` during render is a hydration
mismatch and this project already carries one; reading it in an effect and
calling `setState` is a cascading render on every mount. The hook serves the
default for SSR and hydration and switches afterwards, and subscribes to
`storage` so two tabs do not disagree.

Breadcrumbs are derived from the same tree. The group crumb is **text, not a
link** — a group is an organisational heading, and the old context bar linked it
to the first page inside it, which sent a reader somewhere they had not asked to
go. An unlabelled leaf gets no crumb rather than a guessed one.

## Phase 3 — the dashboard

Reads in the order a shop works: configuration blockers, then open decisions,
then what has to go out, then production, money and stock.

**Configuration blockers come first because they are outages, not metrics.**
Pass 8 ships shipping and pickup both disabled and refuses checkout for a
physical product until one is on. That refusal is correct, but with nothing
surfacing it the only symptom is customers failing to check out. The dashboard
now says so, with a link to the settings page.

**The attention queue and the fulfillment counts come from
`operationsQueues.ts`**, which the fulfillment queue also reads — so a card
reading 3 opening a list of 5 is not representable. Every order lands in exactly
one bucket, asserted exhaustively over the fulfillment state enum, so the counts
add up.

Two ordering decisions in the bucketing worth naming: payment is checked *after*
the departed states, so a shipped order that was later partly refunded does not
reappear on the packing bench; and a closed order that had already shipped keeps
its real delivery state, so a parcel in the post does not vanish from the queue
that would have confirmed it arrived.

### A refused query is never rendered as a zero

Found by driving the page rather than by reading it. The first cut surfaced the
error in a banner *and* rendered "0 To prepare", "Nothing is waiting on a
decision", "$0 revenue" and "Stock levels look healthy" underneath it. That is
the pass-5a mistake in a new place — a staff member scanning the page reads the
zeros, not the sentence above them.

Fixed on both surfaces, and pinned by tests:

- A refused query clears the rows rather than keeping `data ?? []`.
- Nothing is derived from a failed load: `buildDashboardSummary([])` will happily
  report $0 and zero overdue, which is a confident wrong answer rather than a
  missing one.
- Each dependent panel renders the failure **in the panel** — the attention list,
  the fulfillment cards, the revenue panel and the stock panel — and the count
  badge disappears rather than reading 0.
- The fulfillment queue likewise withholds its bucket counts, its summary line
  and its "Nothing is waiting to go out" empty state when the load failed.

## Phase 4 — fulfillment, driven by the state machine

The staff order page posted `shipment_action` to `PATCH /api/staff/orders/[id]`,
which set `shipped_at` and moved `orders.status` but **never wrote
`orders.fulfillment_status`** — so the column the cancellation and return
eligibility rules read stayed at `unfulfilled` forever and a shipped order still
looked cancellable. `OrderFulfillmentPanel` replaces it and drives the pass-8
endpoint.

- **The consequence is shown before it is chosen.** `GET` returns the legal
  transitions *and the email each would send*, from the same table the send
  reads, so the preview and the send cannot disagree.
- **The staleness guard is honoured.** The state the page rendered from goes back
  as `expectedStatus`; a mismatch is refused with 409 and a sentence.
- **Nothing client-side decides what is legal.** The buttons are what the server
  said was possible; `blockedReason` comes from the route, so the button the page
  disables and the transition the route refuses are the same set.
- Always mounted, rather than gated on `status === "ready"` — a direct purchase
  never passes through `ready`, which is why direct purchases previously had no
  fulfillment surface at all.

**Two guards moved with the control rather than being left behind with it.**

1. `RELEASES_GOODS` — shipped, ready-for-pickup, picked-up and delivered are
   refused while a balance is outstanding, server-side. The legacy action had
   this rule and dropping it silently would let stock leave unpaid. `processing`
   is deliberately excluded: packing early is normal, only the handover is
   consequential.
2. `COMPLETES_ORDER` — reaching delivered or picked-up completes a `ready` order.
   `transition_order_fulfillment` writes only `fulfillment_status`, so without
   this an order could be delivered and still read "Ready" to its customer
   forever. Conditional on both sides (`.eq("status", "ready")`), so a concurrent
   change matches zero rows.

**Customer side.** The old block rendered only for pickup orders or once a
tracking number existed, and described the state by inspecting timestamps — so an
order being packed showed nothing, and every direct purchase had no delivery
section at all. `OrderFulfillmentStatus` reads `fulfillment_status` and renders
from `FULFILLMENT_LABELS`, the same table the emails are titled from. It renders
no second progress stepper: the page already has one, and two disagreeing about
which step you are on is worse than one. A test asserts `fulfillment_notes` is
never referenced there — only `customer_shipment_note` reaches a customer.

## Phase 5 — product delivery fields

`checkoutFulfillment.ts` reads `requires_shipping`, `pickup_eligible`,
`fulfillment_required` and the package dimensions to decide which delivery
methods a cart may offer and what a parcel weighs. Pass 8 shipped all twelve
columns with **no editing surface**, so every product sat on the column defaults.

Two hazards the editor states rather than leaving to be discovered: turning off
"Can be collected" removes local pickup from every *other* item in the same cart,
and a product that needs fulfilling but can neither ship nor be collected refuses
at checkout — that pairing is called out where it is set.

**Two ways this could have silently corrupted live products, both closed.**
`Boolean(undefined)` is `false`, so saving with `Boolean(draft.requires_shipping)`
would have marked a product unshippable on the first save of an unrelated field;
the payload uses `?? true`, matching the column defaults. And `Number("")` is
`0`, so a cleared package weight would have been priced as a weightless parcel
instead of falling back to the configured default; blank stores `null`.

## Phase 6 — printable documents

Packing slip, pickup slip, invoice, refund record. Server-rendered, because
Ctrl+P on a half-hydrated page is a blank sheet.

**Three of the four physically reach a customer.** Whether internal notes and
cost detail may appear is a property of the document (`reachesCustomer` in
`orderDocuments.ts`) that the renderer reads, not a habit each template has to
remember. Prices never print on a sheet that travels with the goods — a packing
slip with prices is a receipt in the box, which is what a gift order must not
contain.

**The invoice never recomputes the total the customer was charged.**
`agreed_price_cents` is printed as-is and the components are shown as a breakdown
of it where one was recorded; a quoted custom order prints one line, which is
honest because nothing else was ever stored.

The `[doc]` segment is validated against the known set, so a path segment cannot
reach the loader.

## Phase 7 — reconciliation

Six checks over money, stock and delivery: payment totals against payment rows,
refund totals against settled legs, holds that lapsed or outlived their order's
payment, stock against its own ledger, alerts against the stock they describe,
and fulfillment that stalled or shipped untrackable. Each states the question it
asks, so a clean pass means something, and every finding names the fix and links
to the record.

Pending refund legs are excluded from the settled sum on purpose — pass 7 only
grows `amount_refunded_cents` at settlement, so counting them would report every
in-flight refund as a discrepancy. A leg pending over a day is reported
separately, because it is still holding down what the order can refund.

**Read-only, with no POST.** The refund settlement and inventory commit paths are
the only writers of these numbers and both are idempotent and guarded; a repair
button here would be a third writer with neither property, and the failure mode
of getting it wrong is moving money. A test asserts the route contains no
`insert`, `update`, `delete` or `rpc`.

The loads are bounded and the bound is reported, so a truncated pass is not
presented as a clean bill of health.

## A defect the tests caught before it shipped

The reconciliation route was written against a table called `low_stock_alerts`.
**No such table exists** — pass 8 created `inventory_alerts`, with a `level`
column rather than `severity`. Every request would have failed with `42P01`.

It was caught by `tests/installer.test.ts`, which derives the set of application
relations from every `.from("…")` in `src/` and requires each to be created by
some SQL in the repository. That test was written for the installer baseline and
had nothing to do with this work; it is the generalizable kind, and it earned its
keep here.

## Files changed

New:

- `src/lib/staffNavigation.ts`, `src/lib/hooks/useStoredPreference.ts`
- `src/lib/staff/operationsQueues.ts`, `orderDocuments.ts`, `reconciliation.ts`
- `src/components/staff/StaffMobileNav.tsx`, `StaffBreadcrumbs.tsx`,
  `StaffNavIcon.tsx`, `OrderFulfillmentPanel.tsx`, `ProductShippingEditor.tsx`
- `src/components/commerce/OrderFulfillmentStatus.tsx`
- `src/app/staff/fulfillment/page.tsx`, `src/app/staff/reconciliation/page.tsx`
- `src/app/staff/orders/[id]/print/[doc]/page.tsx`
- `src/app/api/staff/reconciliation/route.ts`
- `tests/staff-command-center.test.ts`, `tests/staff-reconciliation.test.ts`

Renamed: `src/lib/production/access.ts` → `src/lib/staff/serverAccess.ts`.
Nothing about it was production-specific, and a second copy under a second name
is how two staff surfaces come to disagree about who a caller is.

Deleted: `src/components/staff/StaffContextBar.tsx`.

Modified: `StaffNav.tsx` (rewritten), `src/app/staff/layout.tsx`,
`src/app/staff/page.tsx` (rewritten), `src/app/staff/settings/page.tsx`,
`src/app/staff/catalog/page.tsx`, `src/app/staff/orders/[id]/page.tsx`,
`src/app/orders/[id]/page.tsx`,
`src/app/api/staff/orders/[id]/fulfillment/route.ts`,
`src/lib/commerceTypes.ts`, `src/app/globals.css`, and four existing suites.

**No migration. No schema change. No new dependency.**

## Validation

- **958 tests pass, 0 fail** (847 at `3aa5684`; 111 added across two new suites,
  plus a rewritten `staff-navigation` suite).
- Typecheck clean. Production build clean from a cleared `.next`, exit 0.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings). Every new
  and changed file lints **completely clean** under a focused run.
- All new routes present in the build output: `/staff/fulfillment` and
  `/staff/reconciliation` static, `/staff/orders/[id]/print/[doc]`,
  `/api/staff/reconciliation` and `/api/staff/orders/[id]/fulfillment` dynamic.

One build failure found and fixed: `/staff/fulfillment` reads `useSearchParams`
for its URL filters, which needs a Suspense boundary or the route opts into
client-side rendering and prerendering refuses it. Wrapped the same way
`/staff/production` already does, since it puts its filters in the URL for the
same reason.

### Three existing suites re-pointed, not weakened

Each asserted a property that moved. All three were re-pointed at where it now
lives and made **stricter**:

- `staff-navigation` — was string-matching group labels out of the sidebar's JSX.
  Now asserts the rules against the module: every href resolves to a page that
  exists, no entry is listed twice, exactly one entry is active per path, and the
  menu never offers a page the viewer would be refused.
- `order-fulfillment` — pinned two hard-coded button labels that *were* the whole
  control. Now asserts the panel is mounted, drives the real endpoint, and that
  the customer's section reads the state field.
- `production-surfaces` — read the navigation out of the component. Now also
  proves the entry is genuinely filtered for a viewer holding neither production
  permission, which the string match could not have caught.

### Driven in a real browser

Dev server, staff permissions seeded into the React Query cache. Local only:
production middleware 307s `/staff/*` before any HTML is served.

| Check | Result |
|-------|--------|
| Sidebar | **Passes.** Six groups, 25 links, `/staff` marked current, `/staff/settings/commerce` present. |
| Old chrome gone | **Passes.** Zero context bars, zero "Staff menu" disclosures, exactly one staff nav in the tree. |
| Active state | **Passes.** `/staff/settings` lights Settings overview; `/staff/settings/commerce` lights itself; one active link on every page tested. |
| Breadcrumbs | **Passes.** "Staff / Settings / Shipping, pickup & policy", "Staff / Commerce / Orders / Order", "Staff / Catalog / Inventory". |
| Mobile drawer at 375 | **Passes.** `role="dialog"`, `aria-modal`, portalled to `body`, panel **320×812** (not the 60px pass-6 failure), focus to Close, body locked, 25 links. |
| Escape | **Passes.** Closes, portal removed, focus restored to the trigger, body and scroll restored. |
| Permission filtering | **Passes.** Limited staff (`orders.view` + `fulfillment.view`) sees 3 groups and 4 links and no refusals; an unauthorized viewer and a signed-out viewer get **no sidebar and no drawer trigger**. |
| Dashboard honesty | **Passes.** With orders refused: no metric cards, no bucket counts, no attention badge, four explicit failure notices. |
| Fulfillment queue honesty | **Passes.** No bucket cards, no zeros on screen, no "Nothing is waiting to go out". |
| Reconciliation | **Passes.** Renders, correct breadcrumb and active link, re-run control, **zero forms**. |
| Printable document | **Passes.** Unauthenticated request renders the refusal and leaks **none** of the document body. |
| Print CSS live in the CSSOM | **Passes.** `header, footer, nav, .skip-link, .staff-nav, .print-hidden { display: none !important }`. Breadcrumbs are a `nav`; the drawer trigger carries `print-hidden`. |
| New APIs refuse anonymous | **Passes.** `/api/staff/reconciliation`, both methods on `…/fulfillment`, `/api/staff/commerce/settings` and `/api/staff/inventory` all **403**. |
| Horizontal overflow | **None** at 375 or desktop. |
| Console | Only the **pre-existing** `data-motion` hydration mismatch on the root `<html>` — confirmed to reproduce on `/` with no staff nav present — plus the local 503 from the deliberately fake service-role key and the expected 401/403 refusals. |

### What could not be verified, and why

- **A signed-in staff or customer session.** Unchanged limitation from passes 3
  to 8: signing in means handling a password. The **populated** fulfillment
  panel, a real transition, a populated queue and a populated printable were
  therefore not driven. Their rules are covered by the new tests; the rendering
  of populated states is not.
- **The Vercel preview.** The build **succeeded**, which is what is verifiable.
  Every route on the preview deployment answers **302** to the Vercel SSO gate,
  so the running preview cannot be driven from here.

## Noticed, not acted on

`/staff/orders` — the pre-existing order cockpit, untouched by this pass — has
the same "zeros beside a failure" behaviour the dashboard and the fulfillment
queue were fixed for: its view tabs read "Needs action (0)" when the orders query
was refused. It is a one-line change of the same shape, but it is a different
page from the ones this pass rebuilt and was left alone rather than widened into.

## Owner checks worth five minutes

1. Sign in as staff and open `/staff`. It should show real counts, and the
   delivery-configuration warning should be **absent** if a fulfillment method is
   configured and present if not.
2. Open an order and drive one fulfillment transition. Confirm the email preview
   on the button matches what the customer receives, and that marking delivered
   moves the order to Completed.
3. Print a packing slip and confirm the navigation and sidebar are absent on
   paper and that no internal note appears on it.
4. Open `/staff/reconciliation` and confirm every check reports clean against
   real data.

## Pass 9 — merged and in production

Branch `staff-command-center-fulfillment-ui-20260805` → merged as **`ff198cc`**,
which is the current production SHA. Merged with `--no-ff`, never force-pushed.

| SHA | What |
|-----|------|
| `b07d8fa` | Rebuild the staff navigation around one definition |
| `a921d12` | Add the staff dashboard and the fulfillment queue |
| `6476e83` | Drive fulfillment from the state machine, on both sides |
| `743f580` | Expose the product delivery fields that checkout already reads |
| `368a59c` | Add printable order documents and the reconciliation report |
| `87b7d41` | Record pass 9 |
| `ff198cc` | Merge commit |

- Vercel **preview build: success** (checked on the final branch head, not only
  on the first push).
- Vercel **production deployment: Ready** on `ff198cc`.
- **No migration was applied, because none exists.** This pass added no schema
  change. The ledger stays at 40 repo files and 40 rows.

### Post-deploy verification — on `ff198cc`

| Check | Result |
|-------|--------|
| Storefront | `/` 200 (0.80 s), `/catalog` 200, `/cart` 200, `/shipping` 200, `/refunds` 200 |
| `GET /api/cart` | 200 against the real database |
| Staff routes gated | `/staff`, `/staff/fulfillment`, `/staff/reconciliation`, `/staff/settings/commerce`, `/staff/inventory`, `/staff/production`, `/staff/orders` all **307 → `/auth/login`** |
| New APIs gated | `/api/staff/reconciliation` and `/api/staff/orders/[id]/fulfillment` both **307** |
| New CSS deployed | The production chunk carries `.staff-drawer-panel`, `.staff-drawer-trigger`, `.staff-nav-group-toggle`, `.staff-breadcrumbs`, `.staff-nav-link-icon`, `.staff-drawer-item-description` |
| Print CSS deployed | `@media print{header,footer,nav,.skip-link,.staff-nav,.print-hidden{display:none!important}` |
| Reduced motion deployed | `prefers-reduced-motion` block present |
| Every reconciliation query, as `service_role` | **All seven OK** — orders, payments, refunds, active reservations, products, adjustments and **`inventory_alerts`**, the table the pre-fix code named wrongly |
| Production data | **unchanged** — 6 orders, 2 products, 1 order item, 2 carts, 0 refunds/returns/jobs/adjustments/reservations/alerts/fulfillment events, 40 migrations |

**A route-existence probe is not possible in production, and saying otherwise
would be false.** Middleware 307s everything under `/staff/*` before routing, so
`/staff/definitely-not-a-route` answers 307 exactly like a real page. Deployment
of the new routes is evidenced instead by the build output (which lists all five)
and by the new CSS being served from the production chunk.

### The reconciliation report found two real discrepancies on its first run

Run against live production data using the same comparison
`checkPaymentTotals` performs:

| Order | `amount_paid_cents` | Sum of its payment rows |
|-------|--------------------|--------------------------|
| KM-0001 | 2500 | **0** |
| KM-0002 | 100 | **0** |

Both would be reported as `payment_total_mismatch`, critical. KM-0001 also
carries `payment_status = 'unpaid'` alongside a non-zero collected amount.

These are almost certainly manual or early-development orders — both predate the
pass-7 atomic payment accounting, which is what made the order field and the
payment rows move together. **Nothing was changed.** The tool is read-only by
design and historical records are an owner decision; this is recorded so the
owner can decide, which is exactly what the report is for.

It is also the first evidence that the report does real work rather than
returning a vacuous pass.

### Noticed, not acted on

- `.staff-nav-title` remains in `globals.css` with no component referencing it
  after the sidebar rewrite. Dead CSS, one rule, harmless.
- `/staff/orders` still renders "Needs action (0)" when its orders query is
  refused — the same class of defect fixed on the dashboard and the fulfillment
  queue. It is a different page from the ones this pass rebuilt and was left
  alone rather than widened into.

### Owner checks worth five minutes

1. Sign in as staff and open `/staff`. Real counts should appear, and the
   delivery-configuration warning should be absent if a fulfillment method is
   configured.
2. Open `/staff/reconciliation` and confirm the two payment-total findings
   above, then decide what should happen to those two historical orders.
3. Open an order and drive one fulfillment transition. Confirm the email preview
   on the button matches what the customer receives, and that marking delivered
   moves the order to Completed.
4. Print a packing slip and confirm navigation and the sidebar are absent on
   paper and no internal note appears.

---

# Pass 10 — staff order truthfulness, server-side filtering, staff-area audit

Branch `staff-orders-reliability-communications-20260806`, from `7e0453a`.

## Verified starting state — 2026-08-06

| Check | Result |
|-------|--------|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `7e0453a` |
| Baseline present | `7e0453a` is HEAD, the pass-9 verification commit |
| Production health | `/` 200 (0.32 s), `/catalog` 200, `/shipping` 200, `GET /api/cart` 200, `/staff/orders` 307 to login |
| Migration ledger | **exact** — 40 repo files, 40 rows, versions and names identical |

## Scope actually delivered, and why it stops where it does

The brief listed fifteen phases. This pass completes its **first three** —
staff truthfulness, the order list, and order-detail reliability — end to end
and verified, and **does not start** the communications layer (transactional
emails, delivery centre, notifications, integration health, launch readiness).

That is a deliberate stop, not drift. The brief's own rule is "do not merge
partially wired communications systems", and each of those five needs its own
schema, grants, permissions and idempotency work. Half of an email-resend
surface is worse than none: it is a button that appears to have sent something.

What ships here is independently valuable and independently deployable — it
fixes the defect the brief opens with and the one pass 9 recorded as
outstanding.

## Phase 1 — the defect, precisely

`/staff/orders` did this:

    const rows = (orderResult.data ?? []) as Order[];
    setOrders(rows);
    const counts = { action: orders.filter(needsStaffAction).length, ... };

A refused query is `[]`. So the page rendered **"Needs action (0)"**,
**"Waiting (0)"**, **"All (0)"** and **"Nothing in this view."** underneath its
own red error banner — and it rendered `orderResult.error.message`, a raw
Postgres string, straight into the page.

Three consequences, not one:

1. A staff member scanning the page reads the zeros, not the sentence above
   them. This is the pass-5a mistake in its fourth location.
2. Every staff client received **every order row** — product names, prices,
   customer ids, payment and fulfillment state — regardless of which
   twenty-five it displayed.
3. It does not scale past a few hundred orders.

### `loadState.ts` — the reusable primitive

The brief asked for "reusable result-state handling rather than duplicating
fragile patterns". Pass 9 fixed two pages with hand-written `xError` strings
and `xUsable` booleans, and the copy was never made to the third — so the fix
that generalizes is not another careful `if`.

`LoadState<T>` is `idle | loading | error | ready`, and **`data` exists only on
the `ready` variant**. `state.data.length` does not compile on a state that
might have failed. A count is therefore *structurally* unable to come from a
failure, which is a stronger guarantee than remembering to check.

- `countOrNull` returns `null`, not `0`, when the answer is unknown.
- `rowsOrNull` deliberately does **not** `?? []` — that expression is behind
  every instance of this defect in the codebase's history.
- `isTrulyEmpty` is true only for a *successful* query that returned no rows,
  which is the only state in which "nothing needs attention" is a true sentence.
- `allReady` yields `null` unless every panel succeeded, because a summary over
  a partly failed set is the subtlest form of the same lie.
- `classifySupabaseError` maps SQLSTATE to a safe sentence and **drops** the
  provider message. A Postgres error names schema objects and on a constraint
  violation quotes the offending value, which on this schema can be an address
  or a private note.

`idle` is a real fourth state: a panel the viewer lacks permission to load was
never told the answer, which is not zero either.

## Phase 2 — server-authoritative filtering

Fixing the counts needs the filtering on the server. Moving it there needs the
derived predicates to be expressible in SQL — and the fulfillment bucket,
"requires action" and "overdue" all depend on the outstanding balance, which is
`agreed_price - (paid - refunded)`: a comparison **between columns** that
PostgREST cannot filter on.

### The view

`20260806010000_staff_order_queue_view.sql` creates `public.staff_order_queue`,
projecting the order columns plus:

`outstanding_cents`, `fulfillment_bucket`, `missing_tracking`, `is_overdue`,
`has_failed_refund`, `has_inventory_issue`, `cancellation_open`, `return_open`,
`production_status`, `priority`, `priority_rank`, `assigned_to`.

**The CASE arms mirror `fulfillmentBucket()` in `operationsQueues.ts` in
order**, and a test evaluates the SQL logic in TypeScript across **198 state
combinations** (11 fulfillment states x 6 order statuses x 3 payment shapes) and
asserts the two never disagree. Approximating the rule in PostgREST while
computing the true one in TypeScript would have reproduced exactly what pass 9
warned about: a card reading 3 that opens a list of 5.

`priority_rank` exists because Postgres sorts the *words*, which orders them
"high, low, normal, urgent" — alphabetical and meaningless.

`security_invoker = true`, so the caller's own rights on `orders` still apply
and this cannot become a way around RLS on the base table.

**Grants:** `revoke all` from `public`, `anon`, `authenticated`; `grant select`
to `service_role` only. The single caller is a server route that has already
checked `orders.view`/`orders.manage`.

### `orderFilters.ts` — one definition, read by everything

Pure and dependency-free, so the page, the route, the dashboard's deep links
and the tests all read the same rules.

- Every filter is an enum over values the CHECK constraints already enumerate.
  Unknown values are **dropped**, never interpolated into a query.
- Parsing is **canonical** (arrays sorted) and **total** — any input yields
  usable filters. An impossible date like `2026-02-31` is refused rather than
  silently shifted; an inverted range is swapped, because that is a typo, not a
  request for zero rows.
- **15 saved views** are presets over those same filters, not a second
  mechanism, so a view cannot drift from the filters it claims to apply.
- Filters live in the **URL and nowhere else** — no `useState` mirror, which is
  what makes the back button disagree with the list.

**A defect the schema caught:** the first draft guessed the production-job
vocabulary and got **nine of thirteen values wrong** (`queued`,
`materials_pending`, `awaiting_customer`, `rework`, `ready`, `failed`,
`blocked` are not states this schema has). Every wrong value is a filter that
silently matches nothing, which on screen is indistinguishable from "no orders
are in production". Now imported from `production/jobs.ts` and pinned by a test.

### `GET /api/staff/orders`

Behind `orders.view` or `orders.manage`; anonymous gets 403, verified live.

- One page of rows plus an exact `count`, in one round trip.
- **Counts for all 15 views** as a *fixed* number of parallel `head`-only count
  queries — fixed, so it does not grow with the number of orders.
- If **any** count fails, `counts` is withheld **entirely**. A tab strip where
  one number is missing and the rest are present invites reading the gap as zero.
- A failed list is **502**, never a 200 with an empty array.
- Free-text search is escaped for PostgREST's `or` grammar; `%` and `_` are
  neutralised so searching for `%` looks for a percent sign rather than matching
  everything.
- Degradations are **reported** (`degraded.customerSearch`, `.customerNames`,
  `.counts`), because a page that quietly dropped customer-name matching shows
  fewer results than exist and calls it a complete answer.
- Failure logs take a **pre-stripped shape object**, so the logger has no access
  to the filters at all — a logger that merely promises not to read the search
  box is one edit away from reading it, and that box is where a staff member
  types a customer's name.
- The list selects **named columns**; no email, address, customer note or staff
  note is in the payload.

## Phase 3 — order-detail reliability

The staff order workspace loaded six sections and collapsed them into one
`??`-chained error string. Three consequences on a page about money:

1. A failed payments query rendered as **"no payments"**.
2. The **activity timeline** is assembled from four of those lists, so a failed
   source silently vanished while the timeline still looked complete and
   chronological — the one place a partial failure is genuinely invisible.
3. Only the first failure showed, with a raw message, and nothing said which
   section it belonged to.

Each section now carries its own `LoadState` and renders its own failure. The
timeline names the sources it is missing, with **payments and refunds called out
individually** because those are the two omissions that change what a staff
member believes about money.

## Phase 1, continued — the audit as a test, not a sweep

Pass 9 fixed two pages, wrote down that a third still had the defect, and this
pass had to find it again. `tests/staff-page-truthfulness-audit.test.ts` walks
**every** page under `src/app/staff` (36 found) and fails on the *shape*, so a
new page is covered without being added to a list.

Seven more instances found and fixed:

| Page | What it claimed on failure |
|------|----------------------------|
| `/staff/inventory` | "No products match this view." and "**0 products**" |
| `/staff/emails` | "Loading email settings..." **for ever** — a `.then` with no `.catch` |
| `/staff/orders/[id]` | "no payments"; a silently-incomplete timeline |
| `/staff/catalog` (editor) | "no options" — see below |
| `/staff/catalog` (list) | an empty catalog |
| `/staff/page.tsx`, `/staff/fulfillment` | profile lookups from unchecked results |
| `/staff/community`, `/staff/info/pending/[id]` | link maps and review history |

**The catalog editor was the most consequential.** A failed option read
presented as "no options", which (a) marked a custom product's publish checklist
*incomplete* when nobody could tell, and (b) `addGroup` takes its `sort_order`
from `groups.length`, so the next option added would have collided at position 0
with the options the product actually has. Adding is now disabled while the list
is unknown, and the checklist reports "could not be checked" rather than a false
blocker.

A permanent loading spinner is worth naming as its own case: it is the quietest
version of the same lie, because unlike a zero it never even invites a second
look.

## Dashboard deep links

The attention panel's overflow link went to a bare `/staff/orders`, which since
the rebuild opens *All orders* — so "5 more in the order cockpit" landed the
reader on an unfiltered list. It now opens the `requires_action` queue, and each
kind of work present gets a chip opening the queue holding exactly that kind.
`ATTENTION_VIEW` maps every `AttentionKind` to a saved view and a test asserts
each resolves to one that exists.

## Files changed

New:

- `supabase/migrations/20260806010000_staff_order_queue_view.sql`
- `src/lib/staff/loadState.ts`, `orderFilters.ts`, `orderQueryPlan.ts`
- `src/app/api/staff/orders/route.ts`
- `tests/staff-orders-truthfulness.test.ts` (60), `staff-page-truthfulness-audit.test.ts` (12)

Modified: `src/app/staff/orders/page.tsx` (rewritten), `staff/orders/[id]/page.tsx`,
`staff/page.tsx`, `staff/inventory/page.tsx`, `staff/emails/page.tsx`,
`staff/catalog/page.tsx`, `staff/fulfillment/page.tsx`, `staff/community/page.tsx`,
`staff/info/pending/[id]/page.tsx`, and two existing suites.

**No new permission. No new dependency.** One additive migration, one view.

## Validation

- **1030 tests pass, 0 fail** (958 at `7e0453a`; 72 added).
- Typecheck clean. Production build clean from a cleared `.next`, exit 0;
  `/api/staff/orders` present as a dynamic route, `/staff/orders` still
  prerendering behind its Suspense boundary.
- **Lint baseline unchanged at 186 errors / 1667 warnings**, measured by running
  the same command on `main` and on this branch. Every new and changed file
  lints clean.
- Migration **dry-run against production inside a rolled-back transaction**:
  guards held, view created, 6 rows readable, rollback confirmed by re-checking
  `pg_views`.

### The regression tests fail against the pre-fix page

Six assertions, checked against `git show HEAD:src/app/staff/orders/page.tsx`:
**6/6 fail** against the old code. They test the bug, not the fix.

### Driven in a real browser

Dev server, staff permissions seeded through the React fiber and the API stubbed
so each state could be reached deterministically. Local only: production
middleware 307s `/staff/*` before any HTML.

| Check | Result |
|-------|--------|
| Populated | **Passes.** Rows, badges, derived next-actions, "Showing 1-25 of 57" |
| **True zero vs unknown** | **Passes.** "Completed **0**" renders its zero because the server counted zero; queues the server sent no count for render **no number at all** |
| Failed load | **Passes.** `role="alert"` + reference; **every chip loses its number**; no "No orders match", no pagination, no rows |
| Retry | **Passes.** Recovers from the failure state |
| Genuinely empty | **Passes.** "No orders match these filters. That is a complete answer — the query succeeded and found none." |
| Partial failure | **Passes.** Counts withheld with a warning **while the list still renders** |
| Back / forward | **Passes.** URL and active chip both track history across two views |
| Anonymous API | **Passes.** `GET /api/staff/orders` gets **403** |
| 375px | **Passes.** No horizontal overflow, zero overflowing elements |
| Accessibility | Labelled queues/pagination nav, labelled selects, live region, Previous disabled on page 1 |

**One defect found by measuring rather than reading:** the queue chips were
**30px** tall at 375 — a comfortable click with a mouse and a miss with a thumb,
on the page's primary mobile navigation. Now `min-h-11` (44px), matching the
staff drawer.

Console carried only the **pre-existing** `data-motion` hydration mismatch on
the root `<html>`, the 403 from the anonymous probe, and the local 503 from the
deliberately fake service-role key.

### What could not be verified, and why

- **A real signed-in staff session.** Unchanged limitation from passes 3-9:
  signing in means handling a password. The page was driven with permissions
  seeded and the API stubbed, which exercises every real component and every
  real state transition but not the real query.
- **A screenshot.** The Browser pane was not displayed, so the page was not
  compositing frames. The DOM and geometry assertions above are the evidence.

## Deployment order matters

`/staff/orders` reads `staff_order_queue`. **The migration must be applied
before or with the merge, or the page 502s in production.** It has not been
applied — production migrations need explicit approval.

## Deferred, honestly

Not started in this pass. Each is specified in the brief; none is half-wired:

1. **Transactional email catalogue.** 30 templates seeded; `sendCommerceEmail`
   already does HTML + plain text + `event_key` idempotency + Resend
   `idempotencyKey`. The brief's ~40-event matrix is not written.
2. **Email delivery centre**, resend, and `emails.view` / `emails.resend`.
   `email_deliveries` has no `updated_at`, no attempt count, no `delivered_at`
   and no resend linkage.
3. **Notification deduplication.** `notifications` has **no `event_key`
   column**, so `createNotification` inserts unconditionally — repeated
   lifecycle calls can produce duplicates. Stripe replays are caught upstream by
   `stripe_webhook_events`, so this is a latent gap rather than a live one.
4. **Integration health** and **launch readiness** pages.
5. **Historical payment review** for KM-0001 / KM-0002.
6. **Support tickets** and **verified-purchase reviews.**

Also noticed, not acted on: about **fifteen catalog *write* paths** still
surface `insertError.message` directly. All pre-existing, all behind
`catalog.manage`, several genuinely actionable ("duplicate slug"). The audit
test's scope is stated as load paths rather than quietly widened.

## KM-0001 and KM-0002 — untouched

Confirmed unchanged while reading the schema. KM-0001 carries
`agreed_price_cents = 100` against `amount_paid_cents = 2500` with
`payment_status = 'unpaid'`; KM-0002 carries 100 against 100. The new view
floors `outstanding_cents` at zero rather than reporting a negative balance, and
**writes nothing**. No automated process in this pass touches either row.

## Exact continuation steps

1. **Apply `20260806010000` with approval, before or with the merge.** Use
   `execute_sql` in a guarded transaction, not `apply_migration` — that tool
   stamps its own timestamp as the version, which caused six of the seven ledger
   drifts repaired in pass 3. Insert the ledger row by hand under the filename's
   version.
2. Verify `staff_order_queue` exists, returns 6 rows as `service_role`, and that
   `anon` and `authenticated` are refused SELECT under `set local role`.
3. Then pick up the communications layer in the brief's order: transactional
   emails, then delivery/resend, then notification deduplication, then
   integration health, then launch readiness. Add `notifications.event_key`
   (additive, partial unique index) as the first step of the notification work.
