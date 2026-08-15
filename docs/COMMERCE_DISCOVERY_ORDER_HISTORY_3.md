# Commerce Discovery & Order History 3.0

Customer-facing commerce UX, from finding a product to reading what happened to
an order. Started from `b49e8d3` (Visual System & Appearance 3.0). **No schema
changes.**

## What was wrong

Both surfaces described what the database held rather than what a shopper was
doing.

**`/catalog`** filtered correctly and looked like a report. Search was a bare
`.ui-input` — the same control staff tables filter with — sharing one grid row
with sort, the density control and two drawer triggers, so the storefront's
primary act was one of five equal boxes. The result count was muted metadata
floating under the toolbar and never said *what* was searched for; an empty
result said "No products match those filters" without naming the term most
likely to be the typo. Grid density offered 2/3/4 and nothing else, so a
customer wanting to read about a product before opening it had no denser-text
option at all.

**`/orders`** was worse, and quietly. Three defects, none visible as a crash:

1. `orderCustomerStatus(order.status, null)` — the fulfillment status was
   hard-coded `null`, so **a shipped order never said "Shipped"**. It said
   "Ready for fulfillment". `/account` passed the real value, so the account
   overview was *more* accurate than the order list.
2. `orderNeedsCustomerAction(order)` was called without `amount_paid_cents` or
   `amount_refunded_cents`, so `balanceRemains` fell through its
   `amount_paid_cents == null` branch and **a part-paid order over-reported
   needing attention**.
3. Each order was one `<Link>` wrapping the whole card, which is a structure
   that can only ever offer "open me" — no tracking, no payment, no help.

Plus: no product image, no line items (a two-product order showed only the
order's own `product_name`), no order search, and six sort modes whose default
was `updated_at`.

## Catalog

### Search

`CommerceSearch` — a `role="search"` form with a visible label target, an icon,
a real submit button and a clear button that appears only when there is
something to clear. Taller and wider than `.ui-input` on purpose. The browser's
own unlabelled cancel cross is suppressed because it lands exactly where the
labelled one goes.

Enter and the button commit through `router.push`: the 350ms debounce exists so
a keystroke does not cost an RSC round trip, and a deliberate submit is not a
keystroke. `push` rather than `replace` because a searched-for term is somewhere
Back should return from — which is exactly the history entry the debounced path
is careful *not* to create. `?q=` is unchanged and still canonical.

The drawer's second search box is gone. Two controls writing one query
parameter is one too many, and the one behind a button looked authoritative.

### Result context

`12 results for “shift knob”`, with scope (`in Interior`) and
`filtered from 4` on a second line, in an `aria-live` region. The search term
gets its own removable chip, and removing it does **not** discard the category
the customer navigated to on the way there — `clearSearch` is narrow where
`clear` is total. Active filters gained a dashed `Clear all` beside them.

Empty results name the term and offer **Clear search**.

### List view

`List | 2 | 3 | 4`, default still 3. **`list` is a layout, not a fourth column
count** — one-across was never the missing option. The row is three real
regions: a 15rem image, a description clamped to four lines instead of two, and
price plus the contextual CTA in a purchase column of their own.

It is the **same card DOM**, re-laid-out by `[data-catalog-density="list"]`.
That is what lets the existing pre-paint script decide it: a second component
chosen from `localStorage` could not be chosen until hydration, so every visit
would have opened on cards and jumped to rows. `ProductCard`'s footer moved out
of its body to make the third column possible without `display: contents` or a
subgrid.

Below 640 the row collapses to a stacked card deliberately — 375px has no room
for an image column and a text column that are both usable. Below `lg`, where a
column count is meaningless, the control becomes a `List | Grid` switch; `Grid`
is not a fifth stored value and does not rewrite a density chosen on a wider
screen. Arrow keys walk the options that are actually on screen, read from
`offsetParent`, rather than the static list — half the group is hidden at any
width.

The list rules are all scoped under `.catalog-grid`. The attribute lives on
`<html>` and survives a client-side navigation off the catalog, so an unscoped
rule would turn the homepage's featured products into list rows on the way past.

### Other

- `src/app/catalog/error.tsx`. `loadCatalogData` already threw rather than
  serving an empty shop, which was right; there was nowhere for the throw to
  land except `global-error.tsx`, which replaces the whole document.
- `priceLabel` now formats through `moneyFromCents`. A £1,299 part read
  `$1299.00` on its card and `$1,299.00` on the order confirming it.

## Order history

`OrderHistoryCard` + a pure `orderHistory.ts` holding every decision.

**Header strip** — placed, total, `Ship to` (recipient's first name) or
`Pickup` (location name), order number. No street address: a history page is
read in public and the full address is one click away where it is needed. The
UUID stays in the `href`.

**Status** — the shared customer projection, in plain language, with one of
four tones. Four rather than one per state: a colour per status is a legend
nobody reads, and the useful distinction is only ever *moving / wants me /
finished / stopped*. The tone is a dot; the label is a word beside it.
Cancellation and return work outranks the ordinary flow. Fulfillment outranks
the commercial status both ways — an order that is `completed` *and* `delivered`
says "Delivered", and one still marked `awaiting_payment` that has shipped says
"Shipped" rather than asking for money over the top of a parcel in transit.

**Items grouped inside one card** — three shown, then "N more items in this
order". Both order shapes render: `order_items` when there are any, the order's
own `product_name` otherwise, because custom requests predate the line-item
table and are not being migrated. Names, options and prices are the
purchase-time snapshot. The thumbnail is the *current* listing and is therefore
`alt=""` — an alt naming the product would assert this is a photograph of the
thing that shipped, and nothing knows that.

**Actions**, at most one primary:

| Condition | Action |
|---|---|
| `needs_information` / `customer_review` / `final_review` | Send details / Review quote / Approve order |
| balance remains | Pay now |
| `tracking_url` present | Track package (new tab, `noopener`) |
| pickup and ready | Pickup details → `#fulfillment` |
| always | View order |
| finished, single line, has slug | Buy it again |
| delivered, completed, or stopped | Get help → `/support?order=…` |

## Decisions worth recording

**Returns are never offered from a card.** Eligibility is `evaluateReturn`
against fresh rows behind an API. Inferring it from a date and a status is the
one thing pass 8 established must not happen, so the card links to the page that
computes it. `orderHistory.ts` cannot reach the evaluator at all.

**Buy it again opens the product; it does not re-add the configuration.** The
cart stores product ids and option selections and prices them live, which is
safe against everything that fails loudly — a withdrawn value, an out-of-stock
product, one that now needs a quote. It is *not* safe against the silent case:
an option **group** removed since the purchase is simply not in the current
groups, so the stored selection for it is dropped without complaint and the
customer is sold a similar object missing the thing that distinguished theirs.
Detecting that means a query and a comparison per distinct product, to save one
click on a page they were going to open anyway. Offered only on a finished
single-line order — "buy it again" on a four-item order does not say which.

**Track package requires a stored `tracking_url`.** A carrier name and a number
are not a link, and guessing a carrier's URL format lands a customer on somebody
else's 404 blaming us.

**`updated_at` is not read at all.** It was the default sort, and it is not a
property of the order as far as the customer is concerned: a staff note
reshuffled the list under somebody who had done nothing, and the new position no
longer agreed with the only date on the card. Sorting is by the date that is
printed.

**Six sorts became two** (`Newest first`, `Oldest first`) per the brief's "keep
it simple". That drops `Needs attention first`, which was genuinely useful.
Attention is now carried by the amber tone, the lit border and the primary
action instead — adequate at 25 cards, and the one capability deliberately not
carried across. Worth revisiting if order volume grows.

**Default tab is `All`, not `Active`.** The old page opened filtered. This is an
order *history* page, the tabs carry counts, and newest-first already puts live
orders at the top.

## Security and performance

- Ownership is `.eq("customer_id", user.id)` **and** RLS. The filter is a
  convenience; the policy is the control. Knowing a UUID is not access, a
  matching email is not ownership, guest orders stay on their own signed route.
- No staff or production data is in the select list at all — a better guarantee
  than remembering not to render it. Tested against the column list rather than
  the file, because the file's own prose explains why they are absent.
- Two queries, never N+1: line items nested with the orders, thumbnails one
  `in (…)` over distinct product ids.
- Bounded at 25 via `PAGE_SIZE + 1`, so "there are more" is known without a
  count query.
- A failed read is an error state. "You have no orders" is a sentence a customer
  will believe, and believing it after an outage is how somebody concludes their
  purchase never went through.

## Elsewhere

- **Account menu**: `Requests` pointed at `/orders?view=requests` — a parameter
  no page has ever read, so it was a second entry that opened the first one's
  page while promising a filter. Replaced with **Support**, the only `/account`
  shortcut with no way in from the header.
- **`/dev/visual`** gained six order fixtures: shipped, in production, ready for
  pickup, multi-item, unpaid, refunded, and a legacy order with no
  `order_items`. Those states previously required owning an order in each of
  them to look at.

## Verification

| Check | Result |
|---|---|
| Tests | 2152 pass, 6 fail — the same 6 that fail on `b49e8d3`. +61 net-new. |
| `npx eslint src` | 277 problems (128 errors, 149 warnings) on base **and** branch |
| `tsc --noEmit` | clean |
| `next build` | clean, 185 static pages |
| `git diff --check` | clean |
| Migrations | zero; the two pending security migrations untouched |

Browser-verified against the fixture harness at 375 / 640 / 900 / 1100 / 1280 /
1440. No page overflow at any width. List mode confirmed three-column at ≥1024,
two-column at 640–1023, stacked below 640. Search → URL → count → chip →
empty-state → clear verified end to end. Screenshots were unavailable in this
session (the pane does not composite), so verification is by measurement rather
than by eye.

## Known gaps

- Autocomplete was **deferred**, explicitly. The current search filters a list
  already in memory and answers instantly; suggestions would need either a
  server endpoint or a client index, and neither is justified by a catalog this
  size. Revisit past a few hundred products, when `loadCatalogData`'s own
  comment says the grid moves to a paginated server query anyway.
- Order paging is designed for but not built — `PAGE_SIZE + 1` and a truthful
  "showing your 25 most recent" line, no button yet.
- Return and cancellation remain on the order detail page only.
- `Needs attention first` sorting, as above.
