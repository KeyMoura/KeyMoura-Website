# Storefront Catalog & Responsive Discovery 2.0

## Audit and root cause

The catalog already shared its data loader, URL filter model, product grid, category routes, and page shell. The reported disappearance was a CSS handoff defect rather than a routing or data defect:

- `.catalog-rail` was hidden by default and became visible only at `min-width: 1024px`.
- `.catalog-drawer-trigger` was visible by default but hidden at `min-width: 640px`.
- Therefore **640px through 1023.98px** rendered neither a category rail nor a category trigger. The search and inline sort remained, but nothing replaced category navigation. Subcategories remained reachable only through breadcrumbs/known URLs, not discoverable navigation.
- Categories and all filters/sort were combined in one phone-only “Browse & filter” sheet. The current category was included in that trigger below 640px, but disappeared with the trigger above 640px.
- Grid density was correctly limited to meaningful desktop widths and the grid already used one column below 640px, two from 640px, and a persisted 2/3/4 desktop preference from 1024px. `minmax(0, 1fr)` prevented long content from widening tracks.
- The product grid correctly dropped the rail track below 1024px, so there was no empty sidebar gutter. Product images already reserved a consistent aspect ratio and product cards already used customer-safe price, availability, customization and media fields.
- Breadcrumbs remained rendered on category and product pages and wrapped rather than causing horizontal page overflow.

## Responsive model after this pass

The handoff now occurs at one boundary:

| Width | Category navigation | Product grid | Controls |
| --- | --- | --- | --- |
| 375–639px | labeled Categories trigger + bottom sheet | 1 column | Categories, Filters and Sort are separate, full-width toolbar actions |
| 640–1023px | labeled Categories trigger + right-side drawer | 2 columns | Categories and Filters remain present; Sort stays inline |
| 1024–1279px | sticky 15rem category rail | persisted 2/3 columns (4 clamped to 3) | desktop filters, sort and density |
| 1280px+ | sticky 15rem category rail | persisted 2/3/4 columns, default 3 | desktop filters, sort and density |

Representative regression widths are asserted at 375, 430, 640, 768, 820, 900, 1024, 1100, 1280 and 1440. Compact controls are the default and are hidden at the same `1024px` media query that reveals the rail; there is no independent breakpoint that can create another gap.

## Customer-facing changes

- Desktop and compact layouts render the same `CatalogCategoryTree` and the same `BrowseMenu`; active parents, active children, counts and canonical links cannot drift between presentations.
- Categories and Filters now have distinct labeled triggers, avoiding a second ambiguous hamburger beside the site Menu. Sort remains directly reachable at 375px without opening either drawer.
- The sheet is a bottom sheet on phones and a full-height side drawer on tablets. It traps focus, closes with Escape/backdrop/close button, locks background scroll, restores the scroll position and returns focus to the trigger that opened it.
- Catalog home surfaces top-level category discovery cards. Parent categories surface their child categories without forcing customers to reopen the drawer.
- Active search, availability, purchase-mode and sort state is presented as individually removable chips, with the existing Clear filters action retained.
- Authoritative filtered and total result counts remain visible. Loader errors now throw into the route error boundary instead of becoming `0 products`.
- URL semantics are unchanged: category/subcategory remain path segments; search, availability, purchase mode and sort remain canonical query parameters; density remains a pre-paint local preference.

## Preserved behavior

No schema or migration changed. Product route ambiguity guards, canonical paths, invalid nesting/404 behavior, featured staff order, inventory publication policy, product option groups, swatches, price adjustments, gallery jumps, quantity typing, normal-flow purchase panel, and the permanent 3D warning remain unchanged.
