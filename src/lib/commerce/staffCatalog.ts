import type { CatalogProduct } from "../commerceTypes.ts";
import { categoryScopeIds, type CategoryRow } from "./categories.ts";

export type StaffProductStatus = "all" | "active" | "draft" | "hidden";
export type StaffStockFilter = "all" | "in_stock" | "low_stock" | "out_of_stock";
export type StaffProductSort = "newest" | "oldest" | "name" | "price_asc" | "price_desc" | "inventory" | "manual";

export type StaffCatalogFilters = {
  query: string;
  status: StaffProductStatus;
  stock: StaffStockFilter;
  categoryId: string | null;
  customizableOnly: boolean;
  sort: StaffProductSort;
};

/** A single lifecycle interpretation for every staff catalog surface. */
export function staffProductStatus(product: CatalogProduct): Exclude<StaffProductStatus, "all"> {
  if (product.archived_at) return "hidden";
  return product.is_published ? "active" : "draft";
}

export function staffStockState(product: CatalogProduct): Exclude<StaffStockFilter, "all"> | "unlimited" {
  if (product.inventory_policy !== "track") return "unlimited";
  if (product.inventory_quantity <= 0) return "out_of_stock";
  if (product.inventory_quantity <= product.low_stock_threshold) return "low_stock";
  return "in_stock";
}

/**
 * Small-catalog list policy. The storefront and staff list currently load the
 * complete catalog for exact category counts; keeping the policy pure makes a
 * later paginated API use the same semantics instead of reimplementing them.
 */
export function filterAndSortStaffProducts(
  products: readonly CatalogProduct[],
  categories: readonly CategoryRow[],
  filters: StaffCatalogFilters
): CatalogProduct[] {
  const term = filters.query.trim().toLocaleLowerCase();
  const categoryIds = filters.categoryId ? new Set(categoryScopeIds(filters.categoryId, categories)) : null;

  const result = products.filter((product) => {
    if (term && ![product.name, product.slug, product.sku].some((value) => value?.toLocaleLowerCase().includes(term))) return false;
    if (filters.status !== "all" && staffProductStatus(product) !== filters.status) return false;
    if (categoryIds && (!product.category_id || !categoryIds.has(product.category_id))) return false;
    if (filters.customizableOnly && !product.is_custom) return false;
    if (filters.stock !== "all") {
      const stock = staffStockState(product);
      if (filters.stock === "in_stock" ? !["in_stock", "unlimited"].includes(stock) : stock !== filters.stock) return false;
    }
    return true;
  });

  const created = (product: CatalogProduct) => Date.parse(product.created_at ?? "") || 0;
  return result.sort((a, b) => {
    switch (filters.sort) {
      case "oldest": return created(a) - created(b);
      case "name": return a.name.localeCompare(b.name);
      case "price_asc": return (a.starting_price_cents ?? Number.MAX_SAFE_INTEGER) - (b.starting_price_cents ?? Number.MAX_SAFE_INTEGER);
      case "price_desc": return (b.starting_price_cents ?? -1) - (a.starting_price_cents ?? -1);
      case "inventory": return a.inventory_quantity - b.inventory_quantity || a.name.localeCompare(b.name);
      case "manual": return a.sort_order - b.sort_order || created(b) - created(a);
      default: return created(b) - created(a);
    }
  });
}
