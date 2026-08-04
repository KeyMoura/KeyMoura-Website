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
  // component. "Customizable only" became a purchase-type filter, which is
  // the distinction a customer actually shops on.
  const client = read("src/app/catalog/CatalogClient.tsx");
  for (const token of ["Search products", "All categories", "Any availability", "Any purchase type", "No products match"]) {
    assert.match(client, new RegExp(token));
  }
  // Native selects on a page where every other dropdown is a MenuSelect made
  // the catalog look like a different application. Comments are stripped first:
  // the file's own prose names the tag in order to say it is not used.
  const code = client.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(code, /<select/);
});
test("root metadata includes social previews", () => { const layout = read("src/app/layout.tsx"); assert.match(layout, /openGraph/); assert.match(layout, /twitter/); });
