/**
 * How the catalog results are laid out, and where that decision lives.
 *
 * ## Why this is not just a `useState` in the grid
 *
 * The grid used `repeat(auto-fill, minmax(18rem, 1fr))`, which let the viewport
 * decide. That is a reasonable default and a poor *setting*: a customer who
 * wants to see more products at once had nothing to press, and the number of
 * columns changed under them as the browsing rail appeared and disappeared.
 *
 * Making it a preference introduces the usual hazard — the server has no
 * `localStorage`, so a stored value of 4 renders 3 columns and then reflows to
 * 4 after hydration, which is a visible jump on the page's main content. So the
 * *layout* never reads React state at all: `catalogViewScript` stamps
 * `data-catalog-density` on `<html>` before first paint and CSS keys off the
 * attribute. React owns only which button looks pressed.
 *
 * ## Why `list` is a view and not a fourth density
 *
 * "1 column" and "List" are different products. A one-across vertical card is a
 * card with too much white space beside it; a list row is a horizontal result —
 * larger image, room for a description, price and action in their own column —
 * which is the layout a shopper uses to *compare* rather than to browse. So the
 * control offers `List | 2 | 3 | 4` and `list` gets a real layout of its own
 * rather than `grid-template-columns: 1fr`.
 *
 * It rides the same attribute for the same reason the densities do. Choosing
 * the layout in CSS rather than by swapping components is what keeps the
 * pre-paint script meaningful: a component swap would have to wait for
 * hydration, and every visit would open on cards and jump to rows.
 *
 * ## The clamp
 *
 * Four columns needs room. Below 1280 the browsing rail takes 15rem out of the
 * row and four cards would each be under 180px — a card whose price and title
 * collide. The stored preference is *kept* (widen the window and it comes back)
 * and clamped in CSS for the width where it does not fit, rather than being
 * rewritten, which would silently lose the choice.
 *
 * ## Why the default is now `list`
 *
 * Three across was chosen when the grid was the only layout and the question was
 * only how many. Now that a real list view exists, the question is which layout
 * a customer who has expressed no opinion should meet first — and for a shop
 * with a handful of made-to-order products, that is the row: it carries the
 * description, the material, the lead time and the price at once, which is what
 * someone deciding *whether* to buy needs. A three-across grid is a browse mode
 * for a catalog large enough to need browsing.
 *
 * Changing the canonical default deliberately does **not** touch anyone's stored
 * value. `DEFAULT_CATALOG_VIEW` is only consulted when the slot is empty or
 * unreadable, so a customer who pressed 2, 3, 4 — or List — keeps exactly what
 * they pressed.
 */

/**
 * Unchanged from when the preference held only a column count, so a customer
 * who already chose 4 keeps it. `list` is a new value in the same slot.
 */
export const CATALOG_VIEW_KEY = "km.catalog.density";

/** The grid densities. `list` is a view, not a density, and is not in here. */
export const CATALOG_DENSITIES = [2, 3, 4] as const;
export type CatalogDensity = (typeof CATALOG_DENSITIES)[number];

/** Every view the control offers, in the order it offers them. */
export const CATALOG_VIEWS = ["list", 2, 3, 4] as const;
export type CatalogView = (typeof CATALOG_VIEWS)[number];

/**
 * What a customer with no stored preference gets. See the note above: the row
 * shows the whole product, and this catalog is small enough that comparing
 * beats browsing.
 */
export const DEFAULT_CATALOG_VIEW: CatalogView = "list";

/**
 * Where the narrow-width *Grid* button lands, and the column count the CSS
 * falls back to.
 *
 * Separate from `DEFAULT_CATALOG_VIEW` on purpose. That button's whole job is to
 * leave the list, so it cannot be wired to a default that *is* the list — before
 * this split, pointing the canonical default at `list` would have turned Grid
 * into a no-op that re-selected the mode the customer was trying to escape.
 */
export const DEFAULT_GRID_DENSITY: CatalogDensity = 3;

/**
 * Spoken labels. "3" alone is not a control name a screen reader can use, and
 * "1" is not what a one-across list actually is.
 */
export const CATALOG_VIEW_LABELS: Record<string, string> = {
  list: "List view",
  grid: "Grid view",
  2: "Two columns",
  3: "Three columns",
  4: "Four columns",
};

/**
 * The word beside the icon. Only the two *views* carry one — a column count is
 * legible as a picture of that many columns, and "list" and "grid" are not.
 */
export const CATALOG_VIEW_SHORT_LABELS: Record<string, string> = {
  list: "List",
  grid: "Grid",
  2: "2",
  3: "3",
  4: "4",
};

/** The width below which four columns is refused, matching the CSS clamp. */
export const FOUR_COLUMN_MIN_WIDTH = 1280;

/** The attribute value written to `<html>`, which is always a string. */
export const catalogViewAttribute = (view: CatalogView): string => String(view);

export function isCatalogDensity(value: unknown): value is CatalogDensity {
  return CATALOG_DENSITIES.includes(value as CatalogDensity);
}

export function isCatalogView(value: unknown): value is CatalogView {
  return (CATALOG_VIEWS as readonly unknown[]).includes(value as CatalogView);
}

/**
 * Parses a stored value. Accepts both a bare `3` and a JSON `3`, because
 * `useStoredPreference` writes with `JSON.stringify` and a hand-edited or
 * older entry may not be quoted. Anything else is the default rather than a
 * throw — a corrupt preference must not break the catalog.
 */
export function parseCatalogView(raw: string): CatalogView {
  const cleaned = raw.replace(/"/g, "").trim();
  if (cleaned === "list") return "list";
  const parsed = Number.parseInt(cleaned, 10);
  return isCatalogDensity(parsed) ? parsed : DEFAULT_CATALOG_VIEW;
}

/**
 * Runs before first paint, so the grid's very first layout is already the
 * customer's.
 *
 * It now stamps the attribute *unconditionally* — the stored value when there is
 * a readable one, `list` when there is not. Previously a first-time visitor was
 * left with no attribute at all and fell through to the CSS default, which was
 * fine while that default matched the canonical one and became a second place to
 * state it the moment they diverged. One writer, one answer.
 *
 * Written as a string rather than a function so it can be inlined by the layout,
 * and deliberately total: if `localStorage` throws — Safari's private mode, a
 * blocked third-party context — the `catch` still stamps the default rather than
 * leaving the page to guess.
 */
export const catalogViewScript = `try{var v=localStorage.getItem(${JSON.stringify(
  CATALOG_VIEW_KEY
)});v=v?v.replace(/"/g,'').trim():'';if(v!=='list'&&v!=='2'&&v!=='3'&&v!=='4'){v=${JSON.stringify(
  String(DEFAULT_CATALOG_VIEW)
)}}document.documentElement.dataset.catalogDensity=v}catch(e){try{document.documentElement.dataset.catalogDensity=${JSON.stringify(
  String(DEFAULT_CATALOG_VIEW)
)}}catch(e2){}}`;
