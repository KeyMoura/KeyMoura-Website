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
