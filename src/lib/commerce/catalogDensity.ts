/**
 * How many product columns the catalog grid shows, and where that decision lives.
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
 * *layout* never reads React state at all: `catalogDensityScript` stamps
 * `data-catalog-density` on `<html>` before first paint and CSS keys off the
 * attribute. React owns only which button looks pressed.
 *
 * ## The clamp
 *
 * Four columns needs room. Below 1280 the browsing rail takes 15rem out of the
 * row and four cards would each be under 180px — a card whose price and title
 * collide. The stored preference is *kept* (widen the window and it comes back)
 * and clamped in CSS for the width where it does not fit, rather than being
 * rewritten, which would silently lose the choice.
 */

export const CATALOG_DENSITY_KEY = "km.catalog.density";

export const CATALOG_DENSITIES = [2, 3, 4] as const;
export type CatalogDensity = (typeof CATALOG_DENSITIES)[number];

/** Three across on a desktop. Two was the effective default and read as sparse. */
export const DEFAULT_CATALOG_DENSITY: CatalogDensity = 3;

/** Spoken labels. "3" alone is not a control name a screen reader can use. */
export const CATALOG_DENSITY_LABELS: Record<CatalogDensity, string> = {
  2: "Two columns",
  3: "Three columns",
  4: "Four columns",
};

/** The width below which four columns is refused, matching the CSS clamp. */
export const FOUR_COLUMN_MIN_WIDTH = 1280;

export function isCatalogDensity(value: unknown): value is CatalogDensity {
  return CATALOG_DENSITIES.includes(value as CatalogDensity);
}

/**
 * Parses a stored value. Accepts both a bare `3` and a JSON `3`, because
 * `useStoredPreference` writes with `JSON.stringify` and a hand-edited or
 * older entry may not be quoted. Anything else is the default rather than a
 * throw — a corrupt preference must not break the catalog.
 */
export function parseCatalogDensity(raw: string): CatalogDensity {
  const parsed = Number.parseInt(raw.replace(/"/g, "").trim(), 10);
  return isCatalogDensity(parsed) ? parsed : DEFAULT_CATALOG_DENSITY;
}

/**
 * Runs before first paint, so the grid's very first layout is already the
 * customer's. Written as a string rather than a function so it can be inlined
 * by the layout; it is deliberately total — any failure leaves the attribute
 * absent and the CSS default (three) applies.
 */
export const catalogDensityScript = `try{var v=localStorage.getItem(${JSON.stringify(
  CATALOG_DENSITY_KEY
)});if(v){v=v.replace(/"/g,'').trim();if(v==='2'||v==='3'||v==='4'){document.documentElement.dataset.catalogDensity=v}}}catch(e){}`;
