import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { categoryOptions } from "../src/components/staff/CategorySelect.tsx";
import { UNCATEGORIZED_LABEL, type CategoryRow } from "../src/lib/commerce/categories.ts";

/**
 * Choosing a product's category from the real ones.
 *
 * The editor already had a picker; **creating** a product did not — it had a
 * free-text box that wrote the legacy `category` string and left the structured
 * `category_id` null. So a product could be created under "Interor", belong to
 * no category the storefront knows about, and look filed to whoever typed it.
 *
 * The second defect these cover is quieter: the picker was handed a
 * pre-filtered list of *active* categories, so a product filed under a category
 * archived afterwards displayed "Uncategorized" — and the save derived the text
 * column from a lookup that now missed, writing `category: null` on the next
 * save of any unrelated field.
 */

const read = (path: string) => readFileSync(path, "utf8");
const editor = read("src/app/staff/catalog/page.tsx");
const picker = read("src/components/staff/CategorySelect.tsx");

const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const row = (over: Partial<CategoryRow> & { id: string; name: string }): CategoryRow => ({
  slug: over.name.toLowerCase(),
  description: null,
  parent_id: null,
  image_url: null,
  display_order: 0,
  is_active: true,
  archived_at: null,
  ...over,
});

const interior = row({ id: "c-interior", name: "Interior" });
const knobs = row({ id: "c-knobs", name: "Knobs", parent_id: "c-interior" });
const exterior = row({ id: "c-exterior", name: "Exterior", display_order: 1 });
const archived = row({ id: "c-old", name: "Old line", archived_at: "2026-01-01T00:00:00Z" });
const disabled = row({ id: "c-off", name: "Switched off", is_active: false });
const all = [interior, knobs, exterior, archived, disabled];

test("the list is the real categories, with hierarchy", () => {
  const options = categoryOptions(all);
  assert.deepEqual(
    options.map((option) => [option.label, option.depth]),
    [
      [UNCATEGORIZED_LABEL, 0],
      ["Interior", 0],
      ["Knobs", 1],
      ["Exterior", 0],
    ]
  );
  // The subcategory names its parent, so "Knobs" is never ambiguous.
  assert.equal(options.find((option) => option.label === "Knobs")?.parentLabel, "Interior");
});

test("archived and switched-off categories cannot be picked", () => {
  const ids = categoryOptions(all).map((option) => option.id);
  assert.ok(!ids.includes("c-old"));
  assert.ok(!ids.includes("c-off"));
});

test("clearing the category is an offered choice, not an empty string", () => {
  const [first] = categoryOptions(all);
  assert.equal(first.id, null);
  assert.equal(first.label, UNCATEGORIZED_LABEL);
});

test("a product filed under an archived category still shows what it is filed under", () => {
  const options = categoryOptions(all, undefined, "c-old");
  const current = options.find((option) => option.id === "c-old");
  assert.ok(current, "the stored category must appear or the picker misreports the record");
  assert.equal(current.label, "Old line");
  assert.equal(current.retired, true);
  // And it is still the only one flagged — the usable ones are not tainted.
  assert.deepEqual(options.filter((option) => option.retired).map((option) => option.id), ["c-old"]);
});

test("an archived subcategory keeps its parent trail", () => {
  const archivedChild = row({
    id: "c-old-child",
    name: "Old knobs",
    parent_id: "c-interior",
    archived_at: "2026-01-01T00:00:00Z",
  });
  const options = categoryOptions([...all, archivedChild], undefined, "c-old-child");
  const current = options.find((option) => option.id === "c-old-child");
  assert.equal(current?.parentLabel, "Interior");
  assert.equal(current?.depth, 1);
});

test("a stored category that no longer exists adds nothing", () => {
  const options = categoryOptions(all, undefined, "c-deleted");
  assert.ok(!options.some((option) => option.id === "c-deleted"));
  assert.ok(!options.some((option) => option.retired));
});

test("product counts ride along without changing the shape", () => {
  const counts = new Map([["c-interior", 4]]);
  const options = categoryOptions(all, counts);
  assert.equal(options.length, 4);
});

test("creating a product picks a category instead of typing one", () => {
  const body = code(editor);
  assert.ok(
    !/<input name="category"/.test(body),
    "the free-text category box is what this pass removed"
  );
  assert.ok(!/form\.get\("category"\)/.test(body), "the create form must not read a typed category");
  // One picker component, used by both the create form and the editor.
  const pickers = body.match(/<CategorySelect/g) ?? [];
  assert.equal(pickers.length, 2, "create and edit must use the same control");
});

test("the create insert writes the id and derives the legacy text from it", () => {
  const body = code(editor);
  assert.match(body, /category_id: newCategoryId/);
  assert.match(body, /category: categories\.find\(row => row\.id === newCategoryId\)\?\.name \?\? null/);
});

test("the editor holds every category row, so an archived one still resolves", () => {
  const body = code(editor);
  assert.ok(
    !/setCategories\(visibleCategories\(/.test(body),
    "pre-filtering here is what made an archived assignment read as Uncategorized"
  );
  assert.match(body, /setCategories\(\(categoryRows \?\? \[\]\) as CategoryRow\[\]\)/);
});

test("both surfaces link to where categories are managed", () => {
  const links = editor.match(/href="\/staff\/catalog\/categories"/g) ?? [];
  assert.ok(links.length >= 2, "create and edit should each offer Manage categories →");
  assert.ok(editor.includes("Manage categories →"));
});

test("the picker is not a label wrapping a button, and names itself once", () => {
  // `Field` is a <label>; a listbox trigger inside one is activated by clicking
  // the caption, and the word appeared twice.
  assert.ok(!/<Field label="Category">/.test(editor));
  assert.match(picker, /<div className="ui-field"/);
  assert.match(picker, /aria-labelledby=\{`\$\{listId\}-label \$\{listId\}-value`\}/);
});

test("the picker is disabled for staff who cannot manage the catalog", () => {
  assert.match(editor, /disabled=\{!canManage\}/);
});

test("the database is the thing that refuses an invented category", () => {
  // Not asserted from the client: `products.category_id` carries a foreign key
  // to `product_categories(id)` with ON DELETE SET NULL, so a fabricated id is
  // rejected by Postgres regardless of what any UI sends. This test pins the
  // migration that establishes it, so removing the constraint fails here.
  const migration = read("supabase/migrations/20260802020000_product_categories.sql");
  assert.match(migration, /references public\.product_categories\s*\(id\)\s*on delete set null/i);
});
