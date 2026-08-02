/**
 * Category domain rules.
 *
 * The catalog supports a parent category and exactly one level of subcategory.
 * The database enforces that with a trigger; these helpers give the UI and the
 * API the same answers without a round trip, and keep slug generation
 * consistent between the backfill migration and anything created later.
 */

export type CategoryRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  parent_id: string | null;
  image_url: string | null;
  display_order: number;
  is_active: boolean;
  archived_at: string | null;
};

export type CategoryNode = CategoryRow & {
  children: CategoryRow[];
  /** Products directly in this category. */
  directProductCount: number;
  /** Products in this category and all of its subcategories. */
  totalProductCount: number;
};

export const CATEGORY_NAME_MAX = 80;
export const UNCATEGORIZED_LABEL = "Uncategorized";

/**
 * Slug generation, matching the backfill migration exactly so a category
 * created in the UI and one created by the migration cannot disagree.
 */
export function categorySlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "category";
}

export function uniqueCategorySlug(name: string, taken: readonly string[]): string {
  const base = categorySlug(name);
  const used = new Set(taken);
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

export function normalizeCategoryName(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, CATEGORY_NAME_MAX) : "";
}

export type CategoryNameProblem = "blank" | "duplicate" | null;

export function categoryNameProblem(
  value: unknown,
  siblings: readonly { id: string; name: string; parent_id: string | null }[],
  parentId: string | null,
  ignoreId?: string
): CategoryNameProblem {
  const name = normalizeCategoryName(value);
  if (!name) return "blank";
  const clash = siblings.some(
    (sibling) =>
      sibling.id !== ignoreId &&
      sibling.parent_id === parentId &&
      sibling.name.trim().toLowerCase() === name.toLowerCase()
  );
  return clash ? "duplicate" : null;
}

/**
 * Why a proposed parent is not allowed, or null when it is.
 *
 * Mirrors the database trigger so the UI can disable an impossible choice
 * rather than let the user discover it through a failed save.
 */
export function parentProblem(
  categoryId: string,
  proposedParentId: string | null,
  all: readonly CategoryRow[]
): string | null {
  if (!proposedParentId) return null;
  if (proposedParentId === categoryId) return "A category cannot be its own parent.";

  const parent = all.find((row) => row.id === proposedParentId);
  if (!parent) return "That parent category no longer exists.";
  if (parent.parent_id) return "Categories support one level of subcategory only.";

  const hasChildren = all.some((row) => row.parent_id === categoryId);
  if (hasChildren) return "Move or remove the subcategories first.";

  return null;
}

/**
 * Why a category cannot be deleted, or null when it can.
 *
 * Deletion is blocked while anything still points at the category, so products
 * can never be orphaned by a careless click. Archiving is the safe alternative
 * and stays available in every case.
 */
export function deletionProblem(
  category: CategoryRow,
  all: readonly CategoryRow[],
  directProductCount: number
): string | null {
  const children = all.filter((row) => row.parent_id === category.id);
  if (children.length > 0) {
    return `${children.length} subcategor${children.length === 1 ? "y" : "ies"} still belong to this category. Move or delete them first.`;
  }
  if (directProductCount > 0) {
    return `${directProductCount} product${directProductCount === 1 ? "" : "s"} still use this category. Reassign them, or archive this category instead.`;
  }
  return null;
}

/** Builds the two-level tree with rolled-up product counts. */
export function buildCategoryTree(
  rows: readonly CategoryRow[],
  productCounts: ReadonlyMap<string, number>
): CategoryNode[] {
  const parents = rows.filter((row) => !row.parent_id);
  const byParent = new Map<string, CategoryRow[]>();

  for (const row of rows) {
    if (!row.parent_id) continue;
    const list = byParent.get(row.parent_id);
    if (list) list.push(row);
    else byParent.set(row.parent_id, [row]);
  }

  const order = (a: CategoryRow, b: CategoryRow) =>
    a.display_order - b.display_order || a.name.localeCompare(b.name);

  return parents.sort(order).map((parent) => {
    const children = (byParent.get(parent.id) ?? []).sort(order);
    const directProductCount = productCounts.get(parent.id) ?? 0;
    const totalProductCount =
      directProductCount + children.reduce((total, child) => total + (productCounts.get(child.id) ?? 0), 0);
    return { ...parent, children, directProductCount, totalProductCount };
  });
}

/** The breadcrumb trail for a category, parent first. */
export function categoryTrail(categoryId: string | null, rows: readonly CategoryRow[]): CategoryRow[] {
  if (!categoryId) return [];
  const category = rows.find((row) => row.id === categoryId);
  if (!category) return [];
  if (!category.parent_id) return [category];
  const parent = rows.find((row) => row.id === category.parent_id);
  return parent ? [parent, category] : [category];
}

/** Category ids a listing should include: the category plus its subcategories. */
export function categoryScopeIds(categoryId: string, rows: readonly CategoryRow[]): string[] {
  const children = rows.filter((row) => row.parent_id === categoryId).map((row) => row.id);
  return [categoryId, ...children];
}

export function visibleCategories(rows: readonly CategoryRow[]): CategoryRow[] {
  return rows.filter((row) => row.is_active && !row.archived_at);
}
