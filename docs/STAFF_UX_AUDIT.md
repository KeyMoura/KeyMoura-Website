# Staff UX audit — 2026-08-08

Taken on branch `staff-ux-appearance-overhaul-20260808`, from `f9dded6` (production).
Written **before** any code changed, so the findings below describe the shipped
product rather than the repair.

## Verified starting state

| Check | Result |
|---|---|
| Repository | `KeyMoura/KeyMoura-Website` |
| Working tree | clean |
| `origin/main` = local `main` | both `f9dded6` |
| Expected production baseline | `f9dded6` — matches |
| Migration ledger | 47 repo files, 47 rows |

---

## 1. Every `/staff` route that exists

31 pages. Grouped by whether the navigation admits they exist.

### In the sidebar (23)

| Route | Sidebar label | Group |
|---|---|---|
| `/staff` | Dashboard | Today |
| `/staff/orders` | Orders | Today |
| `/staff/production` | Production | Today |
| `/staff/fulfillment` | Fulfillment | Today |
| `/staff/catalog` | Products | Catalog |
| `/staff/catalog/categories` | Categories | Catalog |
| `/staff/inventory` | Inventory | Catalog |
| `/staff/catalog/discounts` | Discounts | Catalog |
| `/staff/security/users` | Customers | Customers |
| `/staff/moderation/reports` | Reports | Customers |
| `/staff/emails` | Emails | Operations |
| `/staff/info/analytics` | Analytics | Operations |
| `/staff/reconciliation` | Reconciliation | Operations |
| `/staff/integrations` | Integration health | Operations |
| `/staff/launch-readiness` | Launch readiness | Operations |
| `/staff/security/audit` | Audit log | Operations |
| `/staff/info/todo` | To-do board | Site content |
| `/staff/info/pending` | Pending submissions | Site content |
| `/staff/info/updates` | Content updates | Site content |
| `/staff/shops` | Shops | Site content |
| `/staff/settings` | Settings overview | Settings |
| `/staff/settings/commerce` | Commerce | Settings |
| `/staff/appearance` | Appearance | Settings |
| `/staff/security/roles` | Roles & permissions | Settings |
| `/staff/security` | Security controls | Settings |
| `/staff/security/verified-perks` | Verified perks | Settings |
| `/staff/security/recycle-bin` | Recycle bin | Settings |

### Reachable but unlisted (8)

| Route | Why it is not in the menu | Verdict |
|---|---|---|
| `/staff/orders/[id]` | Record detail, reached from the list | Correct |
| `/staff/orders/[id]/print/[doc]` | Printable document | Correct |
| `/staff/orders/new` | Reached from the Orders page action | Correct |
| `/staff/production/[id]`, `/staff/production/new`, `/staff/production/[id]/print` | Same | Correct |
| `/staff/inventory/[productId]` | Same | Correct |
| `/staff/info/pending/[id]`, `/staff/info/updates/[id]` | Same | Correct |
| `/staff/launch-readiness/discrepancies` | Sub-report, linked from its parent | Correct |
| `/staff/emails/deliveries` | Sub-report, linked from its parent | Correct |
| `/staff/moderation` | Superseded by `/staff/moderation/reports`, which `alsoOwns` it | Correct |
| `/staff/community` | Community is dormant (pass 14) | Correct — deliberate |

**No dead menu entries, and no orphan routes.** Pass 14's rule that nothing is
listed unless it resolves is holding. This audit found nothing to add or remove
from the *set* of destinations. The problems are in grouping, naming, page
structure and the Appearance page — not in coverage.

---

## 2. Information architecture — what is wrong with it

The current six groups are **Today, Catalog, Customers, Operations, Site
content, Settings**.

| Finding | Evidence | Cost |
|---|---|---|
| **Dashboard is buried inside a workload group** | "Today" holds Dashboard, Orders, Production, Fulfillment | The one page that answers "what is going on" is a peer of three queues, so it reads as a fourth queue |
| **Inventory is filed under merchandising** | "Catalog" holds Products, Categories, Inventory, Discounts | Fixing stock is operational work done beside Production and Fulfillment, not beside writing product copy. A staff member fixing a count crosses the whole menu |
| **"Catalog" is a codebase word** | Group label | The storefront calls it the Store. Products/Categories/Discounts are the store's contents |
| **"Operations" mixes two unlike things** | Emails and Analytics (routine) sit with Reconciliation, Integration health, Launch readiness (exception-handling) | The group has no single answer to "when do I come here?" |
| **"Settings overview" names a document, not a destination** | Settings group, first item | It is the settings *home*; "overview" is what a page is, not what it does |
| **The settings index is a flat grid of seven cards** | `/staff/settings` | No subgrouping, so "Recycle bin" has the same visual weight as "Commerce" |

### Old vs new

| Before (6 groups, 27 items) | After |
|---|---|
| **Today**: Dashboard, Orders, Production, Fulfillment | **Dashboard**: Dashboard |
| **Catalog**: Products, Categories, Inventory, Discounts | **Orders**: Orders |
| **Customers**: Customers, Reports | **Operations**: Production, Fulfillment, Inventory |
| **Operations**: Emails, Analytics, Reconciliation, Integration health, Launch readiness, Audit log | **Store**: Products, Categories, Discounts |
| **Site content**: To-do board, Pending submissions, Content updates, Shops | **Customers**: Customers, Reports |
| **Settings**: 7 items | **Business**: Emails, Analytics, Reconciliation, Integration health, Launch readiness, Audit log |
| | **Site content**: To-do board, Pending submissions, Content updates, Shops |
| | **Settings**: 7 items |

Same 27 destinations, no route added, no route removed. Three moves:
Dashboard out on its own, Orders out on its own, Inventory from Store to
Operations. Two renames: Catalog → Store, Operations → Business.

**"Custom Requests" was requested as a second entry under Orders and is
deliberately not added.** There is no such route. Custom requests are orders
carrying `is_custom`, shown by a filter on `/staff/orders`; a menu entry would
either 404 or duplicate the Orders page under a second name. This is the one
item from the requested structure that does not survive the "only real routes"
rule.

---

## 3. Naming map

| Before | After | Why |
|---|---|---|
| `Catalog` (group) | `Store` | Matches what the storefront is called |
| `Operations` (group) | `Business` | The group is reporting and health, not daily operations |
| `Today` (group) | split into `Dashboard` + `Orders` + `Operations` | "Today" described when you look, not what is in it |
| `Settings overview` | `All settings` | Names the destination |
| `Security controls` | `Site access & safety` | "Security controls" collided with "Roles & permissions" as the place to manage access |

Already correct from pass 14 and **left alone**: Orders (was "Order cockpit"),
Commerce (was "Shipping, pickup & policy"), Emails (was "Email &
notifications"), Discounts (was "Discount codes"), Integration health, Launch
readiness, Roles & permissions.

No database column, permission key or route is renamed. This is label work only.

---

## 4. Collapsed sidebar — the defect, precisely

**Collapsing the sidebar hides the text and leaves the sidebar the same width.**

The cause is a single line, and it is not in the component that owns the state:

```css
@media (min-width: 1024px) {
  .staff-shell { grid-template-columns: 280px 1fr; }
}
```

`src/app/globals.css:1807`. The column is a fixed 280px.

Compact mode is state inside `StaffNav`, written to `localStorage` under
`km.staffNav.compact` and expressed as `data-compact="true"` on the `<nav>`
element — which is **two levels below** the grid container:

```
div.staff-shell            ← grid-template-columns: 280px 1fr   (never changes)
  div.hidden.lg:block      ← grid item, fills the 280px column
    nav.staff-nav          ← data-compact lives here
```

Everything the compact rules do (`justify-content: center`, `sr-only` labels,
`padding-inline: 0.5rem`) happens *inside* a box whose width was decided by an
ancestor that cannot see the attribute. So the labels genuinely leave the
layout — `sr-only` is `position: absolute` — and 280px of empty panel remains.

The reported symptom is exactly right, and it is not a fix that belongs in the
link styles. **Setting label opacity to zero was never the problem; the grid
column is.**

| Measurement | Before | Target |
|---|---|---|
| `.staff-shell` column 1, expanded | 280px | 280px |
| `.staff-shell` column 1, collapsed | **280px** | **72px** |
| `.staff-nav` rendered width, collapsed | ~280px | ~72px |
| Main content width gained | **0px** | **+208px** |

Secondary findings in the same area:

- The collapse toggle sits inside `.staff-nav-head`, which keeps a bottom border
  and 0.75rem of padding when compact — a separator under a single centred
  button.
- Group headings become `sr-only` when compact, so the only visual separator
  between groups is a top border. That is right, but the border is drawn with
  `.staff-nav-group + .staff-nav-group`, which at 72px wide has 0.5rem of
  padding either side and reads as a full-bleed rule.
- `title` is the only tooltip. It is keyboard-inaccessible — focus does not
  raise a `title` tooltip in any browser — so a keyboard user tabbing the
  collapsed rail gets no visible label at all.

---

## 5. Role creation — root cause, proven against production

Reported: creating a role returns `Could not create the role.` Pass 14 believed
this was the missing `badge_icon` column and applied
`20260808010000_role_badge_icon`. **That migration was necessary but not
sufficient**, and this is a second, independent defect in the same path.

### The table

```
key           text     NOT NULL              (primary key)
name          text     NOT NULL
description   text     NOT NULL  DEFAULT ''  ← the defect
rank          integer  NOT NULL  DEFAULT 0
is_system     boolean  NOT NULL  DEFAULT false
is_staff      boolean  NOT NULL  DEFAULT false
badge_bg      text     NULL
badge_border  text     NULL
badge_text    text     NULL
badge_icon    text     NULL                  (added pass 14, CHECK on 6 names)
```

### The path

1. `/staff/security/roles` posts exactly `{ key, label }` — the create form has
   two inputs and sends nothing else.
2. `parseCreatePayload` builds a complete `CreatePayload`, filling the absent
   description with **`null`**:
   `description: isString(r.description) ? r.description : null`
3. `toRoleDbColumns` copies every key the payload *has*. `CreatePayload` always
   has `description`, so the insert always names it.
4. The insert therefore sends an **explicit `description: null`**, which
   overrides the column default rather than letting it apply.
5. Postgres refuses it.

### Proven, not reasoned

Run against production inside a function that catches and reports, with the row
deleted and the whole thing rolled back:

| Scenario | Result |
|---|---|
| `description = NULL` | `SQLSTATE 23502 : null value in column "description" of relation "roles" violates not-null constraint` |
| `description = ''` | **succeeded** |

Production after the probe: 4 roles, 0 probe rows. Nothing was left behind.

### Why it survived pass 14

Pass 14 dry-ran the migration with a hand-written SQL insert that supplied a
description. That proved the *column* was fixed. It never exercised the
*route's* payload, which is the thing that omits the description. The dry run
and the application disagreed about what "creating a role" means.

### The same bug, second site

`PATCH /api/staff/security/roles/[key]` line 25:

```ts
if (r.description === null) wire.description = null;
```

Clearing a role's description would fail with the identical 23502. Not
reported, because no UI sends it yet — it fails only when something starts to.

### No migration is required

`DEFAULT ''` is already correct and already applied. The repair is entirely in
application code: stop sending `null` for a column that is `NOT NULL DEFAULT ''`.
Making the column nullable instead would be a schema change to accommodate a
bug.

### Field-to-schema matrix

| Wire field | Column | Type | Nullable | Sent on create | Verdict |
|---|---|---|---|---|---|
| `key` | `key` | text | NO | yes | ok — validated by `ROLE_KEY_PATTERN` |
| `label` | `name` | text | NO | yes | ok |
| `description` | `description` | text | **NO (default `''`)** | **`null`** | **BROKEN — 23502** |
| `priority` | `rank` | integer | NO (default 0) | `0` | ok |
| `is_staff` | `is_staff` | boolean | NO (default false) | `false` | ok |
| `badge_bg` / `badge_border` / `badge_text` | same | text | YES | hex string | ok |
| `badge_icon` | `badge_icon` | text | YES | `null` | ok — CHECK admits NULL |
| — | `is_system` | boolean | NO (default false) | **not sent** | ok — deliberately not writable |

### Error reporting

Every failure but 23505 collapses to `Could not create the role.` The 23502 that
actually fires is therefore invisible to the operator *and* to anyone reading
logs. Mapping is needed for 23502, 23514 (the badge-icon CHECK) and 23503.

---

## 6. `/orders/new` — the label spacing defect

The report names `Project type *`. The route is the **customer-facing**
`/orders/new` (`src/app/orders/new/page.tsx`), not `/staff/orders/new` — the
staff proposal form has no such field.

```ts
const input = "ui-input mt-1";
```

Every control on all four steps carries `mt-1` — **4px** between a label and its
control — and the label is a bare text node inside `<label className="text-sm">`
rather than a real label element:

```tsx
<label className="text-sm">Project type *<MenuSelect className={`${input} …`} /></label>
```

So this is the form *system* being wrong, not one field. Three consequences:

1. **4px is half the site's own spacing.** `.ui-label` — the class this project
   already uses for form labels on the Appearance page and elsewhere — is
   `display: block; margin-bottom: 0.4rem` (6.4px) and carries the muted colour,
   600 weight and letter-spacing that make a label read as a label. `/orders/new`
   uses none of it.
2. **The required `*` is undifferentiated.** It is literal text in the label
   string, the same colour and weight as the label, with no `aria` relationship.
   At 4px separation it sits almost on the control's top border.
3. **`/staff/orders/new` uses `mt-2`** for the same pattern. Two order forms, two
   different spacings, neither matching `.ui-label`.

The fix has to be a shared field primitive, applied to every field on the page —
patching `Project type` alone would leave nine fields wrong and add a fourth
spacing value to the codebase.

---

## 7. Appearance — the settings, and what each one really controls

`/staff/appearance` exposes **51 settings** across 6 sections. Here is every one,
mapped to the CSS variable it sets and the components it actually reaches.

### What is exposed today

| Section | Count | Contents |
|---|---|---|
| Brand & business | 7 | name, short name, tagline, description, public URL, support email, copyright |
| Logos & icons | 5 | header logo, wordmark, footer logo, favicon, apple icon |
| Labels & wording | 3 | community label, projects label, trusted vendor label |
| Navbar | 20 | 3 choices + 17 colours |
| Colors & controls | 15 | 13 choices + 2 brand colours + 11 more colours hidden inside `<details>` |
| Templates | — | save / apply / rename / delete |

### Token → variable → UI map

| Setting as labelled today | CSS variable | Reaches |
|---|---|---|
| Primary actions | `--brand-primary` | Primary buttons, prices, eyebrows, section links, active staff nav, focus rings |
| Accent / selected states | `--brand-accent` | **"Customizable" badge**, accent badges, hover accents, footer links, stepper |
| Page background | `--km-bg` | `<body>` |
| Background gradient end | `--km-bg-end` | `<body>` gradient stop |
| Cards and panels | `--km-surface` | `.ui-card`, product cards, staff panels |
| Inputs and raised panels | `--km-surface-strong` | `.ui-input`, `.ui-btn:hover`, staff nav hover |
| Body text | `--km-text` | Everything not muted |
| Muted text | `--km-muted` | `.text-brand-textMuted`, descriptions, help text |
| Headings | `--km-heading` | `h1`–`h4` |
| Links | `--km-link` | In-content links |
| Borders | `--km-border` | Every `1px solid var(--border)` |
| Primary button text | `--km-primary-button-text` | `.ui-btn-primary` label |
| **Secondary button text** | `--km-secondary-button-text` | **"Need something else? Start a custom project"** |
| Navbar background / text / active / border | `--km-nav-*` | Site header |
| Navbar hover bg / text | `--km-nav-hover-*` | Header links under the pointer |
| Utility ×6 | `--km-nav-util-*` | Search, wishlist, cart, notifications, account |
| Badge bg / text | `--km-nav-badge-*` | Cart and wishlist **counts only** |
| Menu bg / text | `--km-nav-mobile-*` | Dropdowns and the phone drawer |

### The two the owner named, resolved

**"Need something else? Start a custom project"** — `CatalogPageView.tsx:74`. It
is `.ui-btn.ui-btn-secondary`. Its white text comes from **Colors & controls →
Advanced palette → "Secondary button text"**, four levels deep inside a
collapsed `<details>`. Its background comes from `secondaryButtonStyle`, which
defaults to `outline` — so there is no background, and an operator hunting for
"the button's background colour" finds a control that does nothing until the
style is changed to `solid`. Nothing on the page connects the words on the
storefront to either control.

**"Customizable" badge** — `ProductCard.tsx:108`. It is
`.ui-badge.ui-badge-accent`, and all three of its colours are **derived**:

```css
.ui-badge-accent {
  border-color: color-mix(in srgb, var(--brand-accent) 45%, var(--border));
  background: var(--accent-soft);
  color: var(--brand-accent);
}
```

There is **no control for this badge anywhere**. It follows `--brand-accent`,
which also drives the footer links, the stepper and every eyebrow. The owner's
report — "it is unclear which setting controls it" — is not a discoverability
problem. **The setting does not exist.** The honest answer today is "Accent /
selected states, and you cannot change it without changing eight other things."

### Findings

| # | Finding | Severity |
|---|---|---|
| A1 | 11 colours — including both button text colours — are hidden inside a collapsed `<details>` labelled "Advanced palette" | High. These are the most-asked-for colours, not advanced ones |
| A2 | No setting states what it controls. Labels are the token's name ("Cards and panels"), never the storefront's ("product card background") | High |
| A3 | The preview shows staff components — metric cards, a stepper, a tab strip — and **no storefront components at all**. There is no product card, no badge, no price, no catalog CTA | High. The page previews the wrong product |
| A4 | Nothing is searchable. Finding the badge colour requires knowing it is called "accent" | High |
| A5 | The "Customizable" badge, the availability badges and the product price have no controls; they inherit | Medium |
| A6 | Storefront and staff tokens are mixed with no labelling. "Staff navigation" sits between "Inputs" and "Surface shadows" in a list a shop owner reads as storefront settings | Medium |
| A7 | Section names describe the *editor* ("Colors & controls"), not the *subject* | Medium |
| A8 | `.ui-badge-danger` / `-success` are hard-coded `#fb7185` / `#4ade80` and bypass the system entirely | Low — intentional semantics, but undocumented |

### Hard-coded colour sweep

Classified rather than listed, because most are correct:

| Class | Examples | Verdict |
|---|---|---|
| Semantic status | `#fb7185` (danger), `#4ade80` (success), `#fecdd3`, `#bbf7d0` | **Intentionally fixed.** Red must stay red |
| Role badge defaults | `#111827`, `#374151`, `#E5E7EB` in `roleSchema.ts` | **Intentionally fixed** — per-role overrides in the roles editor |
| Theme defaults | every hex in `defaultSiteTheme` | **Intentionally fixed** — they are the defaults |
| Staff page chrome | `border-zinc-800`, `bg-black/35`, `bg-black/30` on `/staff/security/roles`, `/orders/new` review cards | **Should be configurable** — these bypass `--border` / `--panel`, so the staff area does not follow Appearance |
| Appearance publish bar | `bg-black/90 border-brand-border` | **Should be configurable** — invisible on a light theme |

The staff-chrome group is a real bypass: `/staff/security/roles` is built almost
entirely from `border-zinc-800 bg-black/35`, so changing surface and border
colours in Appearance leaves that page unchanged.

---

## 8. Page framework consistency

Eight of the pages inspected carry a different page header.

| Page | Eyebrow | Title | Description | Breadcrumb |
|---|---|---|---|---|
| `/staff/settings` | yes | `text-3xl` | yes | yes |
| `/staff/appearance` | yes | `text-3xl` | yes | yes |
| `/staff/security/roles` | **no** | **`text-lg`** | **no** | yes |
| `/staff/orders/new` | yes | `text-3xl` | yes | yes |
| `/orders/new` | yes | `text-4xl` | yes | n/a |

`/staff/security/roles` renders `Security` at `text-lg` with `Roles &
permissions` beneath it as a subtitle — inverting the hierarchy the breadcrumb
above it just established, and using a heading size smaller than its own card
titles elsewhere. It also wraps itself in `mx-auto max-w-6xl px-4 py-8` **inside**
the staff shell, which already applies a container — so the page is double-padded
and narrower than every sibling.

---

## 9. Task walkthroughs, as the product stands today

| Task | Clicks from `/staff` | Verdict |
|---|---|---|
| A — Create a role | 2 (Settings group is open; Roles & permissions; type; Create) | Path is fine. **The action fails** (§5) |
| B — Change the "Customizable" badge colour | **Not possible.** Appearance → Colors & controls → Brand colors → "Accent / selected states" changes it *and* seven other things | **Broken** |
| C — Change the custom-project CTA | 5, ending inside a collapsed `<details>` — and only if the operator knows the CTA is a "secondary button" | **Broken in practice** |
| D — Manage a new order | 1 (Orders → row) | Good |
| E — Link production to an order | 2 (Orders → order → Shop work → Link) | Good — pass 14 |
| F — Ship an order | 2 (Fulfillment → row → Open order) | Good, and correctly routed through the order |
| G — Add a product category | 2 (Store → Categories → New) | Good |

Tasks D–G are healthy. **A, B and C are the pass.**

---

## 10. What this pass will do, and what it will not

### Doing

1. IA regroup and renames (§2, §3) — one config, no new routes
2. Collapsed sidebar rebuilt as a real 72px rail (§4)
3. Role creation repaired, with real error messages (§5)
4. A shared form field primitive, applied across `/orders/new` (§6)
5. Appearance rebuilt around a declared token map with search, storefront
   previews, and every control naming what it changes (§7)
6. A dedicated control for the "Customizable" badge and the catalog CTA (§7 A5)
7. Settings index grouped into named subsections (§2)

### Not doing, and why

- **No new routes.** The audit found no missing destination.
- **`/staff/security/roles` page-framework rebuild** is limited to the header and
  container; the badge/permission editor's internals are left alone. Rewriting it
  would put an untestable surface (no automated session can reach it) into the
  same pass as the fix that makes it work.
- **The staff-chrome hard-coded colour sweep** (§7, staff-chrome row) is recorded
  and not executed. It touches every staff page and belongs in its own pass with
  its own visual verification.
- **Custom Requests nav entry** — no route exists (§2).

---

## 11. Verified after implementation — 2026-08-08

Driven in a real browser against a dev server from a cleared `.next`. Staff pages
were reached by seeding the `["meAccess"]` query through the React fiber, which
works locally only — middleware redirects `/staff/*` before any HTML otherwise.

### The collapsed sidebar, measured

| Width | Expanded rail | Collapsed rail | Content expanded | Overflow |
|---|---|---|---|---|
| 1024 | 280px | **72px** | 876.8px | none |
| 1280 | 280px | **72px** | 924.8 → **1132.8px** (+208) | none |
| 1440 | 280px | **72px** | 1148px | none |
| 1920 | 280px | **72px** | 1148px | none |

Labels are `position: absolute` and reserve 1px, icons are centred to within
2px, the active item keeps `aria-current`, expand/collapse round-trips, and the
preference persists to `localStorage`. At 320/375/768 the rail is `display:
none` and the drawer trigger is present — a desktop preference cannot reach a
phone.

**The keyboard tooltip works.** It first read as broken: the link matched
`:focus-visible` but computed opacity stayed `0` even 400ms later. The cause was
not CSS — the Browser pane does not composite frames, so a `transition` never
advances and `getComputedStyle` returns the from-value forever. With
`transition: none` forced: focus → `1`, blur → `0`, refocus → `1`.

### Appearance, driven

Search matches against the *screen elements*, which is the whole point:

| Typed | Surfaced |
|---|---|
| `customizable` | Accent colour, **Badge background, Badge text, Badge border** |
| `custom project` | Accent colour, **Secondary button background, text, border** |
| `cart` | Utility background/border/icon/hover, Count badge background & number |
| `price` | Primary brand colour |

The preview updates live, with no save: typing `#22C55E` into Badge background
moved the previewed "Customizable" badge from the accent derivation
`color(srgb 0.96 0.62 0.04 / 0.18)` to `rgb(34, 197, 94)`, and emitted
`--km-badge-bg: #22C55E`. Pressing **Clear** returned the badge to the accent
derivation with the variable **absent** — not empty — which is exactly what lets
`var(--km-badge-bg, var(--accent-soft))` reach its fallback, and the field then
reads "Automatic".

### `/orders/new`

| | Before | After |
|---|---|---|
| `Project type` label-to-control gap | 4px | **8px** |
| Label `display` | inline text node | `block`, `margin-bottom: 8px` |
| Required marker | literal `*` in the string | `.ui-required`, 3.2px left margin |
| Accessible name | `Project type *` | `Project type* (required)` |

All three step-1 fields measure 8px, identical at 375 and 1280, no horizontal
overflow at either.

### Role creation, proven against the live schema

Every case run inside a rolled-back transaction; production untouched
(4 roles, 0 probes, 47 migrations, before and after).

| Scenario | Result |
|---|---|
| Route's payload now (`description = ''`) | **succeeds** — `is_system=false`, no permissions |
| Old payload (`description = null`) | `23502` — the reported failure |
| All six badge icons | **all accepted** |
| `rocket` | `23514` → "That is not one of the available badge icons." |
| Duplicate key `admin` | `23505` → "A role with that key already exists." |

### Accessibility

One `h1`, no heading-level skips, no image without `alt`, no unlabelled input,
no unnamed button, one live region (the search result count).

**Pre-existing and not introduced here:** every staff page renders its own
`<main>` inside the root layout's `<main id="main-content">`, so there are two
`main` landmarks. Confirmed present at `f9dded6` on `/staff/appearance`,
`/staff/settings` and `/staff/orders/new`. Converting `/staff/security/roles`
from a `<div>` to a `<main>` made it consistent with its siblings and therefore
joins the same pre-existing pattern. Fixing it properly means changing the
landmark on roughly thirty pages, which belongs in the page-framework pass this
one deliberately scoped down.

Console carried only the **pre-existing** `data-motion` hydration mismatch on
the root `html` (present since pass 3, reproduces on `/`), local 503s from the
deliberately fake service-role key, and 401/403s from an unauthenticated seeded
session.
