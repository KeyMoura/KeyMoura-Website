/**
 * The rules behind the storefront search box.
 *
 * Pure and dependency-free so the API route, the input component and the tests
 * all agree on what a query means and how many answers it may produce.
 */

import type { StorefrontNavCategory } from "@/lib/commerce/storefrontNavModel";

export const SUGGEST_LIMITS = {
  /** Below this, a prefix names most of the catalog rather than a product. */
  minQueryLength: 2,
  /** Bounded on the server, not trimmed in the browser after fetching more. */
  products: 5,
  categories: 3,
  /**
   * Fewer than products, deliberately. In the All scope the panel shows three
   * groups at once, and a list that needs scrolling on the first keystroke is a
   * list nobody reads to the bottom of. A Projects-scoped search is the place
   * to see all of them, and it is one keypress away.
   */
  projects: 4,
  /** The longest query the catalog will accept, matching `parseCatalogFilters`. */
  maxLength: 80,
} as const;

/**
 * A typed query, normalized just enough to be forgiving and no further.
 *
 * Three transformations, each of which fixes a real miss and none of which can
 * change what the customer meant:
 *
 *   - trimmed, because a trailing space from a paste is not a search term;
 *   - collapsed whitespace, because "shift  knob" is one query, not two;
 *   - hyphens and underscores treated as spaces, so "shift-knob" finds
 *     "Shift Knob" — the way part numbers and slugs are habitually typed.
 *
 * Case is handled by `ilike` on the server rather than here, so the string the
 * customer sees echoed back is the string they typed.
 *
 * Deliberately *not* done: stemming, synonyms, and edit-distance matching.
 * Those need an index and a ranking function to be better than nothing, and a
 * half-built version that silently returns the wrong product is worse than one
 * that returns none. Recorded as deferred.
 */
export function normalizeSuggestQuery(raw: string | null | undefined): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[-_]+/g, " ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, SUGGEST_LIMITS.maxLength);
}

/** The query as it should be written into `/catalog?q=`. */
export function catalogSearchHref(raw: string): string {
  const query = normalizeSuggestQuery(raw);
  return query ? `/catalog?q=${encodeURIComponent(query)}` : "/catalog";
}

export type CategorySuggestion = {
  name: string;
  href: string;
  /** "Interior / Shift Knobs", so a subcategory is never shown bare. */
  trail: string;
  count: number;
};

/**
 * One category and its children, as a list `rankCategorySuggestions` can walk.
 *
 * A child slug resolves to just that child with no children of its own, which
 * is correct rather than a simplification: the hierarchy is two deep, so a
 * subcategory has nothing beneath it to include.
 */
export function categorySubtree(
  categories: readonly StorefrontNavCategory[],
  slug: string
): StorefrontNavCategory[] {
  for (const category of categories) {
    if (category.slug === slug) return [category];
    for (const child of category.children) {
      if (child.slug === slug) return [{ ...child, children: [] }];
    }
  }
  return [];
}

/**
 * Categories whose name contains the query, parents before children.
 *
 * Matched in memory against the navigation menu that is already loaded and
 * cached rather than with a second database query: there are four categories,
 * and a round trip to filter four rows is a round trip spent badly.
 *
 * A parent outranks its own children so that typing "interior" offers the
 * department before the shelf, and a whole-word prefix outranks a match buried
 * mid-word so "board" prefers "Cutting Boards" over anything merely containing
 * the letters.
 */
export function rankCategorySuggestions(
  categories: readonly StorefrontNavCategory[],
  query: string,
  /**
   * Restrict the answer to one category and its children.
   *
   * Passed when the box is scoped to a category: inside "Interior", the other
   * departments are not near-misses, they are the wrong answer — the brief's
   * rule that a scoped search must not still surface irrelevant groups. Left
   * undefined, every category is a candidate, which is the unscoped behaviour
   * this function has always had.
   */
  subtreeSlug?: string | null
): CategorySuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const searched = subtreeSlug ? categorySubtree(categories, subtreeSlug) : categories;
  if (!searched.length) return [];

  const scored: { suggestion: CategorySuggestion; score: number }[] = [];

  const score = (name: string, depth: number): number | null => {
    const lower = name.toLowerCase();
    const at = lower.indexOf(needle);
    if (at < 0) return null;
    // Starts-with beats contains; a parent beats its children.
    return (at === 0 ? 100 : 50) - depth * 10 - Math.min(at, 20);
  };

  for (const category of searched) {
    const parentScore = score(category.name, 0);
    if (parentScore !== null) {
      scored.push({
        suggestion: { name: category.name, href: category.href, trail: category.name, count: category.count },
        score: parentScore,
      });
    }

    for (const child of category.children) {
      const childScore = score(child.name, 1);
      if (childScore === null) continue;
      scored.push({
        suggestion: {
          name: child.name,
          href: child.href,
          trail: `${category.name} / ${child.name}`,
          count: child.count,
        },
        score: childScore,
      });
    }
  }

  return scored
    .sort((left, right) => right.score - left.score || left.suggestion.trail.localeCompare(right.suggestion.trail))
    .slice(0, SUGGEST_LIMITS.categories)
    .map((entry) => entry.suggestion);
}

export type SuggestProduct = {
  id: string;
  name: string;
  slug: string;
  category: string | null;
  image: string | null;
  price: string;
};

/**
 * A project write-up under `/projects`.
 *
 * No category field, deliberately. A project's `category` column holds a slug,
 * and the display names for those slugs are declared inline in four different
 * `/projects` files — so putting a name on this row would mean either a fifth
 * copy of that list or a slug rendered at a customer. The row carries its kind
 * ("Project") instead, which is the fact that actually distinguishes it from
 * the product above it in the same panel.
 */
export type SuggestProject = {
  id: string;
  title: string;
  slug: string;
};

export type SuggestResponse = {
  query: string;
  /** Echoed back, so a response for a scope the box has since left is discardable. */
  scope: string;
  products: SuggestProduct[];
  categories: CategorySuggestion[];
  projects: SuggestProject[];
  error?: boolean;
};

/**
 * Every selectable row, in the order the panel draws them.
 *
 * The arrow keys, `aria-activedescendant` and the Enter-with-a-selection path
 * all index into this, so it is derived here once rather than by three
 * different pieces of arithmetic in the component — which is what the old
 * `index - results.products.length` offset was, and it only stayed correct
 * while there were exactly two groups.
 */
export type SuggestRow =
  | { kind: "product"; href: string; product: SuggestProduct }
  | { kind: "category"; href: string; category: CategorySuggestion }
  | { kind: "project"; href: string; project: SuggestProject };

export function suggestionRows(response: SuggestResponse | null): SuggestRow[] {
  if (!response) return [];
  /*
   * Every group defaulted, including the ones the type says are always there.
   *
   * The suggest route is `revalidate = 60`, so for up to a minute after a
   * deploy the browser can be handed a *cached response from the previous
   * build* — one with no `projects` key, because that group did not exist yet.
   * The type is right about what the current server returns and wrong about
   * what a client can receive, and `.map` on the missing key is a crash in the
   * search panel on every keystroke until the cache turns over.
   */
  const products = response.products ?? [];
  const categories = response.categories ?? [];
  const projects = response.projects ?? [];

  return [
    ...products.map((product): SuggestRow => ({
      kind: "product",
      href: `/catalog/${product.slug}`,
      product,
    })),
    ...categories.map((category): SuggestRow => ({
      kind: "category",
      href: category.href,
      category,
    })),
    ...projects.map((project): SuggestRow => ({
      kind: "project",
      href: `/projects/${project.slug}`,
      project,
    })),
  ];
}

/** Total selectable rows, for the arrow keys and `aria-activedescendant`. */
export function suggestionCount(response: SuggestResponse | null): number {
  return suggestionRows(response).length;
}
