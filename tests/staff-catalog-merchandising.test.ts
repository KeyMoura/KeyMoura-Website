import assert from "node:assert/strict";
import test from "node:test";
import type { CatalogProduct } from "../src/lib/commerceTypes.ts";
import type { CategoryRow } from "../src/lib/commerce/categories.ts";
import {
  filterAndSortStaffProducts,
  staffProductStatus,
  staffStockState,
  type StaffCatalogFilters,
} from "../src/lib/commerce/staffCatalog.ts";

const categories: CategoryRow[] = [
  { id: "interior", name: "Interior", slug: "interior", description: null, parent_id: null, image_url: null, display_order: 0, is_active: true, archived_at: null },
  { id: "knobs", name: "Shift knobs", slug: "shift-knobs", description: null, parent_id: "interior", image_url: null, display_order: 0, is_active: true, archived_at: null },
  { id: "exterior", name: "Exterior", slug: "exterior", description: null, parent_id: null, image_url: null, display_order: 1, is_active: true, archived_at: null },
];

const product = (over: Partial<CatalogProduct> & Pick<CatalogProduct, "id" | "name" | "slug">): CatalogProduct => ({
  short_description: null, description: null, image_url: null, model_url: null, model_poster_url: null,
  category: null, category_id: null, purchase_mode: "direct_purchase", starting_price_cents: 1000,
  is_custom: false, is_published: true, sort_order: 0, availability_status: "available", lead_time_text: null,
  sku: null, inventory_policy: "track", inventory_quantity: 10, low_stock_threshold: 2,
  continue_selling_when_out_of_stock: false, archived_at: null, created_at: "2026-01-01T00:00:00Z",
  ...over,
});

const products = [
  product({ id: "knob", name: "Billet knob", slug: "billet-knob", sku: "KM-01", category_id: "knobs", is_custom: true, starting_price_cents: 4000, inventory_quantity: 1, created_at: "2026-03-01T00:00:00Z" }),
  product({ id: "badge", name: "Badge", slug: "badge", category_id: "exterior", inventory_quantity: 0, starting_price_cents: 2000 }),
  product({ id: "draft", name: "Draft trim", slug: "draft-trim", category_id: "interior", is_published: false, inventory_policy: "unlimited" }),
  product({ id: "old", name: "Old part", slug: "old-part", archived_at: "2026-04-01T00:00:00Z" }),
];

const defaults: StaffCatalogFilters = { query: "", status: "all", stock: "all", categoryId: null, customizableOnly: false, sort: "newest" };

test("staff product lifecycle has one clear active, draft, and hidden abstraction", () => {
  assert.equal(staffProductStatus(products[0]), "active");
  assert.equal(staffProductStatus(products[2]), "draft");
  assert.equal(staffProductStatus(products[3]), "hidden");
});

test("stock status uses the canonical product inventory fields", () => {
  assert.equal(staffStockState(products[0]), "low_stock");
  assert.equal(staffStockState(products[1]), "out_of_stock");
  assert.equal(staffStockState(products[2]), "unlimited");
});

test("staff search covers name, SKU, and slug and filters parent category descendants", () => {
  assert.deepEqual(filterAndSortStaffProducts(products, categories, { ...defaults, query: "KM-01" }).map(({ id }) => id), ["knob"]);
  assert.deepEqual(filterAndSortStaffProducts(products, categories, { ...defaults, categoryId: "interior" }).map(({ id }) => id), ["knob", "draft"]);
});

test("staff filters combine status, stock, and customization and sorts deterministically", () => {
  assert.deepEqual(filterAndSortStaffProducts(products, categories, { ...defaults, stock: "low_stock", customizableOnly: true }).map(({ id }) => id), ["knob"]);
  assert.deepEqual(filterAndSortStaffProducts(products, categories, { ...defaults, sort: "price_asc" }).map(({ id }) => id), ["draft", "old", "badge", "knob"]);
});
