import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync("supabase/migrations/20260731180000_catalog_inventory_editor.sql", "utf8");
const editor = readFileSync("src/app/staff/catalog/page.tsx", "utf8");
const storefront = readFileSync("src/app/catalog/page.tsx", "utf8");
const orderRoute = readFileSync("src/app/api/orders/route.ts", "utf8");

test("catalog inventory migration is constrained and hides archived products", () => {
  assert.match(migration, /inventory_policy in \('unlimited', 'track'\)/);
  assert.match(migration, /inventory_quantity >= 0/);
  assert.match(migration, /is_published and archived_at is null/);
  assert.match(migration, /unique index if not exists products_sku_unique_idx/);
});

test("staff editor includes inventory, lifecycle, duplication, and search tools", () => {
  for (const expected of ["Inventory mode", "Low-stock warning", "Duplicate", "Archive", "Search products or SKU", "Publish checklist", "Save changes", "Set cover"]) {
    assert.ok(editor.includes(expected), `missing editor control: ${expected}`);
  }
  assert.match(editor, /disabled=\{Boolean\(draft\.archived_at\) \|\| \(!draft\.is_published && !readyToPublish\)\}/);
});

test("backordered products are not labeled out of stock", async () => {
  const { inventoryLabel } = await import("../src/lib/commerceTypes.ts");
  assert.equal(inventoryLabel({ inventory_policy:"track", inventory_quantity:0, low_stock_threshold:2, continue_selling_when_out_of_stock:true }), "Available to order");
});

test("storefront and order API enforce catalog availability", () => {
  assert.match(storefront, /productCanBeRequested/);
  assert.match(storefront, /\.is\("archived_at", null\)/);
  assert.match(orderRoute, /inventory_quantity < quantity/);
  assert.match(orderRoute, /product\.archived_at/);
});
