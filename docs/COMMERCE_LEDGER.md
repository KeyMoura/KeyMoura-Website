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

## Pass 10 — merged and in production

Branch `staff-orders-reliability-communications-20260806` merged as **`f280abd`**,
which is the current production SHA. Merged with `--no-ff`, never force-pushed.

| SHA | What |
|-----|------|
| `ae252a0` | Rebuild `/staff/orders` so a failed query can never read as zero |
| `eb8f578` | Audit the whole staff area for the same defect |
| `d755500` | Point the dashboard's attention queue at the lists it counted |
| `d3c6b53` | 44px touch target on the queue chips |
| `b979024` | Record pass 10 |
| `f280abd` | Merge commit |

Vercel **production deployment: success** on `f280abd` (confirmed through the
GitHub deployments API, state `success`).

### Migration application — 2026-08-06

Applied with approval through `execute_sql` in **one guarded transaction**, not
`apply_migration` — that tool stamps its own timestamp as the version, which
caused six of the seven ledger drifts repaired in pass 3. The ledger row was
inserted by hand inside the same transaction under the repository filename's
version.

Guards before: view absent, exactly 40 migration rows, order and product counts
captured. Guards after: view present, exactly 41 rows, order and product counts
**unchanged**, and view row count equal to the order count. All held; committed.

**The ledger is exact: 41 repo files, 41 rows**, newest row
`20260806010000 / staff_order_queue_view`.

### Grants, verified role-switched

`execute_sql` connects as the table owner, who bypasses grants entirely — the
pass-8 lesson. Re-checked under `set local role`:

| Role | Result |
|------|--------|
| `service_role` | **SELECT succeeds** — 7 rows, which the API route depends on |
| `anon` | **refused** (`insufficient_privilege`) |
| `authenticated` | **refused** (`insufficient_privilege`) |

The probe ran inside a transaction ended with a sentinel exception to force
rollback.

`information_schema.role_table_grants` shows `anon` and `authenticated` with
**zero** privileges. `service_role` holds SELECT plus the inert
REFERENCES/TRIGGER/TRUNCATE that Supabase's default privileges grant on the
public schema — none of which is meaningful on a view, and no INSERT, UPDATE or
DELETE anywhere.

### Production smoke test — on `f280abd`

| Check | Result |
|-------|--------|
| Storefront | `/` 200 (0.47 s), `/catalog` 200, `/cart` 200, `/shipping` 200, `/refunds` 200 |
| `GET /api/cart`, `/api/cart/fulfillment` | both 200 against the real database |
| Staff routes gated | `/staff`, `/staff/orders`, `/staff/fulfillment`, `/staff/inventory`, `/staff/reconciliation`, `/staff/emails`, `/staff/catalog` all **307** |
| New API gated | `/api/staff/orders` and `/api/staff/orders?view=needs_review` both **307** |
| `staff_order_queue` as `service_role` | **7 rows**, matching 7 orders |
| Production data | orders 7, products 2, order_items 2, carts 3, refunds 0, returns 0, jobs 0, adjustments 2, reservations 1, notifications 8, templates 30, migrations 41 |
| KM-0001 / KM-0002 | **untouched** at 2500 and 100 |

**A route-existence probe is still not possible in production**, and a chunk
fingerprint is not either: middleware 307s `/staff/*` before routing, so the
staff bundle's chunk names are never served and cannot be searched for the new
strings. Deployment is evidenced by the GitHub deployment state and the local
build output instead. Two probes that measured nothing were discarded rather
than reported: the served HTML carries no `buildId`, so polling it for a change
compared an empty string with an empty string.

### Production is busier than pass 9 recorded

Pass 9 recorded 6 orders and 1 order item. Production now holds **7 orders and 2
order items**, plus 2 inventory adjustments and 1 reservation. KM-0007 is a
genuine **paid direct purchase** created 2026-08-06 11:25 UTC — the first real
order through the pass-8 reservation and checkout path. **Nothing in this pass
wrote to production**; the only write was the migration above.

### Owner checks worth five minutes

1. Sign in as staff and open `/staff/orders`. The queue chips should carry real
   counts, and KM-0007 should appear under **Ready to fulfill** or **In
   production** depending on its job state.
2. Click a saved view, then use the browser Back button. The list and the
   highlighted chip should both return to the previous queue.
3. Open `/staff` and click one of the attention chips. It should land on a
   filtered list containing exactly the orders that chip counted.
4. On a phone, confirm the queue chips are comfortable to tap.

## Pass 11 — consequential action safety on the staff order workspace

Branch `staff-order-action-safety-20260806`, from `03127b3`. The action matrix
lives in [`docs/STAFF_ORDER_ACTIONS.md`](STAFF_ORDER_ACTIONS.md) and is the
reference for what each control does; this section records what changed and what
was verified.

### What the audit found

Passes 8–10 had already made the *lifecycle* routes safe: fulfillment,
cancellations, returns, refunds and production all carry guarded transitions,
409 conflicts, server-recomputed amounts and idempotency keys. Re-read them all;
none needed loosening and none was loosened. Three real gaps remained.

**1. The order row itself had no expected-state guard.** `PATCH
/api/staff/orders/[id]` did a blind `update().eq("id", id)`. Two staff pressing
"Accept & continue" a moment apart both succeeded — each read `requested`, each
wrote — and because each inserted its own `order_status_history` row, the derived
email `eventKey` differed and the customer got **two emails**. Now `status` and
`quote_revision` are both asserted in the `WHERE` clause and the write reports
whether it matched, so the second request is a 409 naming where the order
actually is. `quote_revision` matters separately: two staff repricing an order
never change its status, so a status comparison alone would let the second price
win silently.

**2. `shipment_action` was a second, unguarded fulfillment path.** Dead since
pass 8 — no caller — but still live as an endpoint, and worse than dead code. It
required only `orders.manage` where handing goods over needs
`fulfillment.manage`, so anyone who could edit an order could ship one; and it
never wrote `fulfillment_status`, the column the cancellation and return rules
read, so an order shipped through it stayed "unfulfilled" and still looked
cancellable. It now answers **410**. Fulfillment has exactly one write path.

**3. Confirmation was `window.confirm`,** with the cancellation reason collected
by a separate `window.prompt`. That cannot separate the money from the stock from
the email, cannot validate the reason, and cannot hold a 409 where the decision
was made.

### The shared framework

`ConsequentialAction` (`src/components/staff/ConsequentialAction.tsx`) replaces
every `window.confirm` and `window.prompt` in the workspace. It renders the
current and proposed state, four named effect lines — customer / money / stock /
email — a notification preview, an optional required reason, and separate
customer-visible and internal note fields that say which is which.

It is deliberately **not** an abstraction over business rules. It knows how to
ask; the server decides what is legal, and every caller still posts to a route
that re-checks everything.

Two properties are load-bearing:

- **A ref, not state, blocks the second submit.** `pending` is React state, and
  two clicks in one batch both read the stale value. `inFlight` is checked and
  set synchronously.
- **A conflict removes the confirm button** rather than re-arming it. A stale
  consequential action must never be retried, so the dialog offers Close and
  Reload instead.

`resultFromResponse` lives in `src/lib/staff/actionResult.ts` — plain TypeScript
so it can be tested directly — and is where "may this be retried, and may this
message be shown" is decided. A 500's text is dropped rather than displayed:
that is the status a route returns when something unplanned happened, which is
exactly when the message is most likely to name a constraint or a row value.

### Duplicate messages, closed at the database

The send button had no pending state and the email's event key was the row id of
the message just inserted — a *different* id on the second click. Two clicks
meant two customer messages and two emails. A per-order `client_token` now
collapses a double-click, a retried fetch and a resubmitted form into one
message. The token is sanitised before it reaches the index.

### Migration `20260806020000_order_message_client_token` — applied 2026-08-06

Additive: one nullable column, one **partial** unique index
(`where client_token is not null`), so the existing rows all carry null, never
collide, and need no backfill.

Dry-run first, in a transaction ended with a sentinel exception to force
rollback. Three proofs: existing rows untouched and all null; a duplicate token
on the same order is refused; the same token on a *different* order, and
multiple nulls on the same order, are all accepted. Then a separate **rollback
rehearsal** — apply, run the down statements, compare the column list — which
came back byte-for-byte identical.

Applied with approval through `execute_sql` in one guarded transaction, not
`apply_migration`; that tool stamps its own timestamp as the version, which
caused six of the seven ledger drifts repaired in pass 3. The ledger row was
inserted by hand under the repository filename's version inside the same
transaction.

Guards before: 41 migration rows, column absent. Guards after: 42 rows, column
and index present, **message count 2 and order count 8 unchanged**, and no
existing row gained a token. All held.

**The ledger is exact: 42 repo files, 42 rows**, newest
`20260806020000 / order_message_client_token`.

Grants re-checked under `set local role service_role`, rolled back: the insert
with a token succeeds and the duplicate is refused. Table-level grants cover a
new column; `anon` holds only the inert REFERENCES/TRIGGER/TRUNCATE.

### Tests

**1063 passing, 0 failing.** 33 are new (`tests/staff-order-action-safety.test.ts`),
including real exercises of the response mapping — a 409 becomes a conflict, a
500 never surfaces `constraint`/`DETAIL`/a table name, the fulfillment route's
`status` key and the order route's `currentStatus` key both land in the same
place.

Eight existing tests failed against the new code and were **re-pointed, not
deleted** — each now asserts the property where it moved to, and in several cases
more strictly than before:

| Test | Was | Now |
|------|-----|-----|
| fulfillment validates tracking | asserted the `shipment_action` branch | asserts the fulfillment route, plus tracking *shape* and method narrowing |
| shipping vs pickup language | pinned a ternary in the order route | asserts distinct states and labels, which cannot be conflated by editing one condition |
| staff panel disables in flight | counted `disabled={Boolean(busy)}` | asserts the synchronous `inFlight` ref, which is stricter than the state it replaces |
| refunds confirmed | required `window.confirm` | requires the dialog, `tone="money"`, and all four effect axes |
| review package / status override | pinned button labels | assert the send and the current→proposed state pair |

### Browser verification — the dialog, live

The staff area needs a real session (middleware redirects `/staff/*` to
`/auth/login` even locally, and signing in would mean handling a password), so
the component was mounted on a temporary local-only page, driven in a real
browser, and the page deleted. The working tree is clean; nothing probe-related
is in the diff.

| Check | Result |
|-------|--------|
| Portalled to `document.body` | ✔ — `get_page_text` reads `<main>` and could not see it |
| `role="dialog"`, `aria-modal`, `aria-labelledby` | ✔ all present, heading resolves |
| Body scroll locked while open, released on close | ✔ |
| Focus moves into the dialog on open | ✔ lands on the reason field |
| Required reason gates the confirm | ✔ disabled until typed, then enabled |
| **Three clicks in one tick** | ✔ **exactly 1 submit**; button reads "Working…" and is disabled |
| 409 conflict | ✔ confirm button **replaced** by Close / Reload; "Nothing was applied" |
| Escape closes, focus returns to the trigger | ✔ |
| Tab trap wraps both directions | ✔ 4 focusables, last→first and first→last |
| Mobile 375×812 | ✔ full-width bottom sheet, no horizontal scroll, 46px touch target |

Console carries a pre-existing `data-motion` hydration mismatch on the root
layout — present on `/` as well, unrelated to this pass and not fixed here.

### Not done, and why

**Manual email resend does not exist and was not built.** `/staff/emails` edits
templates and sends a *test* to the signed-in staff address; there is no route
that re-sends a transactional email to a customer. Adding one is a new
outbound-email capability rather than a safety fix — it is the single item in the
brief whose absence is safer than a hurried implementation. Recorded with the
constraints it would have to meet: recipient taken from the order and never from
input, event key derived from the original delivery, an explicit audit event, no
free-form recipient field.

### Residual risks

- The quote/status route still writes several concerns in one PATCH. Guarded
  now, but "send a quote" and "save a note" deserve separate routes.
- `restore_order_inventory` is idempotent by ledger arithmetic (`having sum(delta)
  < 0` plus a per-leg idempotency key) rather than by a constraint. Verified by
  reading it; worth a regression test if the reason codes ever change.
- Email delivery is single-attempt. A failure is recorded in `email_deliveries`
  and visible on the order, but there is no retry — the other half of the resend
  gap above.

---

# Pass 12 — transactional communications, notification deduplication, integration health, launch readiness

Branch `communications-notifications-launch-readiness-20260806`, from `0bd6ccf`
→ merged as **`0cc2ab8`**, with a follow-up fix at **`299912d`**, which is the
current production SHA. Merged with `--no-ff`, never force-pushed.

## Verified starting state — 2026-08-06

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `0bd6ccf` |
| Production health | `/` 200 (0.43 s), `/catalog` 200, `/cart` 200, `GET /api/cart` 200 |
| Migration ledger | **exact** — 42 repo files, 42 rows, versions and names identical |

## What the audit found

`sendCommerceEmail` existed and worked, and three things about it were wrong.

1. **It sent before it recorded.** The `email_deliveries` upsert ran *after* the
   provider call, so two concurrent calls carrying the same event key both sent.
   The only thing between a customer and two identical emails was Resend's own
   `idempotencyKey` — a provider-side 24-hour window, not a durable guarantee,
   and absent entirely for any provider swapped in later.
2. **Thirteen events had no email at all**, and several had the wrong one. A
   direct purchase received a payment receipt and never an order acknowledgement.
   A failed payment rang a bell and told nobody. A revised quote announced
   "your quote is ready" for the third time with a different number.
3. **`notifications` had no `event_key`**, so `createNotification` inserted
   unconditionally. Stripe replays were caught upstream by
   `stripe_webhook_events`, so no duplicate had been observed — but every
   non-Stripe path could produce two identical rows in a staff member's bell.

## The transactional email matrix

`src/lib/comms/emailEvents.ts` is the catalogue **as data**, and
`docs/TRANSACTIONAL_EMAIL_MATRIX.md` is generated from it. That arrangement is
deliberate: this ledger's own count of the email catalogue was wrong in three
consecutive passes, because a matrix kept only as prose drifts the moment
somebody adds a send call. `tests/transactional-emails.test.ts` asserts the
module against the routes, so an uncatalogued send fails the suite and a
catalogued template with no seeded row fails it too.

**51 events across 43 templates; 47 wired, 4 recorded-not-built.** The four
unbuilt ones — quote expiry, payment reminders, fulfillment-overdue email and
reservation-inconsistency email — all need the same missing thing: a scheduled
job runner. Sending any of them from a page load would mean whoever opened the
page triggered the customer's email. They are specified and unbuilt rather than
half-wired.

### A live defect the matrix test found

Pass 8 seeded five templates interpolating `{{carrier}}`, `{{tracking_number}}`,
`{{pickup_location}}`, `{{pickup_instructions}}`, `{{fulfillment_method}}` and
`{{date}}` — and **nothing ever supplied any of them**. A real shipped email
read *"has shipped with . Tracking number: ."* and the ready-for-pickup notice
had two blank paragraphs where the collection address belongs. The variables are
now supplied, filtered through `filterCustomerVariables` so a route cannot
smuggle an internal note into a template by inventing a variable name for it.

## Claim before send

The sender now claims the event with an insert against the unique `event_key`
*before* the provider is reached. Exactly one caller wins; the loser reads what
the winner recorded:

- `sent` or `delivered` — the customer already has it. Never sent again.
- `queued` — somebody is sending it right now. Suppressed rather than raced.
- `failed` or `skipped` — nothing reached the customer, so a retry is correct.
  The row is re-claimed with a guarded update and `attempt_count` goes up.

Failures are classified into a category staff may safely be shown; the raw
provider string is stored for diagnosis and never rendered, because it can quote
the address it refused. Subject lines strip CR/LF from interpolated values —
`customer_name` comes from user metadata, which the customer controls, and the
subject is the one interpolated string that does not pass through `escapeHtml`.

A failed **customer** email raises an in-app alert and never another email.
Emailing about a broken mailer is how a failure loop starts.

## One way to notify staff

`raiseOperationalAlert` replaces `notifyStaffByPermission`, which is **removed**
rather than kept beside it. Both fanned a notification out by permission, but
only one deduplicates, carries a priority, and takes its title and deep link
from a catalogue. Two ways to notify staff is how half the alerts end up
undeduplicated: the next one gets written against whichever helper the author
finds first.

Every alert is routed to the permission that can act on it — `refunds.issue`
for a failed refund, `returns.review` for a return, `inventory.view` for stock —
rather than to `orders.manage` for everything. Stock coming back announces a
resolution, because an alert nobody ever sees close teaches staff that the bell
is a list of things that were once true.

## Four staff surfaces

**Delivery history** (`/staff/emails/deliveries`) shows a masked recipient, not a
full address; a failure *category*, not the provider's message; and neither the
event key nor the provider id — a key on a screen is a key somebody can reuse.
No message body appears anywhere. Search matches the order number and never the
recipient: matching on an address would turn this into a way to ask "is this
person a customer".

**Resend** is deliberately not a composer. There is no recipient field, no
subject field and no body field anywhere in the request. A resend control that
accepts a recipient is an open relay behind a staff permission. The event key is
derived from the original's plus an attempt number, so two staff pressing the
button in the same moment compute the same key and the customer gets one copy.
The original row is never modified.

**Integration health** (`/staff/integrations`) exists for one distinction:
*verified* versus *assumed*. An environment variable being present proves
configuration, and every previous pass here was caught by that gap — pass 5a's
missing grants behind correct RLS, pass 7's deployed-but-unsubscribed refund
handler, pass 5's analytics script that refuses to run under automation. Nothing
on the page charges, refunds, emails or probes. Stripe Tax reports as
deliberately not integrated and can never read as healthy.

**Launch readiness** (`/staff/launch-readiness`) links every issue to the exact
setting that fixes it and says which workflow depends on it. It refuses to claim
legal, tax, accessibility or security compliance, and **a blocker cannot be
acknowledged away** — that would make the one part of the page that has to be
believed the part that can be silenced.

**Discrepancy review** (`/staff/launch-readiness/discrepancies`) records a
conclusion about KM-0001 and KM-0002 and nothing else. It never writes a payment
row, never changes a total and never contacts Stripe. A missing payment row is
not proof that no payment was taken — it is at least as likely that money changed
hands and the record was never written, which is exactly the bug pass 7 fixed.

## Migration `20260806030000_communications_center` — applied 2026-08-06

Applied with approval through `execute_sql` in **one guarded transaction**, not
`apply_migration` — that tool stamps its own timestamp as the version, which
caused six of the seven ledger drifts repaired in pass 3. The ledger row was
inserted by hand inside the same transaction under the repository filename's
version.

### The status constraint, and the probe that caught it

`email_deliveries_status_check` admitted only `sent`, `failed`, `skipped`. The
new claim writes **`queued` first** — so every transactional email would have
died with `23514` at the claim, before the provider was reached. **Found by a
live dry-run probe against production**, not by the test suite: every assertion
in this pass reads source or migration text, and none of them knew what the live
constraint held.

Widened to `queued`, `sent`, `delivered`, `failed`, `skipped`, by
**add-then-drop-then-rename**: the wider constraint validates every stored row
while the narrower one is still in force, so a row that could not satisfy it
fails the `ADD` rather than leaving the table unconstrained.

`delivered` is admitted but **nothing writes it** — Resend delivery webhooks are
not wired. It is legal so the claim treats it as "the customer has it" and so
wiring that webhook later is a code change rather than another constraint change
on a live table. It is excluded from the UI filter, because a filter returning
nothing reads as "nothing has been delivered" when the truth is that delivery is
not tracked. No `sending` (duplicates `queued`) and no `retried` (a retry
re-claims to `queued`; the count lives in `attempt_count`). "Suppressed" is a
*label* on the stored `skipped` — a rename would migrate 26 live rows to say the
same thing.

### Guards and verification

Before: 42 migration rows, `event_key` absent, constraint un-widened, 26
deliveries, 30 templates. After: 43 rows, 8 columns, 3 tables, 1 function, 10
explicit indexes (plus 3 primary keys), 3 policies, 43 templates, and
orders/notifications/deliveries all unchanged. All held; committed.

**The ledger is exact: 43 repo files, 43 rows**, newest
`20260806030000 / communications_center`.

Two full dry-runs preceded it, each ended with a sentinel exception, with
production verified untouched after each.

### Grants, verified role-switched

`execute_sql` connects as the table owner, who bypasses grants entirely — the
pass-8 lesson. Re-checked under `set local role`:

| Role | Result |
|---|---|
| `anon` | **refused** SELECT on all three tables; **refused** EXECUTE on the function |
| `authenticated` | SELECT only, behind the staff RLS policy; **refused** INSERT; **refused** EXECUTE on the function |
| `service_role` | SELECT/INSERT/UPDATE on two tables, SELECT/INSERT only on `integration_health_events`; **refused** UPDATE on an observation; **refused** DELETE on all three |

**Supabase security advisors: no new findings.** None of the three new tables
appears in `rls_enabled_no_policy`, and `migration_ledger_versions` appears in
neither the anon nor the authenticated security-definer warning, because the
revoke ran.

### Live behavioural probes, rolled back

Queued claim accepted; duplicate event key refused; failure recorded with a
category; retry incremented `attempt_count` to 2; resend created a linked row
with the original untouched; a double-clicked resend refused; an invented status
(`sending`) refused; notification dedup per recipient with nulls still accepted.
Production verified unchanged afterwards, and **no email was sent** — no delivery
row exists in the deployment window.

## Four columns the schema does not have — `299912d`

Found by running the new routes' own queries against production as
`service_role`, which is the check a passing suite could not make.

| Named | Reality |
|---|---|
| `order_payments.status` | no status column; a row exists only once money is recorded |
| `stripe_webhook_events.id` | keyed on `stripe_event_id` |
| `stripe_webhook_events.created_at` | timestamped `received_at` |
| `products.base_price_cents` | the column is `starting_price_cents` |

Each would have been **silent and confidently wrong**, which is worse than an
error:

- The discrepancy finder guarded `orders.error` but not `payments.error`, so an
  empty map would have made **every paid order** read as having no payment
  record behind it — the readiness page announcing the whole shop's takings
  unaccounted for. That is the `data ?? []` defect the staff-page audit exists to
  catch, in a directory the audit does not walk.
- A refused unprocessed-webhook count fell to `?? 0`, so the blocker that catches
  an order settling at Stripe and never settling here would have read "every
  received webhook completed" without counting anything. It is now
  null-when-unknown and reports a warning rather than a pass.
- A failed products read would have reported an empty catalog: "nothing is
  published" plus several downstream blockers, all false.

The generalizable fix is a test that parses every `.from(t).select(c)` in the
modules this pass added and checks each column against what the migrations
create. `installer.test.ts` has proved *relations* exist since pass 9; this is
the column-level equivalent, and it found all four.

Verified after the fix against real data: the finder now reports **exactly
KM-0001 and KM-0002**, not every paid order.

## Validation

- **1202 tests pass, 0 fail** (1063 at `0bd6ccf`; 139 added across four new
  suites, plus two existing suites re-pointed and made stricter).
- Typecheck clean. Production build clean from a cleared `.next`, exit 0; all 7
  new API routes and 4 new pages present.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings), measured by
  running the same command on a worktree of `main` and on this branch. Every new
  and changed file lints **completely clean**.
- Vercel **preview build: success**. Vercel **production deployment: success** on
  both `0cc2ab8` and `299912d`.

### Two existing suites re-pointed, not weakened

- `payment-monitoring` pinned `title:"Customer payment failed"`, a string that
  moved into the alert catalogue. It now asserts the alert *kind* and its durable
  key — which is what makes it able to fail — plus the two new payment-failure
  emails.
- `staff-navigation` now proves the new entries are permission-gated and that the
  delivery centre is owned by the email entry rather than listed twice.

### Driven in a real browser

The staff area needs a real session (middleware redirects `/staff/*` to
`/auth/login` even locally, and signing in means handling a password), so the
page components were mounted on a temporary local-only route, driven, and the
route deleted. The working tree is clean; nothing probe-related is in the diff.

| Check | Result |
|---|---|
| **Three clicks in one tick** | **exactly 1 submit** — the synchronous `inFlight` ref |
| 409 conflict | confirm button **replaced** by Close / Reload; "Nothing was applied" |
| Dialog semantics | portalled to `body`, `aria-modal`, labelled, body scroll locked |
| **No recipient field** | 1 input in the resend dialog — the internal note |
| Escape / Tab | closes and restores focus to the trigger; trap wraps both ways |
| Masking | no full address, no provider id, no event key in the DOM |
| Failed load | `role="alert"`, dashes not zeros, no "no messages match" |
| Genuinely empty | "That is a complete answer" |
| Read-only staff | page renders; **no resend button**; "Needs the re-send permission" |
| Unauthorized staff | access-denied card naming the permission; no table |
| Anonymous | every new page and API **403 locally / 307 in production** |
| Blocker | offers no acknowledge control and says why |
| Mobile 375 | no sideways scroll on any of the four pages; the wide table scrolls in its own container |
| Accessibility | one `h1` each, no heading skips, every control named, named regions |

**One defect found by measuring rather than reading:** the card action links were
**16px** tall — the primary action on each integration and readiness card. Now
44px, matching the queue chips pass 10 raised for the same reason.

Console carried only the **pre-existing** `data-motion` hydration mismatch on the
root `<html>`, which reproduces on `/`, plus the local 503 from the deliberately
fake service-role key.

### Production smoke test — on `299912d`

| Check | Result |
|---|---|
| Storefront | `/` 200 (0.79 s), `/catalog`, `/cart`, `/shipping`, `/refunds`, `/terms`, `/privacy` all 200 |
| Public API | `GET /api/cart` and `/api/cart/fulfillment` both 200 |
| Staff pages gated | `/staff`, `/staff/emails`, `/staff/emails/deliveries`, `/staff/integrations`, `/staff/launch-readiness`, `/staff/launch-readiness/discrepancies` all **307** |
| New APIs gated | all four **307** on GET and POST |
| Every new route query as `service_role` | **all OK** against real production data |
| Production data | 26 deliveries, 10 notifications, 9 orders, 43 templates, 43 migrations; new tables all empty |
| KM-0001 / KM-0002 | **untouched** at 2500 and 100 |
| Emails sent | **zero** in the deployment window |

## What the health page currently reports

Honest readings against real production state, worth knowing before an owner
opens it for the first time:

- **Stripe webhooks: degraded.** Only `checkout.session.completed` has ever been
  received. The other six handled types have not — which is *not* proof they are
  unsubscribed, and the page says so: a shop with no refunds has no refund
  events. Confirm the subscription in the Stripe dashboard.
- **Resend: healthy and verified** — 25 sent, 0 failed in 30 days.
- **Stripe Tax: not configured**, deliberately, and never presented otherwise.
- **Vercel Analytics: assumed**, permanently. The served script refuses to run
  under automation, so a recorded pageview is only observable in a normal browser.
- **Two historical discrepancies awaiting review:** KM-0001 and KM-0002.

## External setup still required

1. **Grant the six new permissions** to whichever non-admin roles should hold
   them, in `/staff/security/roles`. Admins already have all six. **Be
   deliberate with `emails.resend`** — it is the one that causes a real email to
   leave the building.
2. **Configure a staff alert address** at `/staff/emails`. Until it is set, the
   new staff alerts (new order, cancellation request, return request, payment
   failure) reach the in-app bell only, which needs somebody signed in to see.
3. **Review KM-0001 and KM-0002** at `/staff/launch-readiness/discrepancies`.
   Nothing automated will ever touch them.
4. **Resend delivery webhooks are not wired**, so no message reaches `delivered`.

## Deferred, honestly

1. **Support tickets** and **verified-purchase reviews** — the brief gates both
   behind communications and launch readiness being complete, and both are their
   own systems.
2. **Scheduled work**: quote expiry, payment reminders, fulfillment-overdue and
   reservation-inconsistency emails. All four are specified in the matrix with
   `wired: false` and the reason stated.
3. **Delivery confirmation** — a Resend webhook endpoint. The `delivered` status
   is legal so this becomes a code change, not a migration.

## Residual risks

- **`service_role` retains TRUNCATE** on the three new tables, inherited from
  Supabase's default ACL on the public schema. DELETE is revoked everywhere and
  the application never truncates, but TRUNCATE is not filtered by RLS and would
  remove acknowledgement, review and observation history. This is the
  pre-existing pattern on every table in this database, and closing it is a
  one-line `revoke truncate ... from service_role` — deliberately **not** done
  here, because it is a permission change outside the approved migration.
- The discrepancy route's *evidence display* reads payment rows a second time
  without its own error guard. The authoritative amounts come from the guarded
  finder, so a failure there under-reports a row count rather than inventing a
  discrepancy.
- Email delivery remains single-attempt at the point of sending. A failure is
  recorded, alerted, and re-sendable by hand; there is no automatic retry.

---

# Pass 13 — storefront catalog, guest commerce, providers, quantity and layout defects

Branch `storefront-catalog-guest-commerce-20260806`, from `f4732d8`.
**Not merged. Two migrations await approval and have not been applied.**

## Verified starting state — 2026-08-07

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `f4732d8` |
| Production health | `/` 200 (0.50 s), `/catalog` 200, `/cart` 200, `GET /api/cart` 200, `/staff` 307 |
| Migration ledger | **exact** — 43 repo files, 43 rows, versions and names identical |

## The two reported defects

### 1. Typing a quantity was replaced by the stock maximum

Every quantity field clamped **on every keystroke**:

    const next = Number(event.target.value);
    setQuantity(Math.min(Math.max(1, next), maxQuantity ?? 999));

With five in stock and `1` in the box, typing `2` makes the intermediate
string `"12"`, and `Math.min(12, 5)` is `5`. Clearing first does not help:
`Number("")` is `0`, `Math.max(1, 0)` is `1`, so the box refills itself the
instant it is emptied and the next keystroke appends to a digit nobody typed.
**The arrows worked because they never produce an intermediate value** — which
is exactly what the report said.

`src/lib/commerce/quantity.ts` holds the rules, pure and dependency-free. A
keystroke is not a decision: the field holds what was typed until commit —
blur, Enter, or a step button. Refusals are named rather than coerced, which is
the lesson pass 4 recorded when `Math.trunc` published a 12% code for somebody
who typed 12.5.

One control, `QuantityField`, now serves the product page, the cart page, the
cart drawer and both request wizards. The cart surfaces additionally stop
posting a mutation per keystroke — clearing the box used to ask the server for
`quantity: 0`. Native spinners become real 44px buttons with accessible names;
a native spinner arrow has none. ArrowUp/ArrowDown are kept on the field.

The untracked ceiling drops from 999 to 99, matching `MAX_LINE_QUANTITY`, which
the server already enforced: 500 could previously be typed and silently become
99. Surfaces with a different server rule state it — the request wizard passes
1000, which is what `/api/orders/custom` allows.

### 2. The purchase panel had its own scrolling area

`.product-info-sticky` was `position: sticky` with
`max-height: calc(100dvh - …)` and `overflow-y: auto`, so price, quantity, Add
to cart and Request a custom version scrolled inside the page's own scroller,
with `overscroll-behavior: contain` stopping the page at the panel's end.

**Sticky was removed rather than repaired.** It could only be kept if the panel
were reliably shorter than the viewport, and it is not — that column carries the
title, summary, badges, options, actions, quick facts and assurances. A sticky
box taller than the viewport pins its top and puts its own foot out of reach,
which is the failure the `max-height` was papering over. The mobile sticky
action bar is unchanged.

## Catalog: real category routes and a browse menu

The redesign pass 6 planned and deferred.

**The URL conflict, and how it was resolved.** The requested shape is
`/catalog`, `/catalog/[category]`, `/catalog/[category]/[subcategory]` — but
`/catalog/[slug]` was already the product route and Next.js cannot have two
dynamic segments in one position. Products were **not** moved:
`/catalog/premade-shift-knob` is live, indexed and linked from the cart,
wishlist, order pages and transactional email. The segment resolves a category
first and a product otherwise, and `20260806040000` makes the ambiguity
unrepresentable rather than resolved by precedence. **The documented rule: a
slug identifies at most one thing under `/catalog`.**

One view, one URL: a subcategory reached without its parent redirects to its
canonical address, `/catalog?category=` redirects to the real page, and both
segments of a two-segment path are checked against the tree, so
`/catalog/exterior/shift-knobs` is a 404 rather than a second address.

**Navigation.** A horizontal row of top-level chips with a second row of
subcategories for the branch you are in — not a permanent sidebar, which with
one category today would be a mostly empty column taking a third of the width
from the products. Below `sm` both rows give way to a real dialog sheet.

Counts are exact because every published product is loaded for the page; a
category with nothing in it is not offered at all. Filters live in the URL, so
Back returns to the previous view and the highlighted chip follows.

**The search box is debounced**, found by driving the page: this is a server
component, so a `router.replace` per keystroke cost a full RSC round trip
(~1.5s in dev) for a payload that came back identical. The grid responds
immediately; the URL catches up when the typing pauses and is still the source
of truth.

**Schema was already sufficient** — `parent_id`, unique slugs, `display_order`,
`is_active`, `archived_at` and the one-level trigger have existed since
`20260802020000`. What was missing was the staff surface: the category API has
had no page in front of it since pass 6. `/staff/catalog/categories` drives it,
importing its rules from the same module the route does.

## Guest commerce

Recorded as "unrepresentable, not merely unimplemented" since pass 3, for one
reason: `orders.customer_id` was NOT NULL.

**The credential.** A 32-byte opaque token in an httpOnly cookie; only a salted
digest is stored. It never appears in a URL, a log or a redirect — a URL lands
in history, in a `Referer`, and in whatever a customer pastes into a support
chat. Access needs a live hash **and** an unexpired window; a null expiry is
treated as expired, so a row that lost it fails closed. Revocation is clearing
the hash, following the rule pass 3 set for share links: there is then nothing
left to compare against.

**There is deliberately no lookup by order number and email.** Order numbers are
sequential, so that form is really "is this address a customer here" — a
guessing oracle. A guest who has lost the cookie is told to contact support,
which is a person checking rather than a form guessing.

**Guest checkout is not a second pricing path.** Revalidation, fulfillment
planning, the reservation, the order write, the session expiry pinned to the
hold, and the idempotency key are the same code for both identities. Only the
identity columns, the receipt address and the landing page differ.

**The webhook binding was vacuous for a guest.** It compared
`metadata.customer_id !== order.customer_id`; for a guest both are null, and a
comparison that authorises everything must never be what settles money. A guest
session must now say it is one **and** be the session the order recorded — an id
minted by Stripe and written by the checkout route, which is a stronger binding
than the one it stands in for. The **failed-payment branch was skipping guests
entirely**, which would have left the inventory hold unreleased and nobody told;
it now keys on the same marker.

**What a guest can and cannot do.** Read their order, reply to staff, and pay an
approved quote. Cancellations and returns stay account-only and say so: each is
a financial workflow with its own eligibility rules, staff decision and refund
path, and a button that appears to work and is refused server-side is worse than
one that is not offered.

**Guest requests** are gated by a setting, a rate limit (5/hour, tighter than
any signed-in equivalent) and **Turnstile when configured** — the keys
`/staff/integrations` has tracked since pass 12 now have a verifier behind them,
fail-open unconfigured and fail-closed once set, with no "allow on network
error". Files stay account-only: the storage prefix is keyed on an authenticated
user, and inventing a public write bucket in passing is not a thing to do
quietly. The form says so rather than dropping an attachment.

## Discord replaced by Facebook

**Audited against production first: 3 users, 0 with a Discord identity, 0 whose
only method is Discord.** Nobody's login path was removed, so no transition plan
was needed.

Nothing was disabled in Supabase Auth and no identity was unlinked — the UI
stopped *offering* Discord, which is a different thing from the project refusing
it. An already-linked provider stays visible and removable even once it stops
being offered, so a Discord identity would still render by name and still be
disconnectable. `'facebook'` was verified against the installed
`@supabase/auth-js` `Provider` union in `node_modules`, not remembered, and the
handlers are typed to that literal so a typo is a compile error.

The last usable login method still cannot be disconnected, OAuth still returns
to `window.location.origin`, and the post-sign-in destination still refuses
anything that is not a path on this site (including `//evil.example`).

## Migrations — written, dry-run, **not applied**

| File | What |
|---|---|
| `20260806040000_catalog_slug_namespace.sql` | Two trigger functions + four triggers enforcing one slug namespace under `/catalog`. No column, constraint, policy or row altered. |
| `20260806050000_guest_commerce.sql` | Widens `orders.customer_id` and `order_messages.sender_id`; adds `guest_email`, `guest_name`, `guest_token_hash`, `guest_access_expires_at`, three CHECKs and two partial indexes. |

Both are guarded on the existing data before installing anything, so neither can
leave a table in a state its own guard would refuse. Neither issues a grant:
columns inherit the table's ACL, which is why the pass-5a failure mode is
unreachable here — and the migration says so rather than leaving the next reader
to wonder.

**Dry runs against production, both rolled back, production verified untouched
after each.** Catalog namespace: five proofs — a colliding category refused, a
free slug accepted, a colliding product rename refused, an unrelated product
save unaffected, a category rename onto a product slug refused. Guest commerce:
five proofs — existing rows unchanged and none gaining guest data, a guest order
representable, an ownerless order refused, a malformed address refused, a guest
reply accepted.

**Rollback rehearsal**: applied, then the down statements run, then the `orders`
column signature compared — byte-for-byte identical.

**RLS, role-switched**: a guest order is invisible to `authenticated` (RLS
returns 0 rows, because `auth.uid() = customer_id` is NULL against NULL, which
is not TRUE), and `anon` is refused at the **grant** layer before RLS is
consulted at all.

## Validation

- **1323 tests pass, 0 fail** (1202 at `f4732d8`; 121 added across four new
  suites).
- Typecheck clean. Production build clean from a cleared `.next`, exit 0; all
  new routes present.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings). Two errors
  this pass introduced were found and fixed rather than suppressed — a setState
  inside an effect, and `Date.now()` in a component body.
- Nine existing assertions re-pointed and made stricter, including the two that
  pinned the signed-in-only checkout contract and the one that *required* the
  `max-height` on the purchase panel.

### Driven in a real browser

Dev server, cold start with a cleared `.next`.

| Check | Result |
|---|---|
| **stock 5, type 2** | **`2`** — the reported bug, on the real product with 5 in stock |
| stock 5, type 5 / 6 | `5` / `5` with "Only 5 available." |
| 0 / −1 / 2.5 | `1` "Use Remove…" / `1` "smallest quantity is 1" / restored, "whole units" |
| abc / 1e3 | previous value restored, "Enter a quantity as a number." |
| paste 3 | `3` |
| empty while editing | **stays empty**; on blur restores the previous value |
| while typing, every case | the box held **exactly** what was typed — no mid-edit clamping |
| − / + / ArrowUp / ArrowDown / Enter | all work; clamped and disabled at both bounds |
| **Nested scrollers in the product page** | **0** |
| Purchase column | `position: static`, `overflow-y: visible`, `max-height: none` |
| Catalog routes | `/catalog` 200, `/catalog/interior` 200, `?category=Interior` **307 → `/catalog/interior`**, unknown slug 404, wrong parent 404 |
| Category page | correct title, h1, breadcrumb, canonical, `aria-current`, exact counts |
| Mobile 375 | chip rows hidden, trigger 44px, dialog portalled to `body` at 375×645, body locked, focus in and back, Escape, **Tab trap wraps both ways**, no sideways overflow |
| Filters | grid responds immediately; URL catches up after the pause; Back/Forward track the dropdowns |
| Guest order page, no cookie | "Order not available", `noindex, nofollow, nocache`, no column names leaked |
| Guest APIs, no cookie | messages **403**, checkout **403** |
| Guest checkout validation | no email → 400 `field: "email"`; malformed → 400 with the specific sentence |
| Accessibility | one h1, no image without alt, every control named |

**Two console errors investigated and dismissed by a cold restart**: a
`useId` hydration mismatch in `QuantityField` and a `useState is not defined`
were both HMR artifacts of editing files while the dev server was live. On a
cold load the ids match and neither appears. What remains is the **pre-existing**
`data-motion` mismatch on the root `<html>` and the local 503s from the
deliberately fake service-role key.

### What could not be verified, and why

- **A real Stripe payment, guest or account.** Reaching one needs a real card.
  The arithmetic, the idempotency keys, the session binding and the refusal
  paths are covered by tests and by the HTTP-level probes above; the Stripe API
  call itself was not made.
- **A signed-in session.** Unchanged limitation from passes 3–12: signing in
  means handling a password. The guest paths — which are the new ones — *were*
  driven end to end without one, which is the first time this project has been
  able to exercise a commerce path in a browser.
- **The populated guest order page.** It needs a real guest order, which needs a
  real payment. Its access rules are covered by 45 tests and by the denial paths
  driven above.
- **No email was sent** and no Stripe charge or refund was created.

## Deferred, honestly

1. **Guest cancellations and returns.** Account-only, stated on the page.
2. **Cross-device guest access.** The credential is per-browser by design. A
   lookup by order number and email is the obvious feature and is deliberately
   not built — see above.
3. **Guest file uploads on custom requests.** Needs its own bucket, a
   signed-upload route and a retention decision.
4. **Server-side catalog pagination.** The whole published catalog is loaded so
   the browse counts can be exact. At a few hundred products the counts move to
   one grouped query and the grid to a paginated server query; the shape in
   `catalogData.ts` is what would change, not the pages. Recorded because the
   brief asked for pagination and this catalog holds two products.

## External setup still required

1. **Enable Facebook in Supabase Auth** if it is not already — the UI now offers
   it. Nothing here changed that configuration.
2. **Set `TURNSTILE_SECRET_KEY`** to switch the guest-request check on. Until
   then it is a deliberate no-op.
3. `commerce_settings.guest.allowCheckout` / `.allowRequests` both default on.

## Pass 13 — merged and in production

Branch `storefront-catalog-guest-commerce-20260806` → merged as **`ca174c1`**,
which is the current production SHA. Merged with `--no-ff`, never force-pushed.

| SHA | What |
|-----|------|
| `ffb2efe` | Fix the two reported purchase-control defects |
| `dfe8481` | Rebuild `/catalog` around real category routes and a browse menu |
| `ab80363` | Let guests buy, ask, reply and pay without an account |
| `8ada034` | Keep the catalog search responsive instead of a round trip per key |
| `f5fc4e3` | Record pass 13 |
| `ca174c1` | Merge commit |

- Vercel **preview build: success** on `f5fc4e3` (the final branch head).
- Vercel **production deployment: success** on `ca174c1`.

### Migration application — 2026-08-07

Both applied with approval through `execute_sql` in **two separate guarded
transactions**, not `apply_migration` — that tool stamps its own timestamp as
the version, which caused six of the seven ledger drifts repaired in pass 3.
Each ledger row was inserted by hand inside the same transaction under the
repository filename's version.

`20260806040000_catalog_slug_namespace` guards: 43 rows before, version not
already recorded, no slug triggers present, and **no existing slug naming both
a category and a product** — then 44 rows, 4 triggers, 2 functions, and
products/categories/orders unchanged.

`20260806050000_guest_commerce` guards: 44 rows before, `guest_email` absent,
and **no order with a null `customer_id` and no message with a null
`sender_id`** — then 45 rows, both columns nullable, 4 guest columns, 3
constraints, 2 indexes, order and message counts unchanged, and **no existing
row having gained guest data or lost its `customer_id`**.

All guards held; both committed.

**The ledger is exact: 45 repo files, 45 rows**, verified by diffing the two
sorted sets — symmetric difference empty. Newest rows
`20260806040000 / catalog_slug_namespace` and `20260806050000 / guest_commerce`.

### Verification after applying

| Check | Result |
|---|---|
| `orders.customer_id` / `order_messages.sender_id` | both **nullable** |
| Guest columns | `guest_access_expires_at, guest_email, guest_name, guest_token_hash` |
| Constraints | `orders_guest_email_shape`, `orders_guest_name_length`, `orders_owner_present` |
| Indexes | `orders_guest_email_idx`, `orders_guest_token_hash_idx` (both partial) |
| Slug triggers | all **4** present (insert + update-of-slug on each table) |
| Slug functions | both present, `SECURITY DEFINER` |
| Slug function EXECUTE | **false for `anon`, `authenticated`, `public` and `service_role`** — a trigger function needs none |
| Supabase security advisors | **no new findings**; neither slug function appears in either SECURITY DEFINER warning, because the revokes ran |
| Existing data | unchanged — 9 orders, 3 order items, 2 messages, 2 products, 1 category, 5 payments, 26 deliveries, 3 identities |
| Orders carrying guest data | **0** — no existing row was touched |

### Role-switched access, re-run against the live schema

Every probe ran inside a transaction ended with a sentinel exception.

| Role | Reading a guest order |
|---|---|
| `anon` | **refused at the grant layer** — no SELECT on `orders` at all, so RLS is never even consulted |
| `authenticated`, no uid | **0 rows** — `auth.uid() = customer_id` is NULL against NULL, which is not TRUE |
| `authenticated`, non-staff customer (two tested) | **0 rows** |
| `authenticated`, non-staff, reading another customer's account order | **0 rows** |
| `service_role` | select and update succeed, which the server routes need |

**A false alarm worth recording.** The first cross-customer probe picked the
customer owning the most orders and reported that they *could* read a guest
order. That account turns out to have `is_staff_user() = true` despite
`profiles.role = 'member'`, so it was the **staff arm** of the existing policy
— `(auth.uid() = customer_id) OR is_staff_user()` — working exactly as
intended. Re-run per-user, both genuinely non-staff customers see zero. The
lesson is the pass-8 one restated: a probe that measures the wrong subject
reports a defect that is not there.

`service_role` retains DELETE on `orders`. That is pre-existing and required —
the checkout route removes a shell order when the `order_items` insert fails —
not something these migrations opened.

### Guest lifecycle, exercised against the live schema and rolled back

| Check | Result |
|---|---|
| Reservation for a **guest cart** with `user_id` NULL | taken |
| Guest order written with `customer_id` NULL | accepted; `orders_owner_present` satisfied by `guest_email` |
| Hold linked to order + checkout session | 1 |
| Settlement (`record_stripe_order_payment` → `commit_order_inventory` → `commit_order_reservations`) | stock **5 → 3**, one ledger row |
| **Replayed webhook** | stock stays **3**, still one ledger row, still one payment row |
| Failed payment | hold released, **stock untouched at 5** |
| `checkout.session.expired` | released by session id, identity-agnostic |
| Ownerless order (no customer and no guest email) | **refused** by `orders_owner_present` |
| Malformed guest address | **refused** by `orders_guest_email_shape` |

**A probe of mine was wrong first.** It asserted that
`commit_order_reservations` decrements stock; it does not — it releases the
hold, and `commit_order_inventory` is the only writer of
`products.inventory_quantity`. Diagnosed by printing what the function returned
rather than assuming, then re-run calling both in the order the webhook calls
them.

### Guest custom requests, live schema, rolled back

Submit → secure view → reply → quote → payment preparation, plus every denial:
wrong token 0 rows, expired 0 rows, revoked (hash cleared) 0 rows, expired
quote refused. A guest reply stores with `sender_id` NULL; an internal staff
note on the same order stays out of what the guest reads (1 visible of 2).

### Authenticated flows, unchanged

Account direct checkout still reserves, settles and moves stock (5 → 4); the
account order carries **no** guest columns; an account custom request and an
account message still store with their `customer_id` and `sender_id`; and
`.eq("customer_id", user.id)` still resolves the account order.

### Guest-token behaviour

Re-run as the 45-test suite: valid token opens, wrong token denied, expired
denied, **null expiry denied** (fails closed rather than meaning "forever"),
revoked denied, and comparison is constant-time with a length check first so a
mismatched buffer cannot throw.

### Production smoke test — on `ca174c1`

| Check | Result |
|---|---|
| Storefront | `/` 200 (0.83 s), `/catalog` 200, `/catalog/interior` 200, `/catalog/premade-shift-knob` 200, `/cart`, `/shipping`, `/refunds`, `/terms` all 200 |
| Public API | `GET /api/cart` and `/api/cart/fulfillment` both 200 |
| Legacy category link | `/catalog?category=Interior` → **307 → `/catalog/interior`** |
| Unknown slug / wrong parent | **404** / **404** |
| Staff gated | `/staff`, `/staff/catalog/categories`, `/api/staff/catalog/categories` all **307** |
| Guest order page, no cookie | 200 rendering the refusal, `noindex, nofollow, nocache` |
| Guest APIs, no cookie | messages **403**, checkout **403** |
| Guest checkout validation | no email → 400 `field: "email"`; malformed → 400 with its own sentence |
| Public payload privacy | no origin address, return address, staff recipients, reservation timings or low-stock recipients |
| Sign-in page | **Continue with Google** and **Continue with Facebook**; **no Discord**; email and password still present |
| Emails sent in the deployment window | **0** |
| Stripe charges or refunds created | **0** |

Production data after the run — unchanged: 9 orders (**0 guest orders**, since
every probe rolled back), 3 order items, 2 messages, 2 products, 1 category, 5
payments, 0 refunds, 26 deliveries, 45 migrations, tracked stock still 5.

### Identity safety

**No identity was deleted or unlinked**: 3 identities before and after — 2
Google, 1 email, 0 Discord (there never were any), 0 deleted users. **No
Supabase Auth configuration was changed**; Discord's enabled/disabled state in
the Supabase dashboard is exactly as the owner left it, and this pass never
called an auth configuration API. The UI stopped *offering* Discord, which is a
different thing from the project refusing it.

### The two deferrals, restated

1. **Guest cancellations and returns remain account-only.** Each is a financial
   workflow with its own eligibility rules, staff decision and refund path. The
   guest order page says the team handles them rather than offering a control
   that would be refused server-side.
2. **Server-side catalog pagination is deferred** until catalog size justifies
   it. The whole published catalog is loaded so the browse counts are exact
   rather than estimated — the failure pass 9 recorded was a card reading 3
   opening a list of 5. At a few hundred products the counts move to one grouped
   query and the grid to a paginated server query; `catalogData.ts` is the module
   that changes, not the pages.

### Owner checks worth five minutes

1. **Confirm Facebook is enabled in Supabase Auth.** The sign-in page now offers
   it; if the provider is not enabled, the button will fail at Supabase. Nothing
   in this pass changed that setting.
2. Buy something as a guest, end to end, with a real card. That is the one path
   no automated session can complete.
3. Set `TURNSTILE_SECRET_KEY` if you want the guest-request check live; until
   then it is a deliberate no-op.

---

# Pass 14 — staff information architecture, schema repair, catalog rail

Branch `staff-ia-catalog-schema-repair-20260808`, from `2c0e0f6`.
**Not merged. One migration awaits approval and has not been applied.**

## Verified starting state — 2026-08-08

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `2c0e0f6` |
| Production health | `/` 200, `/catalog` 200 |
| Migration ledger | 45 repo files, 45 rows |

## The headline: three defects that had never worked at all

Not regressions. Each has been broken since the day it shipped, and each was
invisible for the same structural reason — the failure was a *silent wrong
answer* rather than an error.

### 1. The roles editor named three columns that do not exist

Reported as `Could not find the 'badge_icon' column of 'roles' in the schema
cache`. The audit found three, not one:

| Code said | The table holds |
|---|---|
| `label` | `name` |
| `priority` | `rank` |
| `badge_icon` | nothing |

Only the `insert` failed loudly. A `select` naming a missing column is refused
just as hard — but all three call sites destructured `{ data }` and dropped
`error`, so **the roles list and the public badge endpoint answered "there are
no roles"** rather than failing. The reported bug was the visible half.

`roles` predates this repository's migration set; no file creates it, which is
how a column the editor writes was never added. `20260808010000_role_badge_icon`
adds `badge_icon` — chosen over deleting the editor's icon field because the
other three badge attributes are already columns and already editable — with a
CHECK pinning the six names `RolePill` can actually draw. The installer baseline
adds it too, so a fresh install and a migrated database reach the same shape.

`src/lib/staff/roleSchema.ts` is now the single declaration. Reads use PostgREST
aliases (`label:name`) so the wire vocabulary the UI consumes is unchanged;
writes translate. `key` and `is_system` are deliberately not writable.

Also closed while here: **deleting a role had no guard at all.** `admin` was
deletable from inside the page that requires it. Built-in roles, and roles
people still hold, are now refused.

### 2. Avatar upload could never have worked, for anyone

Proven before anything was changed: the `avatars` bucket holds **zero objects**,
and the only non-null `profiles.avatar_url` is a Google OAuth URL that never
passed through storage.

One missing slash. The bucket's insert policy is

    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text

and `/account` uploaded to a flat `<uuid>.jpg` key with no folder. Postgres was
asked live:

    (storage.foldername('<uuid>.jpg'))[1]                    -> NULL
    NULL = '<uuid>'                                          -> NULL
    (storage.foldername('<uuid>/avatar.jpg'))[1] = '<uuid>'  -> TRUE

RLS admits a row only on `TRUE`. The policy could never pass.

The key is now `<uid>/avatar.<ext>` — first segment the user id, which is the
whole of the policy check — and **stable rather than timestamped**, so a
replacement overwrites in place. That is what makes this repair need **no
storage policy change**: the bucket has no DELETE policy, and a timestamped key
would have orphaned every previous avatar with no way to remove it.

The staff upload route had three faults of its own, invisible because it runs as
`service_role` and bypasses the policy that would have objected: it wrote
`avatars/<id>/…` *inside* the `avatars` bucket (so objects landed outside the
prefix those policies govern), it timestamped every key, and it passed the file
through unvalidated while returning the provider's error text to the browser.

### 3. Saving a production job detached it from its order

`parseJobDraft` resolves each link column with `uuid(input.orderId)`, and `uuid`
answers `null` for an absent key. The job workspace's `toDraft` builds fourteen
fields and **not one is a link**, so every press of Save wrote
`order_id = null, order_item_id = null, product_id = null, customer_id = null`.

Editing a note detached the job. Nothing surfaced it: the job simply stopped
appearing in that order's Shop work panel, and the audit entry faithfully
recorded `fields: ["order_id", …]` for anyone who thought to look.

PATCH now strips all four, exactly as it already stripped `status`.

## A reusable schema-contract test, and what it found

`tests/staff-schema-contract.test.ts` checks every literal `.from(t).select(c)`
in `src/` against `tests/fixtures/production-schema.json`, a capture of
`information_schema.columns` taken from production.

It exists because **no existing layer could catch this**. TypeScript sees
`select()` take a string. The generated Supabase types agree with whichever
schema produced them, so the disagreement lived entirely in hand-written types.
Every roles test read source or checked a pure function; none knew what the live
table held.

A first version allowed 400 characters between `.from` and `.select` and
reported 54 problems, of which 40 were the test pairing a `.from` with the
*next* query's `.select`. Tightened to require adjacency: **14 findings, all
real**, six distinct sites.

Fixed here:

| Site | Effect |
|---|---|
| `inventory_adjustments.actor_user_id` (is `created_by`) | every product's stock-movement history rendered empty |
| `user_bans.banned_at` (is `created_at`) | every account reported as not banned |
| `forum_moderators.id` (no such column) | category moderators could never lock a thread |

Removed: `src/lib/adminForumGuard.ts` — dead code (nothing imported it) whose
two broken queries made its guard deny everyone, including admins.

Registered as **known drift**, with a stated reason rather than silently
excluded: the four revision-history columns on `info_page_review_events`. The
submission history and its Undo control on `/staff/info/pending/[id]` read and
write columns that have never existed, so both fail — the list is permanently
empty and Undo restores nothing. It fails closed. The repair is an additive
migration for a content-review feature that is not on this pass's priority list
and needs its own approval and dry run. The register asserts each entry names
its surface, its effect and why it was left, and caps its own length.

## Staff information architecture

**"Order Cockpit" was never a page.** It was the `h1` of `/staff/orders` — so
the sidebar said Orders, the page said Order cockpit, and beside
`/staff/fulfillment` that read as two competing order systems. There was no
second surface to remove. The heading is now Orders.

`/staff/fulfillment` keeps its page and gains an explicit purpose: **a queue,
not a second order editor**, stated on the page and in its description. That
boundary is why it earns a place, and it is what stops there being two places to
ship an order from.

| Before (6 groups, 23 items) | After |
|---|---|
| Overview: Dashboard, To-do board | **Today**: Dashboard, Orders, Production, Fulfillment |
| Commerce: Orders, Fulfillment, Production | **Catalog**: Products, Categories, Inventory, Discounts |
| Catalog: Products, Categories, Discount codes, Inventory | **Customers**: Customers, Reports |
| Customers & content: 6 items incl. Community | **Operations**: Emails, Analytics, Reconciliation, Integration health, Launch readiness, Audit log |
| Business: Analytics, Reconciliation, Integration health, Launch readiness, Audit log | **Site content**: To-do board, Pending submissions, Content updates, Shops |
| Settings: 8 items | **Settings**: 7 items |

Today is ordered the way a job travels: it arrives, it is made, it goes out.
Operations exists to get Reconciliation and Launch readiness *out* of the daily
path — they sat in "Business" beside Orders, giving a page opened twice a month
the same weight as the page staff live in.

Renamed: "Shipping, pickup & policy" to **Commerce**, "Email & notifications" to
**Emails**, "Customers & users" to **Customers**, "Discount codes" to
**Discounts**, "Order cockpit" to **Orders**. Each described contents rather
than naming a destination.

No page was added. Every entry still resolves to a route that exists.

## Production and order linking

`production_jobs` has carried `order_id`, `order_item_id`, `product_id` and
`customer_id` since pass 5, and both surfaces displayed the link. Nothing could
*change* it — and the PATCH above destroyed it.

`POST /api/staff/production/jobs/[id]/link` is its own endpoint for the reason
`./status` is: a save that changes what a record *is* should not be the same
call as a save that changes what it *says*.

- The order must resolve to a real row before an id is stored, so a mistyped or
  deleted reference is refused rather than found later from the order side.
- A relink sends `expectedOrderId`, compared to the stored value **and**
  re-asserted in the `WHERE` clause, so a change that landed in between matches
  zero rows instead of overwriting a decision.
- Detaching is `orderId: null` stated explicitly. Conflating "null" with
  "absent" is exactly what erased links.
- `order_item_id` is cleared on a move — an item id belongs to one order and
  would otherwise point at a stranger's line. Product and customer come from the
  order just verified, never from the request.
- Both the job timeline and `audit_logs` are written, carrying order numbers and
  no customer detail.
- Re-confirming the current link is **not** a write, so the log never records
  something that did not happen.

From the order page, staff can link existing shop work. The picker offers only
jobs attached to no order (`orderId=none`), so it cannot take a job from another
order by accident; moving work between orders stays deliberate.

## Email settings — audited, and they are real

The question was whether `/staff/emails` controls the emails. **It does**, and
the path was traced rather than trusted:

1. `sendCommerceEmail` reads `email_templates` on **every send** — subject,
   heading, body, button_label, is_enabled.
2. No cache in front of it, so an edit applies to the next email with no deploy.
3. The hard-coded strings are fallbacks used only when a row is missing.
4. Body reaches **both** the HTML and the plain-text part; all three interpolated
   fields pass through `escapeHtml`, and the subject strips CR/LF.

**No dead template settings.** Checked against production: 43 rows, 43
catalogued keys, symmetric difference empty, every key referenced by at least
one event. That comparison is now a test rather than a claim.

What the page could not do was say any of it. Two hand-maintained sources sat
beside the catalogue: a prose sentence per template, and a hard-coded variable
list naming **7 of the 14** usable variables — so half were undiscoverable and
the list could not follow the allow-list it described. Both now derive from
`emailEvents.ts`, which `transactional-emails.test.ts` already asserts against
the send calls.

Each template now shows **Used by** — the events that send it, with triggers.
One template, `staff_fulfillment_due`, has no wired event: it needs the
scheduled job runner pass 12 recorded as unbuilt. It is badged **"Not sent yet"**
and says why, rather than hidden — hiding it would lose a real specified email,
and showing it silently is the dead setting this audit ruled out.

**Mistyped placeholders are now caught.** The sender substitutes exactly
`{{[a-z_]+}}`, so a spaced, capitalised or hyphenated placeholder is not
ignored — it is mailed to the customer with the braces intact. A well-formed
name nothing supplies is reported separately, because it fails differently: it
substitutes to an empty string and the sentence loses a word. Both are warnings
beside the field, not a refusal — a brace in prose is legal.

**No email was sent at any point in this pass.**

## Catalog: a browsing rail

Pills are a *filter* shape — uniform, small, equal weight — so a category, a
subcategory and an availability toggle all rendered as the same control, and
hierarchy could only be inferred from which row something landed on.

Pass 13 chose rows because one category would leave a sidebar mostly empty. True,
and the wrong thing to optimise for: the layout has to be right at forty
categories too, and a wrapping chip row is a wall long before that.

The rail states hierarchy structurally — sections with headings, categories as a
list, children indented and ruled beneath their parent, shown for the branch you
are in. Expanding *is* navigating, so there is no disclosure state to fall out of
step with the page. Availability and purchase type move into the rail; sorting
stays above the grid with what it reorders.

`grid-template-columns: 15rem minmax(0, 1fr)` — a fraction would let a long
category name steal width from the products, and a bare `1fr` would let the grid
overflow rather than shrink. The rail is sticky and scrolls within a capped
height so a long list cannot put its own foot out of reach.

Below `lg` the rail gives way to the existing drawer.

## Community — dormant, nothing deleted

Removed from the desktop More menu, the mobile drawer (both derive from one
list), the footer, the command palette, and the staff sidebar.

**Nothing was deleted.** Every route under `/community` resolves, every thread,
post, comment, vote and category is untouched, the `community.*` permissions are
unchanged, and no migration was written. Notification deep links still work.

`noindex, follow` while dormant: the site no longer points here, so continuing to
take search traffic to it sends visitors to a dead end — but the links back into
the shop still count.

Reviving it is two edits, both named in the code: add the entry back to
`secondaryNav`, drop the `robots` line in `src/app/community/layout.tsx`. There
is no data to restore.

Three existing suites required Community's presence and are re-pointed to assert
**dormancy** — absent from every surface *and* the routes and files still exist.
Asserting only the first would have been satisfied by deleting the feature.

## Migration — written, **not applied**

| File | What |
|---|---|
| `20260808010000_role_badge_icon.sql` | One nullable `roles.badge_icon` column plus a CHECK pinning the six renderable names. |

Additive and default-safe: no default, so all four existing rows keep `null`,
which already means "use the code registry's icon" — behaviour before and after
is identical until somebody sets a value. **No grant is issued and none is
needed**: privileges on `roles` are table-level (`service_role` holds
SELECT/INSERT/UPDATE/DELETE; `anon` and `authenticated` hold SELECT) and a new
column inherits them. `roles` carries no RLS policies, and adding a column does
not change `relrowsecurity`.

**This migration must be applied before the branch merges**, because the repaired
code selects `badge_icon`. Until then `tests/fixtures/production-schema.json`
carries it under `pending_migrations`, so the contract test is green on the
branch and would fail if the column were referenced without a migration.

## Validation

- **1376 tests pass, 0 fail** (1323 at `2c0e0f6`; 53 added across four new
  suites, plus six existing suites re-pointed and made stricter).
- Typecheck clean. Production build clean from a cleared `.next`, exit 0; the new
  `/api/staff/production/jobs/[id]/link` route is present.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings). The one
  warning this pass introduced was found and removed.

### Driven in a real browser

Dev server, cold start from a cleared `.next`.

| Check | Result |
|---|---|
| `/catalog` desktop | rail 240px beside 832px of products, sticky at 88px, exact counts |
| `/catalog/interior` | correct `h1`, breadcrumb, one active rail link, 1 card |
| Rail link height | **44px**, raised from 36 rather than argued for as mouse-only |
| 320 / 375 | rail hidden, drawer trigger 310x44, **no horizontal overflow**, no nested scrollers |
| Drawer at 320 | portalled dialog 320x634, body locked `position: fixed`, Escape restores |
| 1024 / 1280 / 1920 | rail and products **never overlap**, no overflow at any width |
| Accessibility | one `h1`, clean outline, no image without alt, every link named |

**A duplicate `aria-current` investigated and dismissed:** three elements claimed
it, two of them the same rail link. The second lives inside React's
streaming-SSR container for the page's existing Suspense boundary — carrying the
`hidden` attribute and therefore out of the accessibility tree. It predates this
pass. The third is the global navbar marking its own current item, which is
correct.

Console carried only the **pre-existing** `data-motion` hydration mismatch on the
root `html` (reproduces on `/`, present since pass 3) and the local 503s from
the deliberately fake service-role key.

### What could not be verified, and why

- **A signed-in staff session.** Unchanged limitation since pass 3: middleware
  redirects `/staff/*` to `/auth/login` even locally, and signing in means
  handling a password. So the populated roles editor, the job-link control and
  the email editor's new panels were not driven in a browser. Their rules are
  covered by the 53 new tests; the rendering of populated states is not.
- **A real avatar upload.** It needs an authenticated browser session. The fix is
  a path change, and the policy arithmetic behind it was evaluated directly in
  Postgres rather than reasoned about.
- **The `badge_icon` column itself**, which is not yet applied.

## External setup still required

1. **Apply `20260808010000_role_badge_icon`** — needs approval. Until it is
   applied, creating a role still fails and the roles list is still empty.
2. Nothing else. No storage bucket or policy change is required, no Supabase Auth
   change, and no new environment variable.

## Deferred, honestly

1. **`info_page_review_events` revision history** — four columns that have never
   existed, registered as known drift with its cost stated. Needs its own
   additive migration.
2. **Guest cancellations and returns**, **cross-device guest access**, **guest
   file uploads**, **server-side catalog pagination** — unchanged from pass 13.
3. **Scheduled work**: quote expiry, payment reminders, fulfillment-overdue and
   reservation-inconsistency emails. `staff_fulfillment_due` is now badged in the
   UI as a result.

## Residual risks

- The catalog rail is verified against **one** category with no children. Nested
  subcategories, many top-level categories, long names, and empty and hidden
  categories are covered by `tests/catalog-navigation.test.ts` against mocked
  depth, not by a browser at real depth — production has one category.
- `known_drift` in the schema fixture is an exclusion list. It is asserted to
  stay short and to explain every entry, but it is still a place a red result
  could be put. It must only ever shrink.
- The schema snapshot is a capture. It is only as true as the last time it was
  regenerated, and regenerating it to make a test pass would defeat it — the
  fixture says so in its own header.

## Second migration — `20260808020000_info_review_event_revisions`

Added at the owner's direction after the audit, rather than carried as known
drift. `/staff/info/pending/[id]` records a before-and-after for every review
action and offers an Undo that restores from it; `info_page_review_events` has
never had `previous_title`, `new_title`, `previous_content_markdown` or
`new_content_markdown`.

Both halves failed silently: the insert was refused, so **zero events were ever
stored**, and the select was refused, so the history rendered empty rather than
erroring. The page showed "no events" for a table nothing could write to, and
Undo had nothing to restore. It failed **closed** — no wrong content was ever
written to a page — which is why it went unnoticed.

Four nullable `text` columns, no default, no backfill. There are zero existing
rows precisely because every insert was refused, so nothing needs migrating.
Reconstructing history from `info_pages` was deliberately **not** done: there is
no record of what those revisions were, and inventing one would put fabricated
content behind an Undo button. A test asserts the migration contains no `update`.

The `known_drift` register is now **empty**, and a new test closes the other way
it could have been defeated: every `pending_migrations` entry must be traceable
to a migration file that adds it, and must genuinely be absent from production.
An entry with no migration behind it is drift wearing a different label.

## Both migrations applied — 2026-08-08

Applied with approval through `execute_sql` in **two separate guarded
transactions**, not `apply_migration` — that tool stamps its own timestamp as the
version, which caused six of the seven ledger drifts repaired in pass 3. Each
ledger row was inserted by hand inside the same transaction under the repository
filename's version.

Each was dry-run first against production inside a transaction ended with a
sentinel exception, with production verified untouched after each.

**`20260808010000_role_badge_icon`** — dry run proved five things: existing roles
survive with `badge_icon` null and none backfilled; a legal icon (`gavel`) is
accepted; an icon `RolePill` cannot draw (`rocket`) is refused by
`roles_badge_icon_check`; null remains legal; and **creating a role now
succeeds**, which is the reported failure. Guards before: column absent, 45
migration rows, version not recorded, 4 roles. After: column present, constraint
present, 46 rows, 4 roles, **0 carrying an icon**.

**`20260808020000_info_review_event_revisions`** — dry run proved five things:
four nullable text columns present; the 0 existing events unchanged; the insert
the page has always attempted now succeeds; the select reads the before-and-after
back, so Undo has a source; and an event without a diff is still storable.
Guards before: columns absent, 46 rows, version not recorded. After: 4 nullable
text columns, 47 rows, event count unchanged.

Both committed. Verified independently afterwards.

### Verification after applying

| Check | Result |
|---|---|
| `roles.badge_icon` + `roles_badge_icon_check` | both present |
| Roles | **4**, all `badge_icon` null — none backfilled |
| `info_page_review_events` revision columns | **4**, nullable text |
| Review events | **0**, unchanged |
| Migration rows | **47** |
| Migration ledger | **exact** — 47 repo files, 47 rows, newest two matching their filenames |
| Data preserved | 9 orders, 2 products, 3 users, 43 templates, 26 deliveries — all unchanged |
| Community data | **1 forum thread, 1 forum post, untouched** |
| Supabase security advisors | **no new findings**. The 14 `rls_enabled_no_policy` notices, the SECURITY DEFINER warnings and the leaked-password warning are all pre-existing; neither migration created a table or a function, and neither table appears in any of them. |
| Grants | none issued and none needed — both are column additions on existing tables, and a column inherits the table ACL |
| Emails sent | **0** |
| Stripe charges or refunds | **0** |

The schema snapshot in `tests/fixtures/production-schema.json` was refreshed from
production after applying, and `pending_migrations` is now empty. The refreshed
column lists were diffed against a fresh `information_schema.columns` query
rather than hand-edited on trust.

## Pass 14 — merged and in production

Branch `staff-ia-catalog-schema-repair-20260808` → merged as **`1021e39`**, which
is the current production SHA. Merged with `--no-ff`, never force-pushed.

| SHA | What |
|-----|------|
| `e5087b5` | Repair the roles editor against the schema it actually writes to |
| `1c2c15f` | Give avatar uploads a path the storage policy can accept |
| `67e178e` | Reorganise the staff area around the work rather than the codebase |
| `afc9609` | Stop a job save from detaching the job, and let staff link one on purpose |
| `b9a0c0d` | Make the email editor show what actually sends each template |
| `7200e9a` | Take Community out of the customer product without deleting any of it |
| `60679d0` | Give the catalog a browsing rail instead of rows of pills |
| `42bab8f` | Record pass 14 |
| `b57a62f` | Repair the review history the submission page could never write |
| `1021e39` | Merge commit |

- Vercel **preview build: success** on `b57a62f` (the final branch head).
- Vercel **production deployment: success** on `1021e39`.
- Both migrations were applied **before** the merge, so production never served
  code selecting a column that did not exist.

### Production smoke test — on `1021e39`

| Check | Result |
|---|---|
| Storefront | `/` 200 (0.80 s), `/catalog`, `/catalog/interior`, `/catalog/premade-shift-knob`, `/cart`, `/shipping`, `/terms` all 200 |
| `/community` | **200** — dormant, not deleted, still reachable by direct URL |
| `/community` robots | `noindex, follow` |
| Staff pages gated | `/staff`, `/staff/orders`, `/staff/security/roles`, `/staff/emails`, `/staff/production` all **307** |
| New link API gated | `POST /api/staff/production/jobs/[id]/link` → **307** |
| Catalog rail deployed | the production CSS chunk carries `catalog-rail-link`, `catalog-rail-sublist`, `catalog-rail-heading` and `15rem minmax(0,1fr)` |

**The roles repair, proven against production rather than asserted.**
`GET /api/public/roles` now returns all four roles carrying `label`, `priority`
and `badge_icon`:

    {"roles":[{"key":"admin","label":"Administrator","priority":100,…,"badge_icon":null}, …]}

Before this pass that endpoint answered `{"roles":[]}` — the select named three
columns the table does not have, and the route dropped the error. This is the
single clearest confirmation that the drift is closed: the same request, the same
data, a different answer.

### Production data after the run

| Count | Value |
|---|---|
| Orders / order items / products | 9 / 3 / 2 — unchanged |
| Users / identities | 3 / **4** |
| Roles / role permissions | 4 / 92 — unchanged |
| Forum threads / posts / categories | **1 / 1 / 1 — untouched** |
| Email templates / deliveries | 43 / 26 — unchanged |
| Deliveries in the deployment window | **0 — no email was sent** |
| Refunds / Stripe charges created | **0 / 0** |
| Production jobs | **1** |
| Review events | 0 |
| Migrations | 47 |

Two counts differ from what pass 13 recorded, and **neither came from this pass**:
`identities` reads 4 where pass 13 recorded 3, and `production_jobs` reads 1
where pass 13 recorded 0. This pass never called an auth API and never created a
job — both are owner activity between passes. Recorded here so the next reader
does not attribute them to this work, which is the same care pass 5 took over a
discount code appearing between passes.

### Owner checks worth five minutes

1. **Create a role.** `/staff/security/roles` → type a key and a label → Create.
   That is the reported failure, and it is the one path no automated session can
   reach. The list should also now show all four existing roles; it has been
   empty this whole time.
2. **Set a badge icon** on a role from the new dropdown, and confirm the pill
   changes. Six names are available; anything else is refused by the database.
3. **Upload an avatar** at `/account`. It has never worked for anyone — the
   bucket is still empty — so this is the first one.
4. **Open a production job, edit a field and save**, then check the order still
   lists it under Shop work. Before this pass that save detached it.
5. **Open `/staff/emails`** and look at any template's new "Used by" panel.
   `staff_fulfillment_due` should be badged "Not sent yet" with a reason.

# Pass 15 — staff UX, information architecture, appearance system, collapsed rail

Branch `staff-ux-appearance-overhaul-20260808`, from `f9dded6`.
**No migration was written and none is needed.** The full audit is
`docs/STAFF_UX_AUDIT.md`, written before any code changed.

## Verified starting state — 2026-08-08

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `f9dded6` |
| Migration ledger | 47 repo files, 47 rows |
| Roles | 4 — admin, moderator, support, member |

`products` reads 3 where pass 14 recorded 2. This pass never created a product;
it is owner activity between passes, recorded here so the next reader does not
attribute it to this work.

## The headline: role creation was still broken, and it was not the migration

Pass 14 diagnosed "could not create the role" as the missing `badge_icon`
column, applied `20260808010000_role_badge_icon`, and verified the column. The
report came back unchanged, because **there were two defects and only one was
fixed**.

`roles.description` is `text NOT NULL DEFAULT ''`. The create form posts exactly
`{ key, label }`. `parseCreatePayload` filled the absent description with
`null`, and `toRoleDbColumns` always emitted the key — so every insert carried
an explicit `description: null`, which **overrides a default rather than
triggering it**.

Proven against production before anything changed, inside a function that
catches and reports, rolled back:

| Scenario | Result |
|---|---|
| `description = NULL` | `23502 null value in column "description" … violates not-null` |
| `description = ''` | **succeeded** |

**Why pass 14 missed it.** Its dry run used a hand-written SQL insert that
supplied a description. That proved the *column* was fixed and never exercised
the *route's payload*, which is the thing that omits it. The dry run and the
application disagreed about what "creating a role" means.

**No migration.** The column is correct. Relaxing a NOT NULL to accommodate a
caller sending the wrong value would lose the guarantee that every role has a
description string to render. The conversion lives in `toRoleDbColumns`, not in
each route, so a fifth call site cannot reintroduce it. `PATCH` had the same
defect on the same column — unreported only because nothing sends it yet.

Every failure but 23505 collapsed to one message, which is how a not-null
violation stayed invisible for two passes. 23502, 23514, 23503 and 42501 now say
which happened, without echoing a constraint name at an operator.

Verified against the live schema, all rolled back, production untouched
(4 roles, 0 probes, 47 migrations, before and after):

| Scenario | Result |
|---|---|
| Route payload now (`description = ''`) | **succeeds** — `is_system=false`, no permissions granted |
| Old payload (`description = null`) | `23502` — the reported failure |
| All six badge icons | **all accepted** |
| `rocket` | `23514` → "That is not one of the available badge icons." |
| Duplicate key `admin` | `23505` → "A role with that key already exists." |

Deleting was also unreachable. The route has refused built-in roles and roles
people still hold since pass 14, but nothing in the UI could call it, so a role
created by mistake could never be removed.

## The collapsed sidebar was a grid-column bug, not a sidebar bug

Collapsing hid the labels and left the sidebar 280px wide. The state lived on
the `<nav>`; the width is set two levels above it:

    div.staff-shell     grid-template-columns: 280px 1fr   <- decides width
      div                                                   <- fills 280px
        nav.staff-nav   data-compact="true"                 <- state was here

Every compact rule applied inside a box an ancestor had already sized. The
labels genuinely left the layout — `sr-only` is `position: absolute` — and 280px
of empty panel stayed. No work on the link styles could have fixed it.

`StaffShell` now owns the preference and carries `data-compact` on the grid
container. `minmax(0, 1fr)` on the content column matters: a bare `1fr` has a
min-content floor that would absorb the gain.

| Width | Expanded | Collapsed | Content gained |
|---|---|---|---|
| 1024 | 280px | **72px** | +208px |
| 1280 | 280px | **72px** | 924.8 → **1132.8px** |
| 1440 / 1920 | 280px | **72px** | +208px |

`title` was replaced with a real tooltip: no browser raises a `title` on
keyboard focus, so the collapsed rail was unlabelled for anyone tabbing it.

## Appearance: the page could not answer its only question

Controls were labelled with the token's name, eleven colours — including both
button texts — were hidden inside a collapsed "Advanced palette", nothing was
searchable, and the preview showed metric cards and a stepper. An owner tuning
the storefront had nothing on screen that resembled it.

`src/theme/appearanceMap.ts` is the single declaration: for every colour, a
human name, a sentence, the real screen elements it reaches, and search terms.
The page renders entirely from it, and search matches the *elements*.

**The two the owner named had no control at all.** The "Customizable" badge and
the catalog's "Need something else? Start a custom project" derived every colour
from `--brand-accent`, so the only way to change either was to change footer
links, the request stepper and every accent badge with it. Both now have their
own background, text and border.

Stored as `""` meaning "follow the accent": an untouched site renders
identically, and a stored hex would have frozen the badge at today's accent and
stopped it following a later palette change. That "unset" must be genuinely
**absent** from the DOM — an empty custom property is still *defined*, so
`var(--x, fallback)` would resolve to nothing rather than the derivation behind
it. `optionalVars` drops them, shared by the root layout and the preview.

| Before | After |
|---|---|
| 6 sections; colours split across "Colors & controls" and "Navbar" | 6 sections; **all colours in one searchable "Colours"** |
| 11 colours behind a collapsed `<details>` | none hidden |
| No search | search over labels, descriptions and screen elements |
| Preview: metric cards, stepper, tabs | preview leads with product card, badge, CTA, buttons, form field |
| No control for the badge or the CTA fill | 5 new optional tokens |
| Staff and storefront controls interleaved unlabelled | every group carries a scope badge |

### Token to what it changes

Full table in `STAFF_UX_AUDIT.md` section 7. The two that were reported:

| Element | Controls |
|---|---|
| "Customizable" badge | Badge background / text / border — each following Accent until set |
| "Need something else? Start a custom project" | Secondary button background / text / border, shape from Secondary buttons |

### Hard-coded colour audit

| Class | Verdict |
|---|---|
| `#fb7185` danger, `#4ade80` success | **Intentionally fixed** — a status colour that could be reassigned would stop meaning anything. Asserted by test. |
| Role badge defaults in `roleSchema.ts` | **Intentionally fixed** — per-role overrides exist |
| `defaultSiteTheme` hexes | **Intentionally fixed** — they are the defaults |
| `/staff/security/roles` `border-zinc-800 bg-black/35` | **Was a real bypass** — routed through the shared tokens here |
| Remaining staff-page chrome | **Recorded, not executed** — touches ~30 pages, own pass |

## Staff information architecture

Same 27 destinations, no route added or removed.

| Before (6 groups) | After (8 groups) |
|---|---|
| Today: Dashboard, Orders, Production, Fulfillment | **Dashboard**; **Orders** |
| Catalog: Products, Categories, Inventory, Discounts | **Operations**: Production, Fulfillment, Inventory |
| Customers: Customers, Reports | **Store**: Products, Categories, Discounts |
| Operations: Emails … Audit log | **Customers**: Customers, Reports |
| Site content: 4 | **Business**: Emails, Analytics, Reconciliation, Integration health, Launch readiness, Audit log |
| Settings: 7 | **Site content**: 4; **Settings**: 7 |

Inventory moved out of the catalog group: fixing a stock count is operational
work done beside Production and Fulfillment, and it was filed with writing
product copy. Catalog to Store (what the storefront is called). Operations to
Business for the reporting group, freeing the word for what is actually the
operation. "Settings overview" to "All settings". "Security controls" to "Site
access & safety", which stops it competing with "Roles & permissions".

**"Custom Requests" was requested and deliberately not added** — no such route
exists. Custom requests are orders carrying `is_custom`, shown by a filter on
`/staff/orders`; an entry would 404 or duplicate Orders under a second name.

The settings index is four named blocks instead of a flat grid of seven cards
where "Recycle bin" carried the same weight as "Commerce".

Orders, Production and Fulfillment keep the pass 14 boundary and it is now
structural: Orders sits alone as the canonical workspace, while Production and
Fulfillment sit together under Operations as queues into and out of it. Their
descriptions still say editing happens on the order.

## `/orders/new` — the form system, not one margin

`Project type *` sat on its dropdown because every control on all four steps
shared `const input = "ui-input mt-1"` — 4px — while `/staff/orders/new` used
`mt-2` and the rest of the project used `.ui-label`. Three spacings, so "fix the
spacing" had no single answer.

Spacing now belongs to `.ui-label` alone at 0.5rem, and a shared `Field`
component carries the structure. Measured: 8px on every field, identical at 375
and 1280, no horizontal overflow. The required marker gained a text equivalent —
a bare `*` is announced as "star" or skipped depending on the reader.

## Validation

- **1438 tests pass, 0 fail** (1376 at `f9dded6`). Four new suites; eight
  existing tests re-pointed to the new structure and made stricter rather than
  weakened.
- Typecheck clean. Production build clean from a cleared `.next`, exit 0.
- **Lint unchanged at the 332 baseline** (178 errors, 154 warnings).

Two new tests failed on their first run and were right to:
`appearance-token-map` refused an empty "Staff area" colour group — the staff
area shares every colour and its only dedicated control is a shape — and
`staff-sidebar-collapse` caught an over-broad regex matching the phone
single-column rule.

### Driven in a real browser

Full table in `STAFF_UX_AUDIT.md` section 11. Widths 320, 375, 768, 1024, 1280,
1440, 1920 — no horizontal overflow at any. Appearance search resolves
"customizable" to the three badge controls and "custom project" to the three CTA
controls; the preview updates live with no save, and Clear restores inheritance
with the variable absent rather than empty.

**A tooltip that read as broken and was not.** The link matched `:focus-visible`
but computed opacity stayed `0` after 400ms and even when set inline. The
Browser pane does not composite frames, so a `transition` never advances and
`getComputedStyle` returns the from-value forever. With `transition: none`
forced: focus to `1`, blur to `0`, refocus to `1`.

### What could not be verified, and why

- **A signed-in staff session.** Unchanged since pass 3: middleware redirects
  `/staff/*` even locally, and signing in means handling a password. Staff pages
  were driven by seeding `["meAccess"]` through the React fiber, so the shell,
  navigation, Appearance editor and settings index were exercised for real, but
  every staff API answered 401/403. The roles editor's populated state and the
  create/delete round trip were not driven in a browser; their rules are covered
  by the 31 new role tests and by the live-schema probes above.
- **Production role creation end to end.** Proven at the database, not through
  the deployed UI. That is the owner check below.

## Deferred, honestly

1. **Staff page field placement** (Products, Orders, Production, Commerce
   section ordering) — audited in `STAFF_UX_AUDIT.md` section 8 and **not
   executed**. It touches the largest editors in the product, none of which an
   automated session can reach, and putting it in the same pass as the fix that
   makes roles work would ship untestable churn beside a verified repair.
2. **The remaining staff-chrome hard-coded colours** — one page fixed, ~30 to go.
3. **Two `main` landmarks per staff page** — pre-existing at `f9dded6`,
   confirmed on three pages. Fixing it means changing the landmark on every
   staff page.
4. **`/staff/orders/new` on the shared `Field` component** — it already measures
   8px, so it is consistent by value but not yet by mechanism.

## Residual risks

- The five new appearance tokens default to `""`, and the whole "unset means
  inherit" behaviour rests on the variable being *absent* rather than empty.
  `optionalVars` is one function with one test; if a third call site ever emits
  these without it, untouched sites lose the colour instead of inheriting it.
- `appearanceMap.ts` claims what each colour reaches. The variable and the
  layout emission are asserted; the `usedBy` prose is checked for the elements
  the owner named, but a future component reading `--km-surface` without saying
  so would not fail a test.

## Owner checks worth five minutes

1. **Create a role.** `/staff/security/roles` — type a key and a name, press
   Create. This is the reported failure and the one path no automated session
   can reach. It should now succeed, open the new role, and say it has no
   permissions until you grant some.
2. **Delete that role.** The button is new; built-in roles show "Built in —
   cannot be deleted" instead.
3. **Change the "Customizable" badge.** `/staff/appearance` — type
   "customizable" into the colour search. Three controls should appear. Change
   one and watch the preview badge move before you publish.
4. **Collapse the sidebar** on any staff page. It should become a 72px rail and
   the page content should get visibly wider.
5. **Open `/orders/new`** and look at the gap under `Project type *`.

---

# Pass 16 — the staff application redesign

Merged as `dabf18e` (work commit `b804c24`), from `c4270c8`.

Pass 15 changed the sidebar's labels and groups and **explicitly kept all 27
destinations**, deferring the page restructuring in "Deferred, honestly" item 1
because the largest editors "an automated session can[not] reach". The owner's
report after that pass was that `/staff` looked essentially the same. This pass
executes the restructuring, and reaches the editors.

## How the authenticated surfaces were reached

Middleware 307s `/staff/*` to `/auth/login` without a session and there is no
local Supabase, which is the constraint pass 15 stopped at. A temporary
local-only harness mounted the **real** page components inside the **real**
`StaffShell` with `["meAccess"]` seeded and a `window.fetch` interceptor serving
fixtures — `supabase-js` issues every PostgREST query through `fetch`, so one
interceptor covers both `/api/staff/*` and `/rest/v1/*`. Non-GET requests were
answered from memory and logged; nothing was written anywhere. The harness was
deleted before the commit and no file in the diff references it.

Two defects were found this way and only this way:

- An unknown `purchase_mode` threw on `PURCHASE_MODE_COPY[mode].help` and
  white-screened the **entire product editor** rather than one field. A CHECK
  constraint means the column cannot hold a surprise today, but this is the page
  a row written by an older build gets opened on. Now narrowed once, with every
  read routed through it.
- The dashboard rendered an outstanding balance as `220.00` with no currency
  symbol, on a queue that also counts days and quantities.

## What changed

| Surface | Before | After |
| --- | --- | --- |
| Sidebar | 27 destinations, 8 expanded groups | **16** primary, 11 behind one collapsed "More tools" |
| `/staff` | revenue chart, 4 metric tiles, 5 count cards, a second copy of the sidebar as cards | one attention queue (orders **and** stock), Today, Recent activity, Quick actions |
| `/staff/orders` | 16 chips, 9 always-visible filter controls | 6 queues, 3 controls, rest behind Filters |
| `/staff/orders/[id]` | 877 lines, 11 always-mounted panels | persistent header + 8 tabs, one panel mounted |
| `/staff/production` | rows that read as an order list | job, source order, quantity, priority, due date, stage, **blocker in words** |
| production job | 6 stacked panels, source order a cell in a 3-up grid | 6 tabs, **source order in the header** with a live link |
| `/staff/fulfillment` | 5 large count cards above the work | 7 chips incl. **Problems**, rows carry **age** |
| product editor | 7 stacked cards | **9 tabs**, checklist in the header, one save |
| `/staff/settings/commerce` | 7 stacked sections, 3 borders deep | **7 tabs**, `<fieldset>` borders removed |
| `/staff/emails` | one page + a separate `/deliveries` route | **3 tabs**, delivery log embedded, route redirects |

Three pages (`/staff/production`, `catalog/categories`, `catalog/discounts`)
nested a second `page-container` **inside** the shell's `page-container-wide`,
so they rendered narrower than their neighbours with gutters that did not line
up. A test now forbids it across every redesigned page.

## Verified in a browser

Every surface driven at `1280`, and the shell at `320/375/768/1024/1440/1920`:
no horizontal overflow at any width, no touch target under 40px at 375, rail
appears at 1024, collapsed rail narrows the **grid column** 280px → 72px.
Drawer is `role="dialog" aria-modal="true"`, traps focus, locks the body,
Escape restores it, and "More tools" is a `<details>` closed by default.
Tablist carries a roving tabindex (exactly one tab stop) and arrow keys move
selection. Editing on the product editor's Basic tab survives a round trip to
SEO and back, and the SEO tab's derived "Search title" updates from it live —
one draft, one save.

## Not verified

- **The running Vercel preview**, as in every previous pass: previews are
  SSO-gated and the Vercel CLI is not installed in this environment. The
  identical production build was run clean locally twice.
- **The order workspace's tracking-required transition**, whose
  `ConsequentialAction` labels are built from fields the harness could not
  faithfully supply. Its rules are covered by `fulfillment-workflow.test.ts`.
- **Production data.** Every figure above came from fixtures; no production row
  was read or written.

## Owner checks worth five minutes

1. **Open `/staff`.** The sidebar should show 16 rows and a "More tools"
   disclosure, not 27 rows.
2. **Open any order.** It should be a header plus eight tabs, not a long scroll.
   Press the "Next step" button and confirm it lands on the right tab.
3. **Open a product and switch tabs.** Type in a field on Basic, go to SEO,
   come back — the edit should still be there and Save still enabled.
4. **Settings → Commerce → Shipping.** Seven tabs, and the origin address should
   no longer sit inside a bordered box inside a card.
5. **Business → Email.** Templates, Delivery history and Settings as three tabs;
   the old `/staff/emails/deliveries` link should redirect into the tab.

---

# Pass 17 — sidebar scroll, real production linking, option media, catalog density, 3D disclaimer

Branch `staff-production-options-catalog-3d-20260808`, work commit `53ec643`,
from `e012e9f`.

## Verified starting state — 2026-08-09

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| Local `main` | `e012e9f` (the expected baseline) |
| `origin/main` | **`17309b2`** — four commits ahead, tree identical to `e012e9f` |
| Production health | `/` 200, `/catalog` 200 |
| Migration ledger | **47 repo files, 48 production rows** — see the drift below |

`origin/main` moved while this pass was being prepared: a guest-order
verification branch was merged (`aaba2b4`) and reverted (`13cfa05`), and the
revert was itself merged (`17309b2`). `git diff e012e9f origin/main` is empty,
so the *tree* is the baseline; only the history is longer.

## The migration ledger no longer reconciles, and that is recorded

`20260809010000_guest_order_verification` is **applied in production and has no
file in this repository**. Reverting application code does not un-apply a
migration, so the database carries `guest_order_access_codes` plus
`replace_guest_order_access_code` and `record_guest_order_code_failure`, and
nothing in the repository reads them.

Left exactly as found, at the owner's direction. It is recorded in
`tests/fixtures/production-schema.json` under a new `migration_ledger_drift`
key, and `staff-schema-contract.test.ts` asserts the entry explains itself, that
the list only shrinks, and that no repo file quietly restores it — which would
change what ships without anybody deciding to.

It is self-contained: it alters no existing table, so it interferes with nothing
in this pass.

## The headline: two defects found only by driving a browser

### 1. The sidebar could not reach its own bottom

`.staff-nav` carried `lg:sticky lg:top-4` and nothing bounded its height. That
is the pathological case for `position: sticky`: an element taller than the
viewport pins at `top`, and the part below the viewport's bottom edge cannot be
reached at all, because sticky does not scroll and the page scroll moves the
content column instead. With "More tools" expanded that is eleven destinations
you can see the top of and never click. It also rode up under the site header,
which is `sticky top-0` at `z-60`.

The rail is now the sticky box, sized to the space under the header, as a flex
column: head `flex: none`, group list `flex: 1` with its own scroll. A
`min-height: 0` in both places is load-bearing — a flex item's default
`min-height: auto` refuses to shrink below its content and would push the
overflow straight back out. `--km-header-height` moved from `.site-header-inner`
to `:root`, because a variable scoped to a box *inside* the header is reachable
from nowhere else.

Measured at 1280x900, page scrolled to 3000: rail pinned at 76px and unmoved,
menu scrolled independently, page did not move when the menu did, last link
("Audit log") inside the viewport, no horizontal overflow. Same at 1024 and 1920.

### 2. Fixing that silently broke the collapsed rail's tooltips

A scroll container clips its **cross axis** too. `overflow-x: clip` with
`overflow-clip-margin: 14rem` was written specifically to let the 72px rail's
tooltips out, and it does nothing: once the box scrolls in one axis Chrome
treats `clip` on the other as plain `hidden` and ignores the margin.

This looked correct in CSS and passed a test asserting the CSS. It was caught by
probing `document.elementFromPoint` at the tooltip's own centre: the box sat 82px
outside the rail and **not one pixel was hit-testable**. Those labels are the
only thing naming an icon-only link for a sighted keyboard user.

Now a single `position: fixed` element rendered *outside* the scroller and
positioned from the hovered or focused link — one element instead of
twenty-seven, and nothing clips it. Re-probed: with `pointer-events` restored
for the measurement, `elementFromPoint` returns the tooltip. Focus and blur were
driven with real `focusin`/`focusout` events, because the Browser pane is not
displayed, so `document.hasFocus()` is false and `.focus()` sets `activeElement`
without firing an event.

## Production and orders

`production_jobs` has carried `order_id`, `order_item_id`, `product_id` and
`customer_id` since pass 5, and `./link` has been correct since pass 14. What
did not work was everything around it.

| Before | After |
|---|---|
| "This job will be linked to the order it was raised from" — naming no order | **Source order: KM-xxxx**, as a link, before anything is created |
| Quantity defaulted to 1 beside an order for six | Prefilled from the order |
| `order_item_id` accepted by `parseJobDraft`, sent by nothing | Sent, so a job points at a line and not just an order |
| Link picker offered only jobs attached to no order | Searches **every** open job |
| A bare `select` showing neither status nor owner | Status badge and "On order KM-xxxx" / "Not linked" on every row |
| Moving work between orders impossible | Possible, behind a confirmation naming both orders |
| Nothing said an order already had work | Duplicate guard naming the open jobs |

The picker sends `expectedOrderId` as the job's *actual* current link rather than
a hardcoded `null`, so the server's stale check compares against what the reader
was shown. "Impossible" is not the same as "deliberate".

The pass-14 regression — saving a job's details detached it from its order — is
now pinned by a test that exercises `parseJobDraft` directly: an absent link key
resolves to `null`, which is *why* PATCH destructures all four out before
writing.

## Category

The editor had a picker. **Creating** a product had a free-text box that wrote
the legacy `category` string and left `category_id` null, so a new product could
be filed under "Interor" and belong to no real category. Both surfaces now use
the same picker, and the text column is derived from the chosen row.

A second defect, found while wiring it: the picker was handed
`visibleCategories(...)`, so a product filed under a category archived afterwards
displayed "Uncategorized" **and** the derived-name lookup missed, meaning the
next save of any unrelated field wrote `category: null`. The picker now receives
every row, offers only usable ones, and shows an archived assignment as
"(archived) — pick another".

`CategorySelect` also stopped being a listbox trigger inside a `label`, which
made clicking the caption open the menu and printed "Category" twice.

## Appearance

Pass 15 fixed the *labelling* problem. It did not fix the **counting** problem,
which is what "harder to navigate" meant: 34 editable colours, and the two things
the owner named returned four plausible results each.

`src/theme/appearanceTasks.ts` groups them into things a person names — six
sections, eleven everyday tasks, seven in Advanced — each with its own two or
three colours labelled by the role they play in *that thing*: Background, Text,
Border. Under a heading that says **Custom project button**, the field is called
Background rather than "Secondary button background".

| Property | How it is kept |
|---|---|
| Every colour has exactly one home | Partition asserted total and disjoint |
| Nothing became uneditable | `ownedKeys().length === APPEARANCE_SETTINGS.length` |
| Shared colours are not duplicated | Prices and the focus ring are `pointer` tasks explaining where the colour lives |
| Search resolves a thing to one answer | Ranked: `2` the task *is* it, `1` merely related |
| No token jargon | A regex over every label, description and keyword |
| Inheritance in words | "Use brand accent", and the word "unset" must not reach the screen |

The ranking exists because a strict search would have *hidden* something true:
the badge follows the accent until it is given its own colour, so "customizable"
legitimately matches Brand accent too. It ranks second rather than being
suppressed.

## Option values

**No second pricing mechanism was created.** `price_adjustment_cents` has been
the server-authoritative adjustment since `20260731060000`, summed by
`priceLine`, carried through the cart, checkout, the Stripe amount and the
`order_items` snapshot. Verified, then pinned by tests: positive, zero, negative,
combined, inactive, and a floor at zero on the unit price.

What was missing was the editor. `is_default`, `is_active` and `requires_request`
were obeyed by the storefront and **editable nowhere** — the only way to change
one was a hand-written SQL statement. All three are now on the value row,
alongside the new image association.

An option value may point at a `product_media` row, never a copied URL: replace
the image and a URL would show the old one; delete it and the URL would 404.
Selecting a value with an image switches the gallery; selecting one without leaves
it exactly where it is, including on a photograph browsed to by hand. The switch
is keyed on a token rather than a media id, so re-picking Blue after browsing away
works — comparing ids would make the second press a no-op.

Option groups can be drawn as image swatches, chosen explicitly by staff and
**never inferred from the option's name**. Swatches need both the instruction and
at least one resolvable image, because a swatch row with no thumbnails is worse
than the buttons it replaced.

## Catalog

Three columns on desktop, with a 2/3/4 control beside sorting. The layout never
reads React state: an inline script stamps `data-catalog-density` before first
paint and CSS does the rest, so a stored preference of four does not render three
and reflow. Four is clamped to three between 1024 and 1280 — where the rail
leaves each card under 180px — and the *preference is kept*, so widening brings
it back.

Measured: 3 columns at 1280 by default, 4 after choosing it, persisted across
reload with the attribute set pre-paint, clamped to 3 at 1100 with the stored
value still `"4"`, 1 column and no control at 375. No horizontal overflow at any
width.

A duplicate-id defect was caught here too: the catalog mounts the browser inside
a Suspense boundary and a second instance put duplicate `catalog-density-3` ids in
the document. Ids come from `useId` now.

## The 3D disclaimer

`Textures may not be accurate.` — inside `ProductModelViewer`, which is the only
thing in `src/` that constructs a `model-viewer`. A test walks the whole tree and
fails if a second one appears, so a future quick-view or configurator inherits
the notice by construction rather than by somebody remembering.

In normal flow beneath the viewport, not an overlay: the model's whole surface is
its drag target for camera control. Not dismissible, not a tooltip, not a toast,
not conditional on anything. Verified in a browser at 1280 and 375 — exact text,
`opacity: 1`, below the stage, not overlapping it — and absent on a product with
no model.

## Migrations — applied, with approval

| Version | What |
|---|---|
| `20260809102004_option_value_media_and_display_style` | `product_option_values.media_id` (nullable, FK to `product_media` ON DELETE SET NULL, partial index, same-product trigger) and `product_option_groups.display_style` (NOT NULL DEFAULT `buttons`, CHECK buttons/swatches) |
| `20260809102051_option_value_media_trigger_not_callable` | Revokes EXECUTE on the trigger function from `public`, `anon`, `authenticated` |

Dry-run against production inside a transaction and rolled back, twice, with the
rollback verified by re-querying `information_schema` both times. The exercise
proved: same-product image accepted; cross-product refused `23514`; the price
adjustment untouched; deleting a linked image nulls the link and leaves the value
on sale and priced; `display_style` defaults to `buttons`, rejects `rainbow`,
accepts `swatches`; clearing back to null always allowed.

After applying: 4 option values, all 4 still priced, all 4 unlinked; 2 groups on
`buttons`; 6 media rows; 3 products; 11 orders — all unchanged.

The second migration exists because the first introduced a **new security advisor
finding**: PostgREST publishes every `public` function as `/rest/v1/rpc/<name>`,
so a SECURITY DEFINER trigger function was callable by `anon`. Calling it would
fail anyway — `new` is unbound — but "it errors" is not an access control.
Revoked from PUBLIC as well as the two roles, because role grants inherit from
PUBLIC. Verified after: `has_function_privilege` false for both, and the trigger
still fires and still refuses a cross-product image.

Numbered `202608091020xx` rather than `20260808030000` so they sort *after* the
applied-but-unfiled guest migration, which the runner is entitled to refuse
otherwise. No grants issued and none needed — both are column additions and a
column inherits the table ACL. RLS unchanged: every policy on both tables is
row-scoped and none enumerates columns.

## Validation

- **1623 tests pass, 0 fail** (1620 at `e012e9f`). Seven new suites; five
  existing suites re-pointed to the new mechanisms and made stricter.
- Typecheck clean. Production build clean from a cleared `.next`, exit 0.
- **Lint at the 332 baseline** (178 errors, 154 warnings), unchanged.

Three tests failed on their first run and each was right to. `appearance-tasks`
refused the claim that "customizable" returns exactly one result — it returns two,
and the second is true. `catalog-grid-density` caught the React Compiler refusing
a callback that depended on a render-scoped helper. `staff-sidebar-scroll` failed
on its own documentation: the comment explaining that `opacity: 0` was removed
contains the string the assertion forbade.

### What could not be verified, and why

- **A signed-in staff session.** Unchanged since pass 3. The sidebar was driven
  through a temporary local harness mounting the real `StaffShell` with
  `["meAccess"]` seeded, at a path middleware does not guard. Deleted before the
  commit; no file in the diff references it.
- **The Appearance page in a browser.** Its rules are covered by 16 new tests
  over the task layer, but the rendered page was not driven. The preview's
  click-to-jump was not built.
- **Order option display (phase 11).** `order_items.selected_options` stores
  `{option_key: value}` and no order in production has a non-empty one, so there
  was nothing to render and no format to preserve. Showing "Colour: Blue (+$10)"
  needs the label and the adjustment *snapshotted* at checkout — resolving them
  live would let a later staff edit rewrite what a customer was told they paid.
  That is an additive `order_items` column and its own approval; deliberately not
  done here rather than done wrongly.
- **The running Vercel preview**, as in every previous pass: SSO-gated, and the
  Vercel CLI is not installed.

## Deferred, honestly

1. **Order option display**, above — the one phase of this pass not delivered.
2. **The `guest_order_access_codes` drift.** Recorded, not repaired.
3. **Multiple manufacturable items per order.** The staff order page is built on
   the single-product shape (`order.product_name`, `order.quantity`); jobs can now
   carry an `order_item_id` but nothing yet offers a per-line choice.
4. **`ProductRequestForm`** still renders its own option list and does not use
   swatches or the gallery link.

## Owner checks worth five minutes

1. **Open any staff page and collapse the sidebar.** Hover an icon — the label
   should appear beside the rail, not be cut off at 72px.
2. **Expand "More tools" on a short screen.** The menu should scroll inside the
   sidebar while the page behind it stays put, and Audit log should be clickable.
3. **Open an order, then Production.** "Create production job" should open a form
   naming the order and carrying its quantity.
4. **Press "Link existing job" and search.** Every result should say where it
   currently lives; picking one already on another order should ask first.
5. **Appearance, then search "customizable".** One obvious result with three fields.
6. **A product with a 3D model.** The notice should be under the model, always.
7. **`/catalog`.** Three columns; try the density control and reload.

# Pass 18 — guest order email verification, restored and finished

| | |
|---|---|
| Started from | **`e4f8bfb`** — `main == origin/main`, clean tree, 1623 tests green |
| Preserved implementation | **`aae7980`** — merged as `aaba2b4`, reverted as `13cfa05` |
| Migration ledger | **50 repo files, 50 production rows — identical sets, reconciled** |
| Scope | Only the guest six-digit verification feature. No Appearance, Production, catalog or option work. |

## What this pass is

`20260809010000_guest_order_verification` has been applied in production since
pass 17, with no file in this repository and no code reading it: the table and
its three functions sat dormant because the *application* was reverted while the
migration stayed. This pass restores the feature onto current `main`, fixes the
four defects that made the first attempt not integration-ready, and reconciles
the ledger.

## The migration drift is resolved, by restoring the file rather than deleting the line

The rule `staff-schema-contract.test.ts` enforces is that a drift entry may only
be removed by restoring the file or by dropping the objects. The file was
restored, and only after the live objects were proven identical to it:

| Checked | Result |
|---|---|
| Columns | 8/8 identical, same types, nullability and defaults |
| Indexes | `pkey`, `order_created_idx`, partial unique `one_active_idx` — identical |
| Constraints | Both checks and the `orders` FK with `on delete cascade` — identical |
| RLS | Enabled, **zero policies** — deny-all, as written |
| Table grants | `postgres` and `service_role` only; `anon` and `authenticated` hold nothing |
| Function bodies | All three byte-identical via `pg_get_functiondef` |
| Function ACLs | `postgres=X`, `service_role=X` — no PUBLIC, no anon, no authenticated |
| `email_templates` | `guest_order_access` row present with the file's exact values |

The one apparent difference — `service_role` additionally holding `Dxtm` on the
table — is Supabase's own default privilege on any new `public` table, not
something the file could have granted. `pg_default_acl` confirms it, and sibling
tables created by ordinary repo migrations carry the same grant. So the file
represents history rather than creating it, and it was **not re-executed**.

The historical file is kept byte-exact (sha256 `b22b9faa…12e05`), which is why it
still says `create table` rather than `create table if not exists`.

## The four defects, and what each actually was

**A. A missing secret produced an HTTP 500.** `digestGuestVerificationCode` threw
when `GUEST_ORDER_VERIFICATION_SECRET` was absent and nothing caught it, so a
deployment without the secret answered a routine page load with an uncaught
exception. Absence is now a checkable state: every entry point tests
`guestVerificationConfigured()` *before* touching the database, returns
`not_configured`, and the route answers 503 with a sentence that names no
environment variable. One server-side line names the variable and never its
value. Verified in a browser — 503, calm inline notice, no cookie set, no order
exposed.

**B. 24 hours and 90 days both claimed.** The first attempt shortened the session
to a day but left three customer-facing pages promising 90 days. The number now
lives once, in a `node:crypto`-free module so client components can quote it
without dragging Node's crypto into the browser bundle. The cookie's `Max-Age`,
the order row's expiry and the sentence the customer reads all derive from it.

**C. Two focused failures.** Both asserted the *old* shape rather than a weakened
rule. The session-token assertion used a lazy regex that matched the
`Set-Cookie` line following `NextResponse.json({ verified: true })` and so failed
on correct code; it now asserts the literal body and that no token appears in it.
The denial assertion required a branch that intentionally no longer exists —
every routine denial now renders the same challenge, which is strictly stronger
than wording them differently. The cookie-flag assertions moved to the shared
`guestOrderCookieOptions`, and every minting route is now required to use it, so
a fourth route cannot get the flags wrong unnoticed.

**D. The installer baseline had no `guest_order_access_codes`.** The migration
runs once and the baseline is promised re-runnable, so they cannot be the same
text. `supabase/installer/modules/commerce.sql` now restates the schema
idempotently — same columns, indexes, RLS, grants, function bodies and ACLs —
and the template seed is guarded by `to_regclass`, because that module's include
list does not itself create `email_templates`.

## The anti-spam rule is server-side, because a client guard is a suggestion

The first attempt sent a code on every mount and relied on the 60-second
cooldown. That only rate-limits: a refresh every 61 seconds for fifteen minutes
would have delivered fourteen codes. The page now asks the server to *ensure* a
challenge exists — `ensureGuestCode` reuses a live one and returns the masked
address without sending anything. Only the explicit button replaces a challenge,
and only that is governed by the cooldown. A per-challenge delivery key means
even a duplicated request cannot deliver two copies of one code.

## Email links are derived from ownership in exactly one place

`sendCommerceEmail` was building `/orders/{id}` unconditionally, which sent every
guest to a page that reads through RLS as a signed-in customer and can only
refuse them. It now resolves `customer_id` once and calls `customerOrderUrl`, so
all 52 catalogued events are covered by one decision. An audit found no other
customer order URL constructed anywhere: the remaining `/orders/{id}` in
`orderNotifications.ts` is an in-app notification that requires a
`recipientUserId`, which a guest by definition does not have.

## Verified in a browser, and what was not

Driven locally: the challenge form renders for a guest route with no session; the
missing-secret path returns 503 and renders inline rather than crashing; the form
carries `inputMode="numeric"`, `autocomplete="one-time-code"`, a bound label and
`aria-describedby`; pasting `123 456`, `12-34-56` and `abc123456789` all normalise
to six digits while `000042` keeps its leading zeros; Verify stays disabled below
six digits; the cooldown counts down and disables the button; mobile has no
horizontal overflow, 46px touch targets and a 16px input font.

**Not verified, and stated plainly:** anything requiring a working database. The
local Supabase key is deliberately fake, so a real send, a real code entry, a
real session mint and cross-order isolation were proven by tests and by the SQL,
not by a browser. The Vercel preview remains SSO-gated and the CLI is not
installed.

## Numbers

| | |
|---|---|
| Code | 6 digits, `randomInt`, HMAC-SHA-256 at rest, order-bound |
| Code lifetime | 15 minutes |
| Attempts | 5 |
| Resend cooldown | 60 seconds |
| Session | 24 hours, httpOnly, SameSite=Lax, Secure in production |
| Tests | 1623 → **1651**, all green |
| Lint | **332**, unchanged |

## Deployed

| | |
|---|---|
| `origin/main` | **`e2792b6`** — merge commit, no force push (`e4f8bfb..e2792b6`) |
| Production deployment | `keymoura-website-2rxsocpkt` — **Ready**, 3m build |
| `GUEST_ORDER_VERIFICATION_SECRET` | Configured for **Production and Preview**, marked Sensitive/Hidden |
| Migration ledger | 50 repo files == 50 production rows, version sets hash-identical |

The secret was configured *before* the merge, so the code that depends on it never
existed in an environment without it.

### How the deployment was confirmed to contain this work

Vercel's CLI exposes no git metadata for a deployment, so the build was identified
by serving code that exists only in `e2792b6`, from three separate files:

- `/api/orders/guest/[id]/verification` responds at all, with the exact new wording
  ("That code is not right. Check the digits and try again.") — a route that did not
  exist in `e4f8bfb`.
- The guest page renders `Codes expire after <!-- -->15 minutes` and
  `Enter the <!-- -->6<!-- -->-digit code` — React's SSR split around
  `GUEST_CODE_TTL_LABEL` and `GUEST_CODE_LENGTH`, both new constants.
- The deployed cart chunk contains the new 24-hour copy and **no longer contains**
  the old 90-day sentence.

### Production smoke results

- `/`, `/catalog`, `/orders/new` — 200.
- **A real guest order id with no session leaks nothing.** Fetched server-side so no
  client JS ran and no email was sent: no order number, no guest email, no product
  name, no total, no Summary panel, no Items panel, no pickup or tracking detail, no
  `?token=` or `?code=`. The only "tracking" match was the Tailwind class
  `tracking-tight`, which appears identically on a page for an order that does not
  exist. `noindex` present.
- **The account route still refuses anonymously.** Neither an account order nor a
  guest order rendered its order number, email, or any money value.
- Malformed order id and malformed code both answer 400 with the generic wording.
- The verification POST answered **400, not 503** — which is how the runtime proved
  it can read the secret without the value ever being displayed.
- Deployed form: `inputMode="numeric"`, `autocomplete="one-time-code"`, label bound
  to the input, `aria-describedby` resolving to the live error node, `aria-invalid`
  set. Pasting `123 456` and `12-34-56` normalise to six digits, overflow truncates,
  `000042` keeps its leading zeros, and five digits leaves Verify disabled. Mobile
  at 375px: no horizontal overflow, 46px touch targets, 16px input font.

### Not live-tested, and why

**The real send → verify → session flow was never exercised in production.** Both
existing guest orders belong to real customers, and emailing a verification code to
a customer to satisfy a test is not an acceptable trade. There is no owner-controlled
guest order. So the code generation, the HMAC comparison, the attempt counter, the
cooldown, the consume-and-rotate step and the resulting 24-hour session are covered
by tests and by the SQL that enforces them — not by a live message. That gap is
stated rather than papered over.

### Found while verifying, not fixed here

- ~~**A guest submitting a product request is still routed to the account page.**~~
  **This claim was wrong and is corrected in pass 19.** It was inferred from a grep
  for `/orders/${...}` without reading the branch guard above the match. The guest
  branch of `ProductRequestForm` returns early at
  `router.push(guestData.href ?? \`/orders/guest/${guestData.id}\`)` and never reaches
  the `/orders/<id>/confirmed` line below it, and `orders/new` redirects to login
  before submitting. No guest was ever misrouted. Pass 19 re-audited the flow, found
  the real defect to be latent rather than live, and fixed that.
- **The two live guest sessions still expire in November**, having been minted under
  the old 90-day rule, while the page now tells them 24 hours. Existing sessions are
  deliberately not shortened — invalidating a paying customer's access to make a
  sentence true would be the wrong trade. It self-resolves as those sessions lapse.

## Deferred, honestly

1. **Account claiming.** A signed-in account whose address equals `guest_email` is
   deliberately *not* given a bypass — an address is not an authorization. Letting
   an account adopt a guest order is a separate feature.
2. **The advisor finding on `guest_order_access_codes`** is `rls_enabled_no_policy`
   at INFO, which is the intended deny-all and matches fourteen sibling tables.
   `unused_index` on `order_created_idx` is true only because the feature was
   dormant. Neither warrants a migration, so none was written.
3. Everything carried from pass 17 that this pass did not touch.

## Owner checks worth five minutes

1. **Open a guest order link from a different browser.** You should get "Order
   access" and a six-digit field, not a permission error.
2. **Refresh that page several times.** Exactly one email, not one per refresh.
3. **Press "Send a new code" twice.** The second press should be a countdown.
4. **Type five digits.** Verify should stay disabled.
5. **Open any order email as a guest.** The button should go to
   `/orders/guest/<id>` and carry no `?code=` or `?token=`.

# Pass 19 — order-success navigation, and a correction to pass 18

| | |
|---|---|
| Started from | **`68d78cf`** — clean tree, 1651 tests green |
| Scope | The custom/product-request success navigation only. No schema, no migration, no change to guest verification. |
| Result | Code-only: three files, two of them one-line-ish, plus a focused test file. |

## The reported bug did not exist

Pass 18 recorded that a guest submitting a product request was routed to the
account page and dead-ended. **That was wrong**, and this pass exists partly to
say so. It came from grepping for `/orders/${...}` and reading the match without
the branch guard above it.

`ProductRequestForm` has two submit paths, and the grep found the second:

- **Guest** — `if (!auth.user)` posts to `/api/orders/custom` and returns early at
  `router.push(guestData.href ?? \`/orders/guest/${guestData.id}\`)`. It already
  honoured the server's href, and even its fallback is the guest route.
- **Account** — everything below that early return. It posts to `/api/orders`,
  which answers 401 without a user, and lands on `/orders/<id>/confirmed`.

`orders/new` redirects to login before it submits at all. So both routes to
`/confirmed` were signed-in only, and the reconstruction there happened to be
correct. No customer was affected.

## What was actually wrong: the same defect, one guard away

The real problem was that ownership was being decided **twice** — once by the
server, which knows whether the row got a `customer_id` or a guest token, and
again by a client rebuilding a path from an id. Both copies agreed, so nothing
failed; the client was simply computing an answer it had no information for, and
it was the copy the customer followed.

Two places, both now fixed:

1. **`orders/new/page.tsx`** discarded the server's `href` — the response type did
   not even declare the field — and rebuilt `/orders/<id>/confirmed`. It now uses
   `result.href` and keeps the rebuild only as a fallback.
2. **`/orders/[id]/confirmed`** was a client component building `/orders/<id>` out
   of the route parameter, with no way to know whose order it was. It is now a
   server component that resolves `customer_id` and hands it to
   `customerOrderPath` — the same single decision the emails use since pass 18.

That makes requirement "a guest never routes through `/orders/<id>`" **structural
rather than conditional**: it holds however the page is reached, instead of
holding because two client-side guards are currently correct.

## What the confirmation page does and does not do

It reads one indexed column and renders none of it — no order number, no email,
no product, no money, asserted by test. The markup is identical either way; only
the button's target differs. Both targets refuse an unauthorized viewer anyway:
the account page through RLS, the guest page through the six-digit challenge, so
pointing a guest at their guest page is not an access path. A failed or malformed
lookup keeps the historical `/orders/<id>`, which is where every route that leads
here belongs — failing to the guest path instead would send an account customer
to a verification form for an order that can never issue a code.

The page moves from static to dynamic in the build output, which is the expected
cost of the lookup.

## Verified

Locally: the confirmation page renders as a server component, leaks no order
data, and with the local Supabase key deliberately invalid the CTA falls back to
`/orders/<id>` — the fail-safe branch, exercised end to end. The guest route
still renders the six-digit challenge, unchanged.

In production, read-only and sending nothing: the confirmation page for a real
**account** order links to `/orders/<id>`, and for a real **guest** order links to
`/orders/guest/<id>`. That is both ownership branches proven against real data.

**Not verified:** a full guest custom-request *submission* was not driven in a
browser. The local Supabase key is deliberately fake, so `/api/orders/custom`
cannot create an order locally, and creating a real guest order in production to
watch a redirect would put a real row and a real email into the system. The
navigation decision is covered by tests against the source and by the production
check of both confirmation branches.

## Numbers

| | |
|---|---|
| Tests | 1651 → **1662**, all green |
| Lint | **332**, unchanged |
| Migrations | none — 50 repo files == 50 production rows, untouched |

---

# Pass 20 — the audit log, made real

## Verified starting state — 2026-08-09

`main` clean and equal to `origin/main` at `00a6fe7`. Migration ledger
reconciled: 50 repo files == 50 production rows. Tests 1662, lint 332.

## There was already an audit system, and it had never shown anybody anything

KeyMoura had `audit_logs`, `logAuditEvent()` with 115 call sites across 46
files, a `staff.` / `admin.` / `moderation.` taxonomy, and a page at
`/staff/security/audit`. Forty-six real events had accumulated in the table
since July.

Not one of them had ever been visible.

`authenticated` held no `SELECT` grant on `audit_logs`. Postgres checks grants
before RLS, so the policy allowing staff to read was never reached. Proven
against production:

```
BLOCKED 42501 :: permission denied for table audit_logs
```

The page read the table from the browser with the anon key. `fetchPage` threw,
and the `load()` that called it had a `finally` but **no `catch`** — so the
rejection went nowhere and the UI rendered "No audit events found." over a table
that had forty-six of them. This is the same class of defect as the pass-7
production grants and the pass-17 roles columns: the failure was loud in
Postgres and silent in the application.

Two more found in the same inspection:

* **History was editable.** The `staff manage` policy was `FOR ALL`. Any staff
  session could `UPDATE` or `DELETE` past entries. An audit log a suspect can
  rewrite is not an audit log.
* **Inventory was filed against the wrong table.** The stock route called
  `logLifecycleAudit({ orderId: productId })`, and that helper hardcodes
  `targetTable: "orders"` — so every adjustment was recorded as an *order* event
  carrying a product's id.

So this pass finished the system that existed rather than building a second one.
Nothing was renamed: the 46 rows and the 115 call sites keep their event types,
and the legacy names are registered in the taxonomy alongside the new ones.

## The one architectural decision: catalog has no server route

Products are written **straight from the browser** — `src/app/staff/catalog/page.tsx`
calls `supabase.from("products").update(...)` in ten places. There is no server
seam where a price change could be logged, so `product.price_changed` could not
be implemented the way orders and production were.

A trigger is not a shortcut here; it is the only correct answer. It runs inside
the same transaction as the write, catches every path including ones added
later, and cannot be forgotten by a new caller. It is also the only part of this
pass with *strict* transactional integrity, which is worth being plain about.

The column allowlist is the substance of it. A product row carries marketing
copy and a `detail_content` document; the trigger compares twenty-nine named
columns and records prose as a **length**, never a body. `inventory_quantity` is
deliberately excluded — stock has its own ledger and its own event, and
including it would have double-logged every adjustment.

## Transactional integrity, stated honestly

| Path | Guarantee |
|---|---|
| Catalog | Same transaction as the write. Cannot diverge. |
| Everything else | Written only after the mutation is confirmed; failure is surfaced, never swallowed. |
| Roles and permissions | As above, and strict — the caller fails rather than reporting a clean success. |

The order route is the shape of it. The audit event is written immediately after
the guarded update reports an affected row and before the emails that follow.
Earlier would record a change the `.eq(status)` guard may have refused — the
false success that guard exists to prevent. Later would leave a window where the
customer has been told and nobody knows who decided it. A failed audit write
returns `auditFailed: true` in the response rather than a clean 200.

The residual gap is real and is not papered over: mutation committed, process
dies before the audit insert. Supabase's REST client has no cross-statement
transaction, so closing it would mean moving each mutation into an RPC. That is
a larger change than this pass, and it is recorded here rather than hidden.

## What the page shows

```
Ethan   Changed order status   KM-0012
        In production → Ready for pickup            Aug 9, 2:42 PM
```

Filters, search and paging all run in Postgres. Paging is a keyset cursor on
`occurred_at` with `id` breaking ties — offset paging over a table that grows at
the head shows duplicates, and a page boundary landing inside a burst of
same-timestamp events silently drops rows. The browser never holds more than one
page of 50.

`/staff/security/audit` is now a redirect. Two audit pages would mean two
definitions of what an event is.

## Two defects the existing tests caught

Worth recording, because both were mine and both were invisible to TypeScript:

* `staff-schema-contract` refused `roles.label` and `roles.priority`. The role
  editor speaks `label`/`priority`; the table has `name`/`rank`, and
  `toRoleDbColumns` is the one place that translates. My `select()` used the
  wire names and would have failed with 42703 on every role edit — exactly the
  defect that suite was written for after pass 17.
* My own new test refused `forum.` as a retained prefix. It would have admitted
  post votes and views into a table meant for staff actions. Narrowed to the two
  destructive moderation events.

One test was rewritten rather than satisfied: `commerce-domain` asserted the
retention rule by matching the *source text* of `src/lib/audit.ts`, so it broke
when the rule moved into a module without any change in behaviour. It now
imports `isRetainedAuditEvent` and asserts what it does.

## Verified in a browser, and what was not

The local service-role key is a placeholder and `/staff/*` is gated by
middleware, so the real page cannot be driven locally against real data. A
temporary harness mounted the same component outside the gate against fixtures
and was deleted before commit.

Driven and confirmed: newest-first ordering; the four specified example rows
rendering exactly as specified; row expansion showing actor, full timestamp,
affected entity, the before/after table and `Open order`
-> `/staff/orders/<uuid>`; the area filter narrowing to one row and putting
`?area=catalog` in the URL; the dependent action dropdown appearing only once an
area is chosen; search for `KM-0012` returning both its events and nothing else;
the empty state; cursor paging to page two with `Newest` correctly disabled on
page one and `Older` on the last; 375px and 768px with no horizontal overflow.

**Not verified:** the page against real production rows. Reaching it needs a
real staff session, and the audit permission gate and RLS were checked against
the database directly instead — including that `authenticated` can now read,
that `anon` cannot, and that `UPDATE`, `DELETE` and `TRUNCATE` are all refused.

## Migration — applied, with approval

`20260809200000_audit_event_model.sql`. Dry-run in a transaction against
production and rolled back, twice, before approval was requested; the rollback
was verified by re-reading the column count, row count and grants.

| Check | Result |
|---|---|
| 46 existing rows preserved | 46 |
| `anon` can read | no |
| `authenticated` read / update | yes / no |
| `service_role` insert / delete | yes / no |
| `UPDATE` a historical row | refused by trigger |
| `DELETE` a historical row | refused by trigger |
| Account deletion still possible | yes — narrow FK exception |
| Product 4000 -> 4500 | `product.price_changed` |
| `updated_at`-only write | no event |

## Two things the first deploy found

Both were caught smoke-testing production after the merge, and both are now
fixed and deployed. Recording them because "verified after deploying" is the
only reason either was found.

**Catalog rows had no summary line.** The trigger writes in SQL and cannot call
the TypeScript formatter, so every product event arrived with `summary` null and
rendered as `Changed product price / Shift Knob` with the `$40.00 → $45.00`
nowhere on the row — visible only behind an expand, which is the one line the
row exists to show. The list route now derives it from `changes` when the stored
summary is null. Deriving rather than backfilling keeps the formatting in one
place: a summary frozen at write time would keep whatever wording was current
the day it was written.

**A confirmed payment recorded nothing.** `stripe_webhook_events` held the
provider record, but the business transition — unpaid to paid, the one a person
looks for — was absent from the audit log. It now writes exactly one event,
after the applied/duplicate guard so a replay records nothing, carrying the
Stripe event id. One event per *transition*, not per webhook: copying every
delivery in would bury the handful of events somebody decided. The refund events
already existed but said "System"; they now say **Stripe**, which is the point
of having an actor model at all.

## Numbers

| | |
|---|---|
| Tests | 1662 -> **1708**, all green |
| Lint | 332 -> **331** — the dead page's `any` usages went with it |
| Migrations | 50 -> **51** repo files == 51 production rows |
| Final SHA | `c0b8633` |

# Pass 21 — user management, made a workspace

## Verified starting state — 2026-08-10

`main` clean and equal to `origin/main` at `4245515`. Migration parity 51 == 51.
Tests 1708, lint 331 (`npx eslint src`).

## There was already an identity system; nothing it had was rebuilt

KeyMoura's user model was complete and none of it was duplicated:

| Concern | Where it already lived |
|---|---|
| The user | `profiles` — its `id` **is** `auth.users.id` |
| Roles | `user_roles` (PK `user_id`, so exactly one role) → `roles.rank` |
| Permissions | `permissions` / `role_permissions` / `user_permissions`, DB-first |
| Standing | `user_bans` + `user_restrictions` (site / community / dm) |
| Providers | `auth.identities` — email, google, facebook |
| Ownership | `orders.customer_id`, with `guest_email` for guest orders |
| Audit | the pass-20 model, already writing `role.assigned` strictly |

So no second user table, no parallel RBAC, and no new status column. What was
missing was a **place where those facts met a customer's commerce**: the old
`/staff/security/users` was 1,581 lines that selected every profile into the
browser and offered a permissions matrix where an order history should have been.

`/staff/users` and `/staff/users/[id]` replace it. `/staff/security/users` and
`/staff/info/users` are now redirects, for the reason `/staff/security/audit`
became one in pass 20: two user pages would mean two definitions of a user.

**Nothing was dropped in the move.** The workspace calls the same routes the old
page did — role, permission overrides, verification, donation rank, profile
edit — and a test asserts each one is still reached, so the redirect cannot
quietly delete a feature.

## The decision that shaped the migration

`service_role` holds **no grant on `auth.users` or `auth.identities`** — checked
against production; only `postgres` does. Searching the directory by email needs
that table, so `staff_user_directory` is **security definer** (unlike
`staff_order_queue`, which is `security_invoker`) and granted to `service_role`
alone. Proven, role-switched, against production:

```
svc.auth_users_direct = blocked(42501)
svc.directory         = ok
```

The `auth` columns are named one at a time — email, `email_confirmed_at`,
`last_sign_in_at`, `banned_until`, `deleted_at`. A `u.*` here would have put
password hashes one JSON response away from a browser, and a test refuses it.

## Guest orders are not claimed, and cannot become so by accident

Ownership is `customer_id` equality and nothing else. A guest order whose
`guest_email` matches is shown in its own array, flagged `owned: false`, labelled
"Unclaimed guest order", and counted in **no** metric. Email equality is a claim
anybody who can type can make.

Searching an order number resolves to its owner; a *guest* order number returns
no users and says why, rather than quietly offering the account whose address
matches.

## What spend means

`amount_paid_cents` — money actually received — less refunds, floored at zero.
An unpaid quote, an abandoned checkout and an order cancelled before payment all
carry zero there, so none needs excluding by name. Verified against production:
every figure matches an independent hand computation for all three accounts.

One nuance worth stating: an `awaiting_payment` / `unpaid` order contributed
**$25.00**. That is a real deposit received. `payment_status` means "not fully
paid", not "no money arrived", and counting it is correct.

## Two rank rules, not one

* You cannot act on somebody **at or above** your own rank.
* You cannot **grant** a role at or above your own rank.

Dropping either leaves the escalation open: without the first a moderator
demotes an admin, without the second they promote a sock puppet and reach
everything indirectly. Both are pure functions in `userAccess.ts`, so the route
and the tests evaluate the same rule rather than two readings of a paragraph.
Role changes are stale-state guarded (`expectedRole`), and the last admin cannot
be demoted by anyone, owner included.

## Three routes were writing silently

`verify` and `donation-rank` had **no audit event at all**, and `profile` had
none and no before/after. All three now record `user.profile_changed` with a
real diff. Verification matters most: `loadPermissionsForUser` grants everything
in `site_verified_perks` to a verified account, so that flag can hand somebody
capabilities.

## Notes are append-only, and the audit row does not copy them

A note cannot be edited or deleted — refused twice over, by withheld grant and
by trigger. Archiving is the only permitted mutation and is guarded with
`.is("archived_at", null)` so two staff pressing Archive produce one archive and
one 409.

The audit event carries the note **id, category and length** — never the body.
Copying a customer's circumstances into `audit_logs` would double the places it
has to be protected and redacted, for no gain: the note is the record.

## Migration — applied, with approval

`20260809210000_user_management.sql`. Dry-run in a transaction against
production and rolled back **twice** before approval was requested, the rollback
verified by re-reading the objects (all `null`) and the row counts.

| Probe | Result |
|---|---|
| Edit a note's body | refused `42501` |
| Delete a note | refused `42501` (trigger **and** no grant) |
| Archive / un-archive | ok / refused `42501` |
| Blank body / unknown category | refused `23514` |
| `anon` → directory, notes | blocked / blocked |
| `authenticated` → directory, notes, insert | blocked / blocked / blocked |
| `service_role` → directory, notes / delete | ok, ok / blocked |

### A ledger-drift note, recorded rather than hidden

Parity holds at **52 repo files == 52 production rows**, but the new row's
`version` is `20260810021827` — the timestamp the apply tool assigned — while
its `name` is `20260809210000_user_management`. The file is identified by name,
not by a version matching its filename prefix, unlike the 51 rows before it.

### Two advisor findings, one investigated and dismissed

`user_staff_notes` shows `rls_enabled_no_policy` (INFO). That is the intent: RLS
on with no policies and no grants means unreachable, and `service_role` bypasses
RLS with explicit grants. Fifteen existing tables share the pattern.

`user_staff_notes_append_only` shows `anon_security_definer_function_executable`
(WARN). Checked rather than assumed, and it is a static false positive — the
function returns `trigger`, which PostgREST never exposes over RPC, and Postgres
itself refuses the call for both roles:

```
0A000: trigger functions can only be called as triggers
```

Its search_path is pinned to the empty string. Five pre-existing trigger
functions carry the identical warning. No migration was raised for it.

## Verified in a browser, and what was not

The local service-role key is a 38-character placeholder, so every server route
fails with "Invalid API key" locally, and `/staff/*` is gated by middleware. A
temporary harness mounted the **real** components outside the gate against
fixtures and was deleted before commit.

Driven and confirmed: the directory rendering role, staff standing, status,
spend and order counts per row; search; the role, account-type, status and
orders filters; sorting by name, orders and spend; paging with exactly one nav
button disabled at each end; the empty state; all six workspace tabs and their
`#hash`; the guest-order section labelled unclaimed; the dangerous role change
demanding "Yes, make them Member" with "This removes their staff access
immediately", and Cancel restoring; the status reason gate refusing 5 characters
and accepting 38; note create, archive, and archived-hidden-by-default; masked
recipients with no provider ids; sign-in methods read-only; 375px and 768px with
no horizontal overflow.

**Two real defects the walkthrough found**, both fixed:

* `formatRelative` rendered **"1 months ago"**.
* The role dropdown read an empty **"Select"** whenever the current role was not
  in `assignableRoles` — which is *always*, since a no-op assignment is refused
  and rank excludes anything at or above the actor. It now lists
  "Admin (current)" first.

**Not verified:** the pages against real production data. That needs a real
staff session; the grants, RLS and metrics were checked against the database
directly instead.

### How the deployment was confirmed to contain this work

Vercel exposes no git SHA on a deployment, and every new surface is behind the
staff gate, so no public page could prove it. The production build log names the
artifacts instead — all eight new API routes plus both pages, including
`app/api/staff/users/[id]/activity/route.js` and `.../communications/route.js`,
which exist only in this commit.

## Numbers

| | |
|---|---|
| Tests | 1708 -> **1794**, all green |
| Lint | 331 -> **277** — the old page's `any` usages went with it |
| Migrations | 51 -> **52** repo files == 52 production rows |
| Final SHA | `aaf5b29` |

## Known gaps

* **Avatar upload is display-only here.** The existing upload route was left
  untouched; the workspace shows the avatar and falls back to an initial when a
  stored URL goes stale.
* **Email is read-only**, because there is no verified change flow. Adding one
  is an auth change, not a user-management one.
* **Guest-order claiming is not built.** It needs a real ownership proof.
* **Provider unlinking is not offered**, deliberately — read-only was the brief
  and no safe server flow exists.
* `/api/staff/ban-user` and `/api/staff/restrictions/set` still serve the
  moderation surfaces and write the same tables. The new status route is
  strictly stricter (reason required, rank enforced, self refused, stale-state
  checked); the older two were left alone rather than have their contract
  changed underneath the moderation UI.

# Pass 22 — customer support, made a system

## Verified starting state — 2026-08-10

`main` clean and equal to `origin/main` at `a59b777`. Migration parity 52 == 52.
Tests 1794, lint 277 (`npx eslint src`).

## There was no support system. There was a form that sent an email.

`/contact` posted to `/api/contact`, which built its own `new Resend(...)`, sent
one message to a mailbox, and **stored nothing**. No row, no reference, no
status, no owner, no history. Every question any customer had ever asked existed
only in somebody's inbox, and the answer to "how many are outstanding?" was
whatever that person remembered.

It was also, by the standard pass 12 set, a **second email sender**: it bypassed
`sendCommerceEmail`, `email_templates`, `email_deliveries` and the audit log
entirely. So this pass consolidates rather than adds a third — `/contact` is now
a redirect, for the reason `/staff/security/audit` and `/staff/security/users`
became redirects in the two passes before it.

Everything else was reused, not rebuilt:

| Concern | What it already was |
|---|---|
| Email | `sendCommerceEmail`, claim-before-send on a unique `event_key` |
| Staff notification | `raiseOperationalAlert`, permission fan-out, durable keys |
| Audit | `audit_logs` + `recordAuditEvent`, immutable since pass 20 |
| RBAC | `permissions` / `role_permissions`, DB-first |
| Readable references | `keymoura_order_number_seq` + a `BEFORE INSERT` trigger |
| Append-only notes | `user_staff_notes`: trigger **and** withheld grant |
| Server-side lists | `staff_user_directory` + a pure filter module |
| Guest authorization | `guest_token_hash` cookie, `authorizeGuestOrderWrite` |

## The one architectural decision: `order_messages` was left alone

It is the existing conversation system — it has `is_internal`, a client-token
dedup and an email fan-out. It is also **order-scoped**: `order_id` is `NOT NULL`
and every policy and route keys off the order. It cannot express a question that
is not about an order, and has nowhere to put a subject, a category, a status, an
owner or a priority.

Widening it would have meant inventing a conversation entity anyway *and*
rewriting the RLS of a live table with rows in it. So the order thread stays what
it is, a support conversation **links** to an order, and both appear on the order
workspace — because a staff member reading one needs to know the other exists.

## A reply and a note are two endpoints, not one endpoint with a boolean

This is the design the whole feature turns on. The boolean version has a single
branch deciding whether to email a customer, and that is precisely the line that
gets inverted, negated or moved during a refactor — with a staff-only note about
a customer arriving in that customer's inbox as the failure mode.

So: `POST .../reply` always sends. `POST .../notes` contains **no send call at
all** — no `sendCommerceEmail`, no `notifyCustomerOfReply`, nothing that
transitively reaches the mailer — and a test asserts its source contains none.
`appendSupportMessage` sends nothing and notifies nobody; that is the caller's
decision, because the two callers make opposite ones.

The customer read path filters `visibility = 'customer'` **in the query**, not
after it. A row filtered in the query is never loaded; a row filtered afterwards
is one refactor away from being rendered.

## Five statuses, and the first two are genuinely different

`open` is "nobody has ever answered this person". `waiting_on_staff` is "this is
the fourth round". Both are ours to answer, which is why `isUnresolvedStatus`
exists and the inbox chips group them — but first response outstanding and
follow-up outstanding are different failures and deserve different urgency.

`closed` earns its place by being the one state a customer message does not move.
Without it there is no way to end a thread somebody keeps replying to.

The status and its timestamp are one fact, enforced:

```sql
check ((status = 'resolved') = (resolved_at is not null))
check ((status = 'closed')   = (closed_at   is not null))
```

so a row cannot be `open` while carrying a `resolved_at`. That is what "no
meaningless status combinations" means in a schema rather than in a paragraph.

## Ownership is `customer_id` equality, and nothing else

The rule pass 21 set for the user workspace, restated because this is the second
place it could quietly break. A guest conversation whose `guest_email` matches an
account is **not** that account's conversation — honouring that would let a
stranger read a customer's support history by signing up with their address.

Not-found and not-yours answer **identically** (404). A 403 confirms the
conversation exists, which turns the endpoint into a way to enumerate
conversations by trying ids.

A customer may attach an order only when `orders.customer_id` equals their own.
A guest may attach one only when their httpOnly guest-order cookie opens it —
`authorizeGuestOrderWrite`, the same function the guest message route uses, so a
guest who may reply to an order and a guest who may attach it are the same guest
by construction.

## Migration — applied, with approval

`20260810100000_support_conversations.sql`. Dry-run against production **three
times**, each rolled back and the rollback verified by re-reading the objects
(all `null`) and the counts (permissions back to 92, templates to 44,
role_permissions to 92).

| Probe | Result |
|---|---|
| Reference generation | `SUP-0001` then `SUP-0002` |
| Customer writing an internal note | refused `23514` |
| `UPDATE` / `DELETE` a message | refused `42501` |
| Rewrite a reference / swap the requester | refused `42501` |
| Both account *and* guest, or neither | refused `23514` |
| `resolved` with no `resolved_at` | refused `23514` |
| Assignment with no time | refused `23514` |
| Malformed guest email | refused `23514` |
| Double-submitted form | collapsed, `23505` |
| `anon` / `authenticated` — all seven probes | blocked `42501` |
| `service_role` — message update, delete, conversation delete | blocked `42501` |

## The defect that only re-reading the live grants found

`service_role` held **`TRUNCATE`** on `support_messages`.

`support_messages_no_rewrite` is a `BEFORE DELETE ... FOR EACH ROW` trigger, and
**a row trigger does not fire on TRUNCATE**. Supabase's default privileges hand
`service_role` everything on a new table in `public`, so revoking DELETE was not
enough: the table advertised as append-only could have been emptied in one
statement. The dry-run probes tested DELETE and UPDATE and both were correctly
refused — the hole was invisible to them.

`audit_logs` already closed this in pass 20.
`20260810110000_support_truncate_lockdown.sql` is revoke-only and brings the
support tables to the same standard; `support_messages` now reads
`INSERT,REFERENCES,SELECT,TRIGGER`, identical to `audit_logs`. A test asserts the
revoke, because the grant comes from a default nobody wrote and can come back the
moment somebody adds a table without thinking about it.

**`user_staff_notes` has the same hole** —
`INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE`. Recorded rather than fixed
here: it belongs to pass 21's table, and changing another pass's grants unasked is
not this pass's business. It is one `revoke` when somebody wants it.

## Permissions

Four, split by what each actually does: reading a customer's correspondence,
writing to that customer in KeyMoura's name, deciding a conversation's state, and
deciding whose job it is. Granted to `admin` and to the role literally called
**Support** — `is_staff`, ranked 40, **zero holders**, so this defines the role
rather than widening anybody's access. Deliberately **not** to `moderator`:
moderation is about community content, and a moderator reading a customer's refund
correspondence by default is a wider grant than that role was made for.

The staff sidebar ceiling moved from 16 primary destinations to 17, and that is
the point of having the assertion — raising it is a decision somebody had to make
in a diff. Support passes the same test Orders, Production and Fulfillment pass:
it is a queue with people waiting in it, worked every day. Nothing was demoted,
because nothing else stopped being daily.

## Verified in a browser, and what was not

The local service-role key is a placeholder, so a temporary harness served
fixtures to the **real** components at their real URLs and was deleted before
commit.

Driven and confirmed: the guest form with all eight categories and its help text
following the selection; `/contact` redirecting; the inbox with six
server-computed chip counts, `Needs attention` default and active; the
`unassigned` chip narrowing to one row and putting `?view=unassigned` in the URL;
free-text search, and `sup2` and `km12` normalising to `SUP-0002` and `KM-0012`
with the search note explaining what it did; the workspace header, the
chronological thread with the internal note in amber and labelled "the customer
cannot see this", and seven sections; a staff reply appearing, clearing the
composer and moving the status to `waiting_on_customer`; an internal note
appearing and **leaving the status where it was**; status, priority, category and
assignment, each sending its expected-value guard; a stale-state change refused
with "Somebody else changed this conversation while you were looking at it"; order
unlink swapping the panel to the link-by-number form; the user workspace's Support
tab at `#support` listing both of that customer's conversations with no bodies;
375px and 768px on every surface with no horizontal overflow.

**The load-bearing one.** The same conversation, read as the customer: three
messages instead of five. Neither internal note present — not the text, not the
label. The staff member rendered as **"KeyMoura"**, never by name. Status shown in
the customer vocabulary ("Received"), the order linking to `/orders/<id>` rather
than the staff path. A customer reply containing `<img src=x onerror=alert(1)>`
and `**bold**` rendered as `&lt;img src=x onerror=alert(1)&gt;` inside a
`whitespace-pre-wrap` paragraph — no element created, no markdown interpreted.

**Not verified:** the order workspace's support panel in a browser. It lives
inside `/staff/orders/[id]`, which reads `orders` through RLS from the client and
cannot load locally against a placeholder key. Its behaviour is asserted by tests
instead. Nor were any of these pages driven against real production data — that
needs a real staff session, and the grants, RLS and constraints were checked
against the database directly.

One thing worth recording about the harness itself: a controlled input in this
browser pane does **not** accept a synthetic `input` event, even with the native
value-setter trick. The typed value lands in the DOM and React never sees it, so
the page looked broken when it was not. Real keystrokes work. The earlier
"search does nothing" reading was the harness, not the page.

## Attachments — deferred, deliberately

The only private bucket is `order-assets`, whose policy is
`storage.foldername(name)[1] = auth.uid()`. That works for a signed-in customer
and not at all for a guest, and there is no signed-URL path for
conversation-scoped access. Building one is a storage-policy pass, not a support
pass. Deferred rather than shipped insecurely, which is what the brief asked for.

## Numbers

| | |
|---|---|
| Tests | 1794 -> **1879**, all green |
| Lint | 277 -> **277**, unchanged |
| Migrations | 52 -> **54** repo files == 54 production rows |
| Support rows created in production | **0** |

### The same ledger-drift note as pass 21

Parity holds, but the two new rows carry the timestamps the apply tool assigned —
`20260810205348` and the lockdown's — while their names are
`20260810100000_support_conversations` and
`20260810110000_support_truncate_lockdown`. Identified by name, not by a version
matching the filename prefix.

## Known gaps

* **A guest cannot read their conversation.** They get a reference and an emailed
  reply, and that email carries the full text because it is their only channel.
  The guest-order cookie authorises *an order*, and most support conversations
  have none — so there is nothing to check. Inbound email threading would be a
  second system.
* **No attachments.** See above.
* **The order workspace panel is test-verified only.** See above.
* **`user_staff_notes` can still be truncated.** See above.
* **Reading the inbox is not audited**, by design — a log that records its own
  inspection grows faster from being looked at than from anything happening.

## Merged and in production — 2026-08-10

`a59b777..6b736e2`. Confirmed to contain this work the way pass 21 established:
Vercel exposes no git SHA, so the build log names the artifacts instead — all
fourteen, including `app/api/staff/support/[id]/notes/route.js` and
`app/api/support/conversations/[id]/messages/route.js`, which exist only in this
commit.

### Smoke test, no production mutation

| Probe | Result |
|---|---|
| `GET /support` | 200, renders the form |
| `GET /contact` | 307 -> `https://keymoura.com/support` |
| `GET /api/support/conversations` (no session) | 401 |
| `GET /api/support/conversations/<uuid>` (no session) | 401 |
| `GET /api/staff/support` (no session) | 307 at the middleware |
| `GET /api/staff/support/assignees` (no session) | 307 |
| `GET /staff/support` (no session) | 307 |
| `POST /api/support` no message / short message | 400, the real wording |
| `POST /api/support` guest with no or malformed email | 400 |
| `POST /api/support` honeypot filled | 200 `{ok:true, reference:null}`, **nothing written** |
| `POST /api/support` seventh call within the hour | 429, "try again in about 60 minutes" |

Six write probes, zero rows. The rate limiter is live and stopped the seventh —
worth noting because a module-scope counter would have been per-instance and
would not have.

### The first real conversation was not ours

`SUP-0001` was submitted through the live form by a person a few minutes after
the deploy — subject "test", a disposable address, a twenty-character message.
It is left alone: it is somebody's genuine submission, and the table has no
`DELETE` grant to anyone by design, which is the append-only guarantee doing its
job rather than an obstacle.

It is also the end-to-end proof no fixture could give:

* the trigger assigned `SUP-0001` and the sequence advanced to 1
* the opening message stored as a `support_messages` row, `message_count` 1,
  `note_count` 0
* `staff_support_queue` computing `status_rank` 0, `priority_rank` 2,
  `is_unresolved` true, `is_guest` true
* both emails `sent` through the one sender — the acknowledgement to the
  requester and the staff alert to the configured address
* one audit row, `support.created`, `actor_kind` **customer** rather than
  "System", `entity_label` `SUP-0001`, metadata
  `{category, guest, order_linked, message_length: 20}` — a **length**, and the
  body nowhere in it. The message is twenty characters long.

### Migration parity after deploy

54 repo files == 54 production rows.

### Final SHA

`6b736e2`

---

# Pass 23 — Scheduled communications, reminders and operational follow-up

Starting SHA `8a7fbed`. The pass that made the shop notice things on its own.

## The scheduler that was already there

Three source files said *"there is no cron service in this project"* and built
around it — opportunistic reservation sweeps, an email catalogue with four events
marked `wired: false` because each needed "a scheduled job runner, which this
project does not have". That was **wrong**, and had been for a fortnight.

`pg_cron` 1.6.4 is installed in production and has been running
`purge-expired-moderation-recycle-bin` at `17 3 * * *` since migration
`20260729000000`. `pgmq` 1.5.1 is installed with zero queues. `pg_net` is
available and not installed, which is why pg_cron could not have done this job:
it can run SQL and cannot call Resend.

That same migration's own comment specified this pass a fortnight early —
*"Projects without it can call the function daily from a protected Vercel cron
route in a later migration."* The recycle-bin job is left exactly as it is. It is
a single-purpose retention purge, not a general scheduler, and absorbing it would
have been a second system pretending to be a simplification.

## One job table, one worker, one schedule

Cron wakes the worker; **the database decides what needs doing**. `scheduled_jobs`
carries a unique `dedupe_key`, and that uniqueness is the entire point of the
column: a discovery pass running every fifteen minutes writes
`pickup_reminder:<order>:day3` once.

Three layers stand between a worker that never sleeps and a customer's inbox:

1. **`dedupe_key` is unique** — the reminder is queued once however many times
   discovery notices the same stale row.
2. **The handler reloads the entity** and re-asks whether the reminder is still
   true, at the moment it would fire. A quote paid between scheduling and firing
   sends nothing and cancels the job.
3. **`email_deliveries.event_key` claims the send** — the guarantee that already
   existed. Two workers racing past both of the above still produce one email.

Keys carry the *occurrence*, never the clock: `day3`, `n2`, or the expiry
timestamp the job was scheduled against. That last one is deliberate — moving a
quote's deadline mints a genuinely new reminder rather than reusing one already
sent, and the handler refuses a job whose stored expiry no longer matches.

## Ten reminders, and what each is for

| Job | Who | Pattern |
|---|---|---|
| `quote_expiry_warning` | customer | explicit `run_at`, discovered by scan |
| `quote_expired` | customer | explicit |
| `order_action_required` | customer | discovery, capped at two |
| `pickup_reminder` | customer | discovery, configured days |
| `pickup_stale_staff` | staff bell | discovery |
| `support_waiting_customer` | customer | discovery, one only |
| `support_waiting_staff` | staff bell | discovery |
| `production_due_soon` / `overdue` / `blocked` | staff bell | discovery |

**Every staff reminder is a bell, never an email.** `staff_fulfillment_due` stays
`wired: false` and is now so by choice rather than for want of a scheduler: an
alert about an internal delay does not need to arrive at 3am, and the people who
can act on it read the bell all day.

**No customer is told production is late.** That is a decision somebody makes,
not one a timer makes for them, and the brief was explicit it needs a
customer-facing policy this project does not have.

Shipping is never chased. A parcel in transit has a carrier telling the customer
about it already.

## Discovery, and the one thing it is not

Two reminders hang off a deterministic future instant, and their `run_at`
genuinely is explicit — the job is written for `expiry - 24h`. What is a *scan*
is the noticing, deliberately: a hook on the quote-setting route would miss every
quote that already exists and leave nothing to repair the gap. The scan is
self-healing.

The rest are state-based. "Waiting on staff for eight hours" is a `where` clause,
not an event; writing a speculative row per conversation per threshold would be
millions of rows to express it.

## Invalidation, and the file that was not edited

Phase 23 asks for stale jobs to be cancelled on state change *and* revalidated at
execution. The second is done and is the guarantee. The first is a **bounded
reconciliation sweep** rather than six hooks — and one of those six would have
been inside the Stripe payment webhook.

That trade is worth stating plainly: the benefit of a hook is that a doomed job
dies now rather than within one cadence, and since the handler refuses it either
way, what that buys is a tidier table. It is not worth a new failure mode in the
file where a customer's order confirmation lives. The sweep may only ever
anticipate a refusal, never cause one.

## Cadence

Every fifteen minutes — 96 a day, ~2,880 a month. The finest threshold in the
system is hours, so precision is not what sets the cadence; how late a quote
warning may fire is. Hourly would make the one reminder whose whole point is
arriving before a deadline up to an hour late.

One schedule, not ten. Ten cron entries would be ten things to configure and ten
places to look when a reminder does not arrive; one worker reads the job table
and does whatever is due, which is why the job table exists.

## Numbers

| | |
|---|---|
| Tests | 1879 -> **1953**, all green |
| Lint | 277 -> **277**, unchanged (`npx eslint src`) |
| Migrations | 54 -> **55** repo files == 55 production rows |
| Email templates | 48 -> **52** production rows == 52 catalogue keys |
| Reminders sent to real customers | **0** |

### The baseline was not what the ledger said

Pass 22 recorded 1879 "all green". On this Windows checkout one test failed:
`tests/support-system.test.ts:918` asserted `ROLLBACK_SQL.includes` against a
two-line statement carrying a bare `\n`, in a file with CRLF endings — so the
match returned -1 and reported a correctly-ordered rollback as wrong. Fixed by
normalising line endings before matching. The rollback file was always right; the
assertion was reading the line endings.

The transactional-email matrix also carried "52 events across 44 templates". Both
numbers were wrong — measured from the module, it was 56 and 48 before this pass,
59 and 52 after. The generated-from-the-module arrangement exists to stop exactly
that drift, and the test asserts every event *appears* in the doc but has never
checked the totals sentence.

## An error worth recording

The dry-run was meant to end in `rollback`. The script sent ended in `commit`, so
the two tables and the function were briefly created in production and two probe
rows written, before approval. It was reverted immediately with the rollback file
and production returned to exactly its prior state; migration parity never broke,
because `execute_sql` writes no migration row.

The rollback file is therefore proven against a real applied schema rather than
only read, which is not a defence of the mistake but is the one useful thing that
came out of it.

## Verified in a browser, and what was not

The local service-role key is a placeholder, so a temporary harness served
fixtures to the **real** page at its real URL and was deleted before commit —
`git status` carries no residue of it.

Driven and confirmed: all six tabs and hash routing; the Status tab's health chip,
nine facts, failures panel and run history; per-state button affordances on the
jobs list (pending -> Cancel only, cancelled -> none, failed -> Retry + Cancel
with critical severity styling); toggling pickup reminders off disabling exactly
its three day-fields and not the staff one; a real keystroke changing the support
threshold 8 -> 4 and reaching React; Retry and Run now firing and reloading;
375px with no page-level horizontal overflow and the tab strip scrolling in its
own `overflow-x: auto` container; 768px reflowing the facts grid to three columns.

**The load-bearing one.** Re-seeded as `automation.view` only: the warning notice
appears, Save is disabled, **Run now is gone entirely**, every input is disabled,
and the jobs list renders five rows with *no action buttons at all*.

**Not verified in a browser:** the refusal paths on the manual controls. The
harness stub short-circuits before validation, so `action: "send_now"` and a
non-UUID id both returned 200 through it. Both are asserted by tests instead
(400 on an unknown action, 400 on a bad id, 409 on a stale state). Nor was any
page driven against real production data — that needs a real staff session, and
the grants, RLS and constraints were checked against the database directly.

## Schema

Additive: two tables, one function, six indexes, four template seeds with
`on conflict do nothing`. No existing table, column, policy, trigger or row was
altered.

Neither table is reachable from a browser session: `revoke all` from `public`,
`anon` and `authenticated`, RLS enabled with **no policies**, and service-role
only. TRUNCATE was revoked **in the same migration** this time rather than in a
follow-up — the hole pass 22 had to come back for.

Eleven behavioural probes passed in a rolled-back transaction before approval and
were re-verified in production after applying: dedupe uniqueness refuses a
duplicate, the state check refuses garbage, a claim takes due and expired-lease
rows while skipping future ones, a second worker holding no lease claims nothing,
attempts increment, browser roles hold zero privileges, service_role holds no
TRUNCATE, RLS is on with no policies, and all six indexes exist.

## Known gaps

* **The refusal paths are test-verified only.** See above.
* **No hook inside the payment webhook.** Deliberate; see Invalidation.
* **`user_staff_notes` can still be truncated** — pass 21's hole, still recorded
  rather than fixed, still one `revoke` when somebody wants it.
* **The deployment schedule cannot be read by the code that depends on it.**
  `tests/scheduled-automation.test.ts` pins `vercel.json` to the cadence
  constants, which closes the repo-side gap; if the Vercel dashboard is edited by
  hand the health page reports the scheduler stalled, which is the true statement.

## Merged and deployed — 2026-08-11

`8a7fbed..211d14d`. Confirmed to contain this work the way passes 21 and 22
established: Vercel exposes no git SHA, so the build log names the artifacts
instead — all five, including `app/api/cron/automation/route.js` and
`app/staff/settings/automation/page.js`, which exist only in these commits.

### Vercel is a Hobby account, and the first deploy was refused

The pass shipped a `vercel.json` at `*/15 * * * *`. The deploy failed outright:

> Hobby accounts are limited to daily cron jobs. This cron expression
> (`*/15 * * * *`) would run more than once per day.

The team scope had been read as implying Pro. It does not — Vercel allows Hobby
teams. Nothing deployed, and production stayed on pass 22's build until the
schedule was moved into Postgres and `vercel.json` deleted.

Worth recording for the next pass: **this project has no Git integration.**
Pushing to GitHub deploys nothing; production comes from `vercel deploy --prod`
run by hand. Ten minutes were spent waiting for an automatic build that was never
going to start.

### Why the schedule ended up in the database

Daily was not a workable fallback. The quote-expiry warning is configured for 24
hours ahead, so a once-a-day sweep could deliver it up to 24 hours late — at or
after the quote had already lapsed, which is the exact failure it exists to
prevent. It is also one of the two reminders that cannot be switched off, because
it keeps an active purchase moving.

`pg_cron` was already installed and already running the nightly recycle-bin
purge, so the schedule moved there and `pg_net` makes the one call SQL cannot.
The result is better than the original design rather than a concession: the
schedule now lives in the same database as the job table it drives, and there is
no platform cron limit to design around.

### Smoke test, no production mutation

| Probe | Result |
|---|---|
| `GET /api/cron/automation` no auth | 401 |
| `GET /api/cron/automation` wrong bearer | 401 |
| `GET /api/cron/automation` empty bearer | 401 |
| `POST` / `PUT` / `DELETE` on the cron route | 405 each |
| `GET /api/staff/automation` (no session) | 307 at the middleware |
| `POST /api/staff/automation` (no session) | 307 |
| `POST /api/staff/automation/run` (no session) | 307 |
| `POST /api/staff/automation/jobs/<uuid>` (no session) | 307 |
| `GET /staff/settings/automation` (no session) | 307 |
| `GET /` and `GET /support` | 200, unchanged |

The three 401s are the fail-closed path proving itself: `CRON_SECRET` is not set,
so the route refuses everything including a correct caller. That is the intended
behaviour and not a temporary state to be worked around.

### Role-switched probes, in the database

Five, all refused with `42501`:

| Role | Object | Result |
|---|---|---|
| `anon` | `scheduled_jobs` | refused |
| `anon` | `automation_runs` | refused |
| `anon` | `claim_scheduled_jobs()` | refused |
| `authenticated` | `scheduled_jobs` | refused |
| `authenticated` | `automation_runs` | refused |

### Production state after deploy

| | |
|---|---|
| Migration parity | 55 repo files == 55 production rows |
| `scheduled_jobs` rows | 0 |
| `automation_runs` rows | 0 |
| Reminder emails sent | 0 |
| `automation.*` audit rows | 0 |
| cron jobs | 1 — the recycle-bin purge, untouched |

### Still dormant, deliberately

Two secrets are outstanding and neither is Claude's to create: `CRON_SECRET` in
the Vercel Production environment, and a Vault secret named
`automation_cron_secret` holding the same value. Until both exist the endpoint
refuses every caller and the trigger returns without making a request.

`20260811020000_automation_scheduler` is written, dry-run with eight passing
probes and rolled back — including that no HTTP request is queued while the
secret is absent, and that the nightly recycle-bin job is untouched. It is **not
applied**, and should not be until both secrets exist, or the scheduler will call
an endpoint that can only refuse it.

Staff can already exercise the whole system through **Run now** on
`/staff/settings/automation` under `automation.manage`, which runs the same
worker with the same discovery, revalidation and delivery claims.

### Final SHA

`211d14d`

### The scheduler applied — 2026-08-11

`20260811020000_automation_scheduler` was applied after the deploy, restoring
parity to **56 repo files == 56 production rows**. It was committed before it was
applied, which broke parity for one commit — recorded here rather than quietly
fixed, because parity has been a clean invariant for twenty-three passes and the
next person should see that it moved.

Applying it early is safe for a specific, verified reason rather than a hopeful
one: with no Vault secret, `trigger_automation_worker()` returns before it builds
a request.

| Check | Result |
|---|---|
| Migration parity | 56 == 56 |
| `pg_net` installed | yes |
| `cron.job` entries | `automation-worker :: */15 * * * *` and `purge-expired-moderation-recycle-bin :: 17 3 * * *`, both active |
| `trigger_automation_worker()` | `security definer`, zero execute grants to `anon`/`authenticated`/`PUBLIC` |
| Vault secret present | **no** — the dormant state |

And then the load-bearing observation, from the first real tick:

| | |
|---|---|
| `cron.job_run_details` at 11:45:00 UTC | runid 13, **succeeded** |
| `net.http_request_queue` | **0** |
| `net._http_response` | **0** |
| `automation_runs` | **0** |

The schedule is live, firing on time, and correctly doing nothing. The moment a
Vault secret named `automation_cron_secret` exists — and `CRON_SECRET` is set to
the same value in Vercel — automation starts on its own, with no further deploy
and no further migration.

---

# Pass 24 â€” user management, made a workspace people can read

Branch `staff-people-workspace-20260811`, from `f81ad7c`.

## Verified starting state â€” 2026-08-11

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| Local `main` == `origin/main` | **`f81ad7cca8b792f9dd1a9ac3521233360decf6da`** |
| Migration parity | **56 repo files == 56 production rows** |
| Typecheck | clean |
| Tests | 1955 pass, 0 fail |
| Lint (`npx eslint src`) | 277 problems (128 errors, 149 warnings) |

**No schema in this pass.** Every capability the redesign needed already existed
in `staff_user_directory`, `role_permissions`, `user_permissions`, `user_bans`,
`user_restrictions`, `user_staff_notes` and `support_conversations`. Parity is
still 56 == 56.

## The audit came first, and it was measured

Full findings in `docs/USER_MANAGEMENT_UX_AUDIT.md`. The numbers below were read
off the running pages through a temporary local harness that mounted the **real**
components inside the real `StaffShell` with fixtures served through a
`window.fetch` interceptor. The harness was deleted before the commit and no file
in the diff references it.

| Surface | Before | After |
|---|---|---|
| Access tab height | **6,367px** at a 900px viewport | **1,640px** for an admin |
| Permission controls | **115 checkboxes**, one flat column, raw keys | **12 named groups**, collapsed, human labels |
| Directory filter bar | 8 controls always, 12 when expanded; 78px / **147px at 375** | 4 controls + a 4-segment control; **46px** |
| Directory row | 110px at 1280, **150px at 375** | **53px** / 100px |
| Detail tabs | 7; **681px of strip in a 342px box at 375** | 6; wraps, all reachable |
| Overview | facts + metrics + a **live profile editor** | a summary; editing behind a disclosure |

## The Access tab

It could not answer the question it exists for. 115 keys like
`catalog.categories.manage`, with nothing saying which of them the person's role
already granted â€” so every tick looked like the only thing standing between the
person and the power.

Now `src/lib/staff/permissionGroups.ts` decides three things purely, and a test
asserts the partition is **total and disjoint** so a permission added next year
cannot land nowhere and vanish from the screen:

1. Which of twelve groups a permission belongs to (longest-prefix rules, not the
   `PERMISSION_META` category â€” that one files `production.manage`,
   `refunds.issue` and `emails.resend` together under "Commerce").
2. Where a permission comes from for one person: **from the role**, **added for
   this person**, or **not granted** â€” a tick, a plus, a circle, each with the
   source spelled out in words beside it, because a matrix whose only distinction
   is colour is unreadable to a good share of the people who must use it.
3. What a role change would cost, as area names rather than keys.

**There is no "denied" state, and the screen must not draw one.**
`user_permissions` is additive; this codebase has never had a deny row. So a
permission the role grants gets **no checkbox at all** â€” a control that cannot do
what it looks like it does is worse than no control â€” and the rule is on screen:
"Overrides can only add. Unticking something the role grants does not take it
away â€” change the role instead."

Groups open by default only when they hold an **exception**. Opening every group
the person holds anything in looked helpful and was not: an administrator holds
something in eleven of twelve, which was 4,463px of ticks confirming what the
word "Administrator" already said.

## Role changes now state their cost

Before: a dropdown, a button, and one sentence â€” only when the change crossed the
staff boundary. Administrator to Support said nothing about the catalog, people
and commerce settings about to be lost.

Now a `ConsequentialAction` naming **loses / gains / keeps** as areas. A group
counts as lost only when the person ends up holding *nothing* in it, so losing
one of nine commerce permissions is not announced as losing commerce. Overrides
are on both sides of the diff because they survive a role change, so somebody
keeping an area only through one is not warned they are losing it.

Rank rules, self-edit refusal, the second-admin approval path, the last-admin
protection and `expectedRole` stale-state checking are all unchanged.

## Account status, and a gap the audit found

`POST /api/staff/users/[id]/status` has accepted `durationHours` since the table
was created **and the old UI never sent it** â€” so every restriction applied from
that screen was permanent whether or not anybody meant it to be. The panel now
offers a length, and the request carries it. Verified by capturing the body:

    {"action":"restrict","kind":"site","reason":"...","durationHours":168,"expectedStatus":"active"}

The three backend restriction kinds are **not** collapsed â€” lifting a suspension
does not lift a community restriction, and pretending otherwise would be wrong.
What changed is that each one now states what it withholds *and what survives*,
and each act is a confirmation naming both. `STATUS_ACTION_COPY.suspend.preserved`
is asserted to mention paid orders: a shop that takes somebody's money and then
goes quiet because they were rude in the forum has a second problem.

## Communications became a view, not a tab

Seven tabs put 681px of strip into a 342px box at 375px â€” half unreachable behind
a sideways scroll nothing signalled. Email history is a short list of things that
happened to this account, which is what Activity already is, so it is a segment
inside it. Its permission gate is unchanged and asserted: the segment does not
exist without `emails.view`, the panel behind it still treats a 403 as an error,
and re-sending still goes through the existing audited route behind a
confirmation. Provider ids moved behind **Advanced**.

## A container query, because the rail moves the goalposts

The staff shell puts a 280px rail beside the content from 1024px up, so at a
1024px viewport the list has ~667px. A viewport breakpoint switched five columns
on there and produced a 75px row of wrapped words. `.staff-people` is now a
container and the row asks its own box how wide it is â€” the only question that
was ever relevant. Measured: columns at a 940px list, stacked at 669px, no
horizontal overflow at 375 / 768 / 1024 / 1280 / 1440.

## Legacy, moved rather than removed

Verification, donation rank and bio are community-era attributes on a machine
shop's customer record. All three keep their routes, their permissions and their
behaviour, and all three moved into **Advanced profile** â€” asserted by a test
that also checks display name, username and email did *not* move with them. The
raw account uuid went there too; it used to be the first row of Overview.

**Avatar replacement is now offered**, through the `.../avatar` route that has
existed since pass 11 and that no UI had ever called. No second storage path.

## Verified in a browser

Directory: segments set the URL and read back (`?kind=staff`, `?status=limited`),
`limited` returns restricted **and** suspended, each active filter chip removes
only itself and leaves the rest, search/sort/paging still server-side.

Workspace: six tabs with a roving tabindex and exactly one tab stop; header "Add
note" lands on Notes **and focuses the composer**; "Manage access" lands on
Access; the metric strip renders a support count the viewer may not read as a
dash rather than `0`. A 500 on notes and a 403 on communications both render
`role="alert"`, never an empty list.

## Not verified

- **The running Vercel preview**, as in every previous pass: previews are
  SSO-gated. The identical production build was run clean locally from a cleared
  `.next`.
- **A real signed-in staff session.** Middleware 307s `/staff/*` before any HTML,
  so every figure above came from fixtures. No production row was read or written.

## Validation

| Check | Before | After |
|---|---|---|
| Typecheck | clean | clean |
| Tests | 1955 pass | **2006 pass**, 0 fail |
| Lint (`npx eslint src`) | 277 (128 errors, 149 warnings) | **277 (128 errors, 149 warnings)** |
| Production build | clean | clean, exit 0, from a cleared `.next` |
| Migration parity | 56 == 56 | 56 == 56 |

