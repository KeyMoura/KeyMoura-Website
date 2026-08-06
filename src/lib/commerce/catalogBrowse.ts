/**
 * Storefront catalog browsing rules.
 *
 * Pure and dependency-free, so the server page, the client grid, the browse
 * menu, the mobile drawer and the tests all read the same rules. The category
 * *domain* rules stay in `categories.ts`; this module is only about how a
 * customer moves through them.
 *
 * ## One URL namespace under /catalog
 *
 * The requested structure is:
 *
 *     /catalog
 *     /catalog/[category]
 *     /catalog/[category]/[subcategory]
 *
 * `/catalog/[slug]` was already the product-detail route, and Next.js cannot
 * have two different dynamic segments in one position. Products were **not**
 * moved: `/catalog/premade-shift-knob` is live, indexed, and linked from the
 * cart, wishlist, order pages and transactional email, so relocating it would
 * break real links to gain nothing a customer can see.
 *
 * Instead the segment resolves a **category first, then a product**, and the
 * database refuses a category slug that a product already uses and vice versa
 * (`20260806040000_catalog_slug_namespace.sql`). That is the documented
 * uniqueness rule: category slugs are unique among categories *and* disjoint
 * from product slugs, so one path can never mean two things. Ambiguity is
 * unrepresentable rather than resolved by precedence.
 */

import type { CategoryRow } from "@/lib/commerce/categories";

export type BrowseProduct = {
  id: string;
  name: string;
  slug: string;
  short_description?: string | null;
  category?: string | null;
  category_id?: string | null;
  purchase_mode?: string | null;
  starting_price_cents?: number | null;
  availability_status?: string | null;
  created_at?: string | null;
};

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const CATALOG_SORTS = ["featured", "newest", "name", "price-low", "price-high"] as const;
export type CatalogSort = (typeof CATALOG_SORTS)[number];

export const CATALOG_AVAILABILITY = ["all", "available", "limited", "made_to_order"] as const;
export type CatalogAvailability = (typeof CATALOG_AVAILABILITY)[number];

export const CATALOG_MODES = ["all", "direct_purchase", "direct_or_request", "request_only"] as const;
export type CatalogMode = (typeof CATALOG_MODES)[number];

export type CatalogFilters = {
  query: string;
  availability: CatalogAvailability;
  mode: CatalogMode;
  sort: CatalogSort;
};

export const DEFAULT_FILTERS: CatalogFilters = {
  query: "",
  availability: "all",
  mode: "all",
  sort: "featured",
};

const MAX_QUERY = 80;

type ParamSource = { get(key: string): string | null } | Record<string, string | string[] | undefined>;

function readParam(source: ParamSource, key: string): string {
  if (typeof (source as { get?: unknown }).get === "function") {
    return (source as { get(key: string): string | null }).get(key) ?? "";
  }
  const raw = (source as Record<string, string | string[] | undefined>)[key];
  if (Array.isArray(raw)) return raw[0] ?? "";
  return raw ?? "";
}

const oneOf = <T extends string>(allowed: readonly T[], value: string, fallback: T): T =>
  (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/**
 * Filters from the URL, and nothing else.
 *
 * **Total**: any input at all yields usable filters. An unknown value is
 * dropped for the default rather than interpolated anywhere — the same rule
 * `orderFilters.ts` follows on the staff side, for the same reason.
 *
 * The URL is the only place these live. A `useState` mirror is what makes the
 * back button disagree with what is on screen.
 */
export function parseCatalogFilters(source: ParamSource): CatalogFilters {
  return {
    query: readParam(source, "q").trim().slice(0, MAX_QUERY),
    availability: oneOf(CATALOG_AVAILABILITY, readParam(source, "availability"), "all"),
    mode: oneOf(CATALOG_MODES, readParam(source, "mode"), "all"),
    sort: oneOf(CATALOG_SORTS, readParam(source, "sort"), "featured"),
  };
}

/**
 * The query string for a set of filters, with defaults omitted.
 *
 * Canonical: the same filters always produce the same string, so two paths to
 * one view do not create two URLs a crawler treats as different pages.
 */
export function catalogFilterQuery(filters: CatalogFilters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set("q", filters.query);
  if (filters.availability !== "all") params.set("availability", filters.availability);
  if (filters.mode !== "all") params.set("mode", filters.mode);
  if (filters.sort !== "featured") params.set("sort", filters.sort);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

/**
 * The labels for each filter, beside the values they belong to.
 *
 * Here rather than in a component because the drawer and the toolbar both
 * render them, and a second copy is how one control ends up offering a value
 * `parseCatalogFilters` drops.
 */
export const AVAILABILITY_OPTIONS: { value: CatalogAvailability; label: string }[] = [
  { value: "all", label: "Any availability" },
  { value: "available", label: "Available" },
  { value: "limited", label: "Limited" },
  { value: "made_to_order", label: "Made to order" },
];

export const MODE_OPTIONS: { value: CatalogMode; label: string }[] = [
  { value: "all", label: "Any purchase type" },
  { value: "direct_purchase", label: "Buy now" },
  { value: "direct_or_request", label: "Buy or customize" },
  { value: "request_only", label: "Quoted" },
];

export const SORT_OPTIONS: { value: CatalogSort; label: string }[] = [
  { value: "featured", label: "Featured" },
  { value: "newest", label: "Newest" },
  { value: "name", label: "Name" },
  { value: "price-low", label: "Price: low to high" },
  { value: "price-high", label: "Price: high to low" },
];

export function filtersAreDefault(filters: CatalogFilters): boolean {
  return (
    !filters.query &&
    filters.availability === "all" &&
    filters.mode === "all" &&
    filters.sort === "featured"
  );
}

/** How many filters are doing something, for the mobile trigger's badge. */
export function activeFilterCount(filters: CatalogFilters): number {
  let count = 0;
  if (filters.query) count += 1;
  if (filters.availability !== "all") count += 1;
  if (filters.mode !== "all") count += 1;
  if (filters.sort !== "featured") count += 1;
  return count;
}

// ---------------------------------------------------------------------------
// Applying them
// ---------------------------------------------------------------------------

const priceOr = (value: number | null | undefined, fallback: number) => value ?? fallback;

export function applyCatalogFilters<T extends BrowseProduct>(
  products: readonly T[],
  filters: CatalogFilters
): T[] {
  const term = filters.query.trim().toLowerCase();

  const matched = products.filter((product) => {
    if (term) {
      const haystack = `${product.name} ${product.short_description ?? ""} ${product.category ?? ""}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    if (filters.availability !== "all" && product.availability_status !== filters.availability) return false;
    if (filters.mode !== "all" && (product.purchase_mode ?? "request_only") !== filters.mode) return false;
    return true;
  });

  switch (filters.sort) {
    case "name":
      return [...matched].sort((a, b) => a.name.localeCompare(b.name));
    case "newest":
      // A product with no timestamp sorts last rather than first: an unknown
      // date is not evidence of being new.
      return [...matched].sort(
        (a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") || a.name.localeCompare(b.name)
      );
    case "price-low":
      return [...matched].sort(
        (a, b) =>
          priceOr(a.starting_price_cents, Number.MAX_SAFE_INTEGER) -
          priceOr(b.starting_price_cents, Number.MAX_SAFE_INTEGER)
      );
    case "price-high":
      return [...matched].sort(
        (a, b) => priceOr(b.starting_price_cents, -1) - priceOr(a.starting_price_cents, -1)
      );
    default:
      // "Featured" is the order staff arranged, which the server already
      // applied. Re-sorting it here would throw that away.
      return [...matched];
  }
}

// ---------------------------------------------------------------------------
// The browse menu
// ---------------------------------------------------------------------------

export type BrowseChild = {
  id: string;
  name: string;
  slug: string;
  href: string;
  count: number;
  isActive: boolean;
};

export type BrowseEntry = {
  id: string | null;
  name: string;
  slug: string | null;
  href: string;
  /** Products in this category and every subcategory of it. */
  count: number;
  isActive: boolean;
  /** True for the entry the customer is inside, including via a subcategory. */
  isCurrentBranch: boolean;
  children: BrowseChild[];
};

export type BrowseMenu = {
  all: BrowseEntry;
  categories: BrowseEntry[];
  /** The trail for the breadcrumb, parent first. Empty on All products. */
  trail: CategoryRow[];
};

/**
 * The menu model, derived from the same rows and products the grid renders.
 *
 * Counts are exact: every published product is loaded for this page, so a
 * count here is a count of what clicking will actually show. No estimate and
 * no "1,000+" — pass 6 established that rule for the catalog and it holds.
 *
 * A category with nothing in it and no subcategories is dropped. A menu entry
 * that always opens an empty page costs a customer the same wasted click every
 * visit, and there is nothing behind it to fix by browsing.
 */
export function buildBrowseMenu(options: {
  categories: readonly CategoryRow[];
  products: readonly BrowseProduct[];
  activeCategoryId: string | null;
  filterQuery?: string;
}): BrowseMenu {
  const { categories, products, activeCategoryId } = options;
  const suffix = options.filterQuery ?? "";

  const visible = categories.filter((row) => row.is_active && !row.archived_at);
  const byId = new Map(visible.map((row) => [row.id, row]));

  const direct = new Map<string, number>();
  for (const product of products) {
    const id = product.category_id;
    if (!id || !byId.has(id)) continue;
    direct.set(id, (direct.get(id) ?? 0) + 1);
  }

  const order = (a: CategoryRow, b: CategoryRow) =>
    a.display_order - b.display_order || a.name.localeCompare(b.name);

  const parents = visible.filter((row) => !row.parent_id).sort(order);
  const active = activeCategoryId ? byId.get(activeCategoryId) ?? null : null;
  const activeParentId = active ? active.parent_id ?? active.id : null;

  const entries: BrowseEntry[] = [];
  for (const parent of parents) {
    const children = visible.filter((row) => row.parent_id === parent.id).sort(order);
    const count =
      (direct.get(parent.id) ?? 0) + children.reduce((total, child) => total + (direct.get(child.id) ?? 0), 0);
    if (count === 0) continue;

    entries.push({
      id: parent.id,
      name: parent.name,
      slug: parent.slug,
      href: `/catalog/${parent.slug}${suffix}`,
      count,
      isActive: active?.id === parent.id,
      isCurrentBranch: activeParentId === parent.id,
      children: children
        .filter((child) => (direct.get(child.id) ?? 0) > 0)
        .map((child) => ({
          id: child.id,
          name: child.name,
          slug: child.slug,
          href: `/catalog/${parent.slug}/${child.slug}${suffix}`,
          count: direct.get(child.id) ?? 0,
          isActive: active?.id === child.id,
        })),
    });
  }

  const trail: CategoryRow[] = [];
  if (active) {
    if (active.parent_id) {
      const parent = byId.get(active.parent_id);
      if (parent) trail.push(parent);
    }
    trail.push(active);
  }

  return {
    all: {
      id: null,
      name: "All products",
      slug: null,
      href: `/catalog${suffix}`,
      count: products.length,
      isActive: activeCategoryId === null,
      isCurrentBranch: activeCategoryId === null,
      children: [],
    },
    categories: entries,
    trail,
  };
}

/**
 * The category a two-segment path names, or `null` when the path is not one.
 *
 * Both segments are checked against the actual tree rather than only the
 * second, so `/catalog/exterior/shift-knobs` 404s when *shift-knobs* is a
 * subcategory of *interior*. Accepting it would give one page two addresses
 * and put a wrong parent in the breadcrumb.
 */
export function resolveCategoryPath(
  segments: readonly string[],
  categories: readonly CategoryRow[]
): CategoryRow | null {
  const visible = categories.filter((row) => row.is_active && !row.archived_at);
  const [first, second] = segments;
  if (!first) return null;

  const parent = visible.find((row) => row.slug === first && !row.parent_id);
  if (!parent) return null;
  if (!second) return parent;

  const child = visible.find((row) => row.slug === second && row.parent_id === parent.id);
  return child ?? null;
}

/**
 * The products a category page is about: the category itself plus, for a
 * top-level category, everything in its subcategories.
 *
 * "Show me Interior" means the whole department, not the handful of products
 * that happen not to have been filed into a subcategory yet.
 */
export function productsInCategory<T extends BrowseProduct>(
  products: readonly T[],
  categoryId: string,
  categories: readonly CategoryRow[]
): T[] {
  const ids = new Set<string>([categoryId]);
  for (const row of categories) if (row.parent_id === categoryId) ids.add(row.id);
  return products.filter((product) => product.category_id && ids.has(product.category_id));
}

/** The canonical path for a category, used for `alternates.canonical`. */
export function categoryPath(category: CategoryRow, categories: readonly CategoryRow[]): string {
  if (!category.parent_id) return `/catalog/${category.slug}`;
  const parent = categories.find((row) => row.id === category.parent_id);
  return parent ? `/catalog/${parent.slug}/${category.slug}` : `/catalog/${category.slug}`;
}

/**
 * Where a legacy `?category=` link should land.
 *
 * The breadcrumb, the footer and anything already shared point at
 * `/catalog?category=Interior` — matched by *name*, which is what those links
 * carry. They keep working and are redirected to the real category page, so
 * one view does not end up with two indexable URLs.
 */
export function legacyCategoryTarget(
  requested: string | null | undefined,
  categories: readonly CategoryRow[]
): CategoryRow | null {
  const term = requested?.trim().toLowerCase();
  if (!term) return null;
  const visible = categories.filter((row) => row.is_active && !row.archived_at);
  return (
    visible.find((row) => row.name.trim().toLowerCase() === term) ??
    visible.find((row) => row.slug === term) ??
    null
  );
}
