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
  query: string
): CategorySuggestion[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const scored: { suggestion: CategorySuggestion; score: number }[] = [];

  const score = (name: string, depth: number): number | null => {
    const lower = name.toLowerCase();
    const at = lower.indexOf(needle);
    if (at < 0) return null;
    // Starts-with beats contains; a parent beats its children.
    return (at === 0 ? 100 : 50) - depth * 10 - Math.min(at, 20);
  };

  for (const category of categories) {
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

export type SuggestResponse = {
  query: string;
  products: SuggestProduct[];
  categories: CategorySuggestion[];
  error?: boolean;
};

/** Total selectable rows, for the arrow keys and `aria-activedescendant`. */
export function suggestionCount(response: SuggestResponse | null): number {
  if (!response) return 0;
  return response.products.length + response.categories.length;
}
