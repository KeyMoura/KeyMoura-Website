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
  for (const expected of ["Inventory mode", "Low-stock threshold", "Duplicate", "Archive", "Search products or SKU", "publishChecks", "Set cover"]) {
    assert.ok(editor.includes(expected), `missing editor control: ${expected}`);
  }
  assert.match(editor, /disabled=\{Boolean\(draft\.archived_at\) \|\| \(!draft\.is_published && !readyToPublish\)\}/);
});

test("the product editor is tabbed rather than seven stacked cards", () => {
  /*
   * Editing a SKU and editing package dimensions used to be the same scroll:
   * one column of seven `ui-card`s, in an order nobody chose. Each decision now
   * has a tab, and the publish checklist sits in the record header where it
   * describes the product rather than being the first of the seven cards.
   */
  for (const id of [
    "basic",
    "media",
    "pricing",
    "purchase",
    "inventory",
    "shipping",
    "content",
    "seo",
    "advanced",
  ]) {
    assert.match(editor, new RegExp(`<TabPanel id="${id}"`), `no panel for the ${id} tab`);
  }
  // Each unfinished checklist item names the tab that fixes it, rather than
  // saying "Product image" and leaving you to find where images are set.
  assert.match(editor, /tab: "media"/);
  assert.match(editor, /onClick=\{\(\) => setTab\(check\.tab\)\}/);
});

test("an unexpected purchase mode does not take the whole editor down", () => {
  /*
   * Found by driving the rebuilt editor in a browser: selecting a product whose
   * `purchase_mode` this build does not know threw on
   * `PURCHASE_MODE_COPY[mode].help` and white-screened the entire page — not one
   * field, the editor. A CHECK constraint means the column cannot hold a
   * surprise today, but the product editor is exactly where a row written by an
   * older build gets opened, and losing the editor is a much worse failure than
   * losing one label.
   */
  assert.match(editor, /const purchaseMode: PurchaseMode = PURCHASE_MODES\.includes/);
  // Every read goes through the narrowed value, so a new call site cannot
  // reintroduce the unguarded lookup.
  assert.doesNotMatch(editor, /PURCHASE_MODE_COPY\[draft\.purchase_mode/);
  assert.match(editor, /PURCHASE_MODE_COPY\[purchaseMode\]\.help/);
});

test("catalog editing uses one page-level save action", () => {
  assert.match(editor, /saveAllChanges/);
  assert.match(editor, /All catalog changes saved/);
  // Exactly one control invokes the save, and it is the shared save bar.
  assert.equal((editor.match(/saveAllChanges\(\)\}/g) ?? []).length, 1);
  assert.match(editor, /<SaveBar/);
  for (const removedLabel of [">Save product</button>", ">Save option</button>", ">Save</button>"]) {
    assert.ok(!editor.includes(removedLabel), `unexpected extra save control: ${removedLabel}`);
  }
});

test("backordered products are not labeled out of stock", async () => {
  const { inventoryLabel } = await import("../src/lib/commerceTypes.ts");
  assert.equal(inventoryLabel({ inventory_policy:"track", inventory_quantity:0, low_stock_threshold:2, continue_selling_when_out_of_stock:true }), "Available to order");
});

test("storefront and order API enforce catalog availability", () => {
  // Availability now renders through the shared product card.
  const card = readFileSync("src/components/ProductCard.tsx", "utf8");
  assert.match(card, /productCanBeRequested/);
  assert.match(card, /availabilityLabel/);
  // The catalog query and the grid moved out of the page when category routes
  // arrived: every catalog surface — /catalog, /catalog/[category] and
  // /catalog/[category]/[subcategory] — now shares one loader and one grid.
  // Asserting them where they live is what keeps all three covered instead of
  // one.
  assert.match(readFileSync("src/components/catalog/CatalogBrowser.tsx", "utf8"), /ProductCard/);
  assert.match(readFileSync("src/lib/commerce/catalogData.ts", "utf8"), /\.is\("archived_at", null\)/);
  assert.match(storefront, /loadCatalogData/, "the page must still load through that shared loader");
  assert.match(orderRoute, /inventory_quantity < quantity/);
  assert.match(orderRoute, /product\.archived_at/);
});
