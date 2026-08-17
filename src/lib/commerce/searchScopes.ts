/**
 * What the navbar's search box is currently searching *in*.
 *
 * ## Why a scope exists at all
 *
 * The global search had one destination: `/catalog?q=…`. That is correct for a
 * shop and wrong for this shop, which sells two things — catalog products and
 * custom work — and publishes a third, the project write-ups under `/projects`
 * that are most of what it actually makes. A customer typing "cnc" into the
 * only search box on the site got products and nothing else, and the Gallery,
 * which is where "cnc" mostly lives, was unreachable by search.
 *
 * ## The scopes are the site's own hierarchy, not a copied list
 *
 * `buildSearchScopes` takes the **same `StorefrontNav`** the Products dropdown
 * is drawn from, which `loadStorefrontNav` builds with `buildBrowseMenu` — the
 * same function the catalog rail and the mobile filter drawer call. So a scope
 * cannot name a category the catalog would not, order them differently, or
 * point at a slug that 404s. There is no second list of categories anywhere in
 * this file, which is the whole reason it takes the nav as an argument rather
 * than importing anything that loads one.
 *
 * A category that has been emptied disappears from the dropdown for the same
 * reason it disappears from the Products menu: `buildBrowseMenu` drops it.
 *
 * ## Where Enter goes
 *
 * Every scope resolves to a URL that already exists and already reads `?q=`:
 * the catalog's own filter parser handles `/catalog` and every category route
 * beneath it, and `/projects` has read `?q=` into its chip search since it was
 * built. Nothing here needed a new page, and deliberately so — an aggregate
 * `/search` route would be a fourth place for results to be ranked differently.
 *
 * The one honest gap is **All**. There is no page on this site that lists
 * products and projects together, so All's Enter goes to the catalog, exactly
 * as the unscoped box did before this pass. What All adds is that its
 * *suggestions* span both, and its panel offers a labelled way into each — so
 * the customer who wanted a project sees one and picks it, rather than being
 * silently given products. Inventing a combined results page to close the last
 * of that gap was judged the larger change, and is recorded as deferred.
 */

import type { StorefrontNav, StorefrontNavCategory } from "@/lib/commerce/storefrontNavModel";
import { catalogSearchHref, normalizeSuggestQuery } from "@/lib/commerce/catalogSuggest";

export type SearchScopeKind = "all" | "products" | "category" | "projects";

export type SearchScope = {
  /** Stable, and what travels in the component's state. */
  id: string;
  kind: SearchScopeKind;
  /** What the dropdown shows. Indented children are handled by `depth`. */
  label: string;
  /** Nesting in the dropdown: 0 for a scope, 1 for a subcategory. */
  depth: 0 | 1;
  /** The route this scope searches, without a query string. */
  basePath: string;
};

export const ALL_SCOPE: SearchScope = {
  id: "all",
  kind: "all",
  label: "All",
  depth: 0,
  basePath: "/catalog",
};

const PRODUCTS_SCOPE: SearchScope = {
  id: "products",
  kind: "products",
  label: "Products",
  depth: 0,
  basePath: "/catalog",
};

const PROJECTS_SCOPE: SearchScope = {
  id: "projects",
  kind: "projects",
  label: "Projects",
  depth: 0,
  basePath: "/projects",
};

/**
 * How many category scopes the dropdown will offer.
 *
 * The catalog has four today and this is not a limit anyone will meet, but a
 * `<select>` built from a database table needs a ceiling or it is a rendering
 * bug waiting for the shop to grow. Past this the dropdown keeps the top-level
 * scopes and drops the deep ones, which degrades to the high-level version of
 * this feature rather than to a broken control.
 */
export const MAX_CATEGORY_SCOPES = 24;

export function categoryScopeId(slug: string): string {
  return `category:${slug}`;
}

/** The slug a category scope names, or null for any other scope. */
export function scopeCategorySlug(id: string): string | null {
  return id.startsWith("category:") ? id.slice("category:".length) || null : null;
}

/**
 * Every scope the box can be set to, in dropdown order.
 *
 * All, Products, the catalog's own categories indented under it, then Projects.
 * Projects sits last rather than beside Products because the pair above it is
 * one hierarchy — putting a second top-level scope in the middle of a category
 * list reads as another category.
 */
export function buildSearchScopes(nav: StorefrontNav): SearchScope[] {
  const scopes: SearchScope[] = [ALL_SCOPE, PRODUCTS_SCOPE];

  const push = (category: StorefrontNavCategory | StorefrontNav["categories"][number]["children"][number], depth: 0 | 1) => {
    if (!category.slug) return;
    if (scopes.filter((scope) => scope.kind === "category").length >= MAX_CATEGORY_SCOPES) return;
    scopes.push({
      id: categoryScopeId(category.slug),
      kind: "category",
      label: category.name,
      depth,
      basePath: category.href,
    });
  };

  for (const category of nav.categories) {
    push(category, 0);
    for (const child of category.children) push(child, 1);
  }

  scopes.push(PROJECTS_SCOPE);
  return scopes;
}

/** The scope with this id, or All when the id names nothing (a stale bookmark). */
export function resolveScope(scopes: readonly SearchScope[], id: string): SearchScope {
  return scopes.find((scope) => scope.id === id) ?? ALL_SCOPE;
}

/**
 * Which result groups a scope is allowed to show.
 *
 * The rule the brief asked for — a scoped search must not still surface
 * irrelevant groups — expressed once, so the API and the panel cannot disagree
 * about it. A category scope keeps the Categories group because the category
 * itself and its children are legitimate answers to a query inside it; it is
 * the *other* categories that are filtered out, and that happens where the
 * subtree is known.
 */
export function scopeGroups(scope: SearchScope): {
  products: boolean;
  categories: boolean;
  projects: boolean;
} {
  switch (scope.kind) {
    case "all":
      return { products: true, categories: true, projects: true };
    case "products":
    case "category":
      return { products: true, categories: true, projects: false };
    case "projects":
      return { products: false, categories: false, projects: true };
  }
}

/** Where Enter goes, with nothing highlighted in the suggestion list. */
export function searchDestination(scope: SearchScope, raw: string): string {
  const query = normalizeSuggestQuery(raw);

  if (scope.kind === "projects") {
    return query ? `/projects?q=${encodeURIComponent(query)}` : "/projects";
  }
  // `/catalog` and every category route under it are parsed by the same
  // `parseCatalogFilters`, so one shape covers both.
  if (scope.kind === "category") {
    return query ? `${scope.basePath}?q=${encodeURIComponent(query)}` : scope.basePath;
  }
  return catalogSearchHref(raw);
}

/** The projects destination, offered alongside the catalog one in All scope. */
export function projectsDestination(raw: string): string {
  const query = normalizeSuggestQuery(raw);
  return query ? `/projects?q=${encodeURIComponent(query)}` : "/projects";
}

/**
 * The word for the thing being searched, for a placeholder and a label.
 *
 * "Search Interior…" rather than "Search products…" is the whole affordance:
 * a scope the customer cannot see in the box is a scope they will forget they
 * set, and then the box looks broken.
 */
export function scopePlaceholder(scope: SearchScope): string {
  switch (scope.kind) {
    case "all":
      return "Search products and projects…";
    case "products":
      return "Search products…";
    case "projects":
      return "Search projects…";
    case "category":
      return `Search ${scope.label}…`;
  }
}

/** The accessible name for the search landmark and its input. */
export function scopeSearchLabel(scope: SearchScope): string {
  switch (scope.kind) {
    case "all":
      return "Search products and projects";
    case "products":
      return "Search products";
    case "projects":
      return "Search projects";
    case "category":
      return `Search products in ${scope.label}`;
  }
}
