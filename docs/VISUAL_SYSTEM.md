# Visual system

**Pass:** Visual System & Appearance 3.0 · **Date:** 2026-08-14

What the shared visual language is, and — for every visual role — whether the
Appearance editor controls it or it is deliberately fixed. Written to be checked
against, not admired. The assertions behind it live in
`tests/appearance-role-coverage.test.ts`, `tests/staff-row-layout.test.ts`,
`tests/appearance-token-map.test.ts` and `tests/appearance-tasks.test.ts`.

## Where the system lives

| Layer | File | Holds |
| --- | --- | --- |
| Tokens | `src/app/globals.css` (`@layer base`) | Surfaces, text, brand, focus, and the resolved component roles |
| Components | `src/app/globals.css` (`@layer components`) | `.ui-*` primitives, `.staff-*` framework, `.product-card-*` |
| Theme model | `src/theme/runtime.ts` | `SiteTheme`, defaults, normalisation |
| Coverage map | `src/theme/appearanceMap.ts` | Every colour, what it reaches, in the owner's words |
| Editor tasks | `src/theme/appearanceTasks.ts` | Those colours grouped as things on screen |
| Harness | `/dev/visual` | Real components against fixtures; not reachable in production |

## Container strategy

Three levels, chosen by what a page is, not by who owns it.

| Level | Class | Width | Used by |
| --- | --- | --- | --- |
| Standard content | `.page-container` | 72rem | Storefront pages, customer account |
| Wide operational | `.page-container-wide` | 80rem | Dense customer surfaces, order detail |
| Workspace | staff shell + rail | fills, minus the 280px rail | `/staff/*` |

The owner's **Content width** setting scales the first two to 88rem (wide) or
100rem (full). Staff pages are legitimately wider than customer pages; equivalent
pages align with each other.

## Spacing rhythm

One scale. Values below are what the shared classes already emit — the point is
that a page picks a level, not a number.

| Level | Value | For |
| --- | --- | --- |
| XS | `.25rem`–`.375rem` | Inline items: badge groups, icon-to-label |
| SM | `.5rem` | Label to control (`.ui-label`), row internals |
| MD | `.875rem` | Component separation, `.staff-section` gap |
| LG | `1rem`–`1.25rem` | Card padding, `.page-stack` gap |
| XL | `1.5rem` | Major page sections (`.staff-page` gap) |

## Buttons

Six roles. A page picks a role; it does not invent styling.

| Role | Class | Fill | Label |
| --- | --- | --- | --- |
| Primary | `.ui-btn-primary` | `--primary-action-bg` | `--primary-action-text` |
| Commerce primary | `.catalog-action-primary` | same role | same role |
| Product card CTA (**Buy now**) | `.product-card-action` | same role | same role |
| Secondary | `.ui-btn-secondary` | `--km-secondary-button-bg` | `--km-secondary-button-text` |
| Quiet | `.ui-btn-ghost` | transparent | `--text` |
| Danger | `.ui-btn-danger` | fixed rose | fixed rose |

**The primary action role is resolved once** in `:root`, and all three primary
consumers read it:

```
--primary-action-bg     = var(--km-primary-button-bg,     var(--brand-primary))
--primary-action-border = var(--km-primary-button-border, var(--km-primary-button-bg, var(--brand-primary)))
--primary-action-text   = var(--km-primary-button-text,   #09090b)
```

The Soft, Outline and Framed shapes re-point `--primary-action-text` to
`--brand-primary`, because those shapes put the label on the page rather than on
the fill. Keeping the on-fill colour there measured **1.05:1** — near-black text
on a transparent button over a near-black page.

## Badges

One geometry: 24px min-height, pill radius, `.72rem` 600-weight, `.15rem/.55rem`
padding, 1px border. Only the colours differ.

| Tone | Colour source | Controllable? |
| --- | --- | --- |
| Neutral | `--panel` / `--border` / `--text` | Yes, via surfaces |
| Accent | `--km-badge-bg` / `-text` / `-border` | **Yes**, falls back to accent |
| Success | literal `#4ade80` | **No — intentionally fixed** |
| Warning | `--brand-primary` | Follows the brand |
| Danger | literal `#fb7185` | **No — intentionally fixed** |

Success and danger are fixed on purpose: a red that could be reassigned would
stop meaning "stopped". The editor says this in words rather than implying
control it does not have.

### Placement

A badge belongs in the slot that describes its subject. In lists that is
`.staff-row-aside`; badges are never emitted as bare grid children, because
auto-placement is what detached them in the first place.

## List rows

`.staff-row` is the one list surface. It has four named slots:

| Slot | Class | Carries |
| --- | --- | --- |
| Media | `.staff-row-media` | 3rem thumbnail or avatar |
| Identity | `.staff-row-main` | Title plus secondary metadata |
| Figure | `.staff-row-figure` | One aligned number (price, total) |
| Status | `.staff-row-aside` | The badge group |

Media and figure are optional, and **every combination has its own explicit
`grid-template-areas`**. A `grid-area` naming an area the active template does
not declare does not degrade gracefully — it creates an implicit track and
drifts to a corner of the row. That is the bug that produced the detached pills
on `/staff/catalog`, and it reappeared once while adding the figure slot.

Layout switches on **`@container staff-rows (min-width: 34rem)`**, not a media
query, because the catalog list renders in a 380px editor column at `xl` and
full width below it. At a 1440px viewport both layouts are on screen at once.

```
narrow   "media main  main"        wide   "media main figure aside"
         "media aside figure"
```

## Cards and panels

`.ui-card` is the panel. A card inside a `.staff-section` drops its own heading
block, so a section heading and a card heading do not stack. Nested bordered
boxes are avoided; grouping is done with headings and whitespace first, a border
only when it is earned.

## Forms

`.ui-field` / `.ui-label` / `.ui-input` / `.ui-help` own the rhythm: 0.5rem from
label to control, 0.375rem from control to help text, decided once so a form
cannot drift by choosing its own.

## Appearance coverage matrix

Every visual role, and how it is controlled. "Preview" means the Appearance page
renders that role with the real component.

| Role | Control | Preview | Real consumers |
| --- | --- | --- | --- |
| Page background | Page background | Yes | every page |
| Background fade | Background fade | Yes | gradient body |
| Card background | Card background | Yes | `.ui-card`, product cards |
| Input / raised background | Input & raised background | Yes | `.ui-input`, `.ui-select-trigger` |
| Border | Border colour | Yes | cards, inputs, tables, rows |
| Body text | Body text | Yes | paragraphs, table cells |
| Quiet text | Quiet text | Yes | labels, help, timestamps |
| Heading text | Heading text | Yes | page and section titles |
| Link text | Link colour | Yes | in-content links |
| Brand primary | Brand primary | Yes | prices, eyebrows, focus, sidebar selection |
| Accent | Accent colour | Yes | accent badges, footer links, stepper |
| **Primary button background** | **Primary button background** *(new)* | **Yes** | `.ui-btn-primary`, `.catalog-action-primary`, **Buy now** |
| **Primary button text** | Primary button text | **Yes** | the same three |
| **Primary button border** | **Primary button border** *(new)* | **Yes** | the same three |
| Commerce CTA (Buy now) | *Primary button* — not a separate role | **Yes** | `.product-card-action` |
| Secondary button background | Secondary button background | Yes | `.ui-btn-secondary` |
| Secondary button text | Secondary button text | Yes | `.ui-btn-secondary` |
| Secondary button border | Secondary button border | Yes | `.ui-btn-secondary` |
| Quiet button | *Body text + Border* | Yes | `.ui-btn-ghost` |
| Badge background / text / border | Badge background / text / border | Yes | `.ui-badge-accent` |
| Navigation background / text / active / border | Navbar group | Yes | site header |
| Navigation hover | Navbar hover background / text | Yes | header links |
| Input focus | *Accent colour* (`--focus`) | Yes | every focusable control |
| Count badge | Count badge background / number | Yes | cart and wishlist counts |
| Menu panels | Menu panel background / text | Yes | dropdowns, phone drawer |
| **Danger** | **Fixed** `#fb7185` | Yes | `.ui-badge-danger`, `.ui-btn-danger`, `.ui-notice-danger` |
| **Success** | **Fixed** `#4ade80` | Yes | `.ui-badge-success`, `.ui-notice-success` |
| **Warning / in review** | Follows **Brand primary** | Yes | `.ui-badge-warning`, `.ui-metric-warning` |
| Staff panels | *Card background + Border* — no staff-only colour | Yes | `.staff-*` |
| Customer cards | *Card background* | Yes | `.ui-card`, product cards |

### Intentionally fixed

- **Success green and danger rose.** Reassignable status colour stops being status.
- **Focus outline geometry** (2px, 3px offset). The colour follows the accent; the
  shape does not move, and is never removed.
- **Badge geometry.** Height, radius and padding are one value everywhere.

## Responsive principles

1. Ask the **container**, not the viewport, whenever a component renders in more
   than one column width. The 280px staff rail makes viewport width a lie.
2. Degrade by regrouping, not by repositioning individual elements.
3. Nothing disappears without a replacement.
4. No horizontal page overflow at any width; wide content scrolls inside its own
   box.
5. Mobile reduces gutters and stacks; it does not proportionally shrink desktop.

## Customer vs staff density

They share the type scale, spacing scale, controls and colours. Staff surfaces
use the tighter end (`.875rem` section gaps, 3rem thumbnails, denser rows);
customer surfaces use the looser end (1.25rem card padding, 4:3 imagery). The
difference is density, never a different vocabulary.
