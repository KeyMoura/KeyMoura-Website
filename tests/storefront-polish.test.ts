import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("homepage exposes featured products and custom-work guidance", () => { const page = read("src/app/page.tsx"); assert.match(page, /loadFeaturedProducts/); assert.match(page, /Start a custom project/); assert.match(page, /Common questions/); });
test("homepage covers what KeyMoura does, sells, and how custom work runs", () => {
  const page = read("src/app/page.tsx");
  // "Catalog" was the forum-era word for the shop. The homepage now says
  // Products, and the primary call to action is a custom project.
  for (const token of ["Capabilities", "Products", "How custom work happens", "Browse products", "Start a custom request"]) {
    assert.ok(page.includes(token), `homepage is missing: ${token}`);
  }
});
test("catalog supports discovery controls and clear empty states", () => {
  // Filtering moved into CatalogClient when /catalog became a server
  // component, and then into CatalogBrowser, which every category page shares.
  // "All categories" became a route rather than a dropdown value, so the
  // category list is asserted where it now lives: the browse menu.
  const client = read("src/components/catalog/CatalogBrowser.tsx");
  assert.match(client, /No products match/);
  // The search box became its own control in Commerce 3.0 — a labelled search
  // landmark with an icon, a submit and a clear, rather than a bare input that
  // looked like a staff table's filter field. Its wording lives there now.
  const search = read("src/components/catalog/CommerceSearch.tsx");
  assert.match(search, /Search products/);
  assert.match(search, /role="search"/);
  assert.match(client, /<CommerceSearch/);
  // Renamed with the rail in pass 14: the menu now carries filters as well as
  // categories, so "Browse products" describes what it is for.
  assert.match(client, /aria-label="Browse products"/, "the browse menu is its own labelled nav");
  // The filter labels moved beside the values they belong to, so a control
  // cannot offer a value the parser drops.
  const rules = read("src/lib/commerce/catalogBrowse.ts");
  for (const token of ["All products", "Any availability", "Any purchase type"]) {
    assert.match(rules, new RegExp(token));
  }

  // Native selects on a page where every other dropdown is a MenuSelect made
  // the catalog look like a different application. Comments are stripped first:
  // the file's own prose names the tag in order to say it is not used.
  for (const path of [
    "src/components/catalog/CatalogBrowser.tsx",
    "src/components/catalog/CatalogBrowseDrawer.tsx",
  ]) {
    const code = read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(code, /<select/, `${path} must use MenuSelect`);
  }
});
test("root metadata includes social previews", () => { const layout = read("src/app/layout.tsx"); assert.match(layout, /openGraph/); assert.match(layout, /twitter/); });
