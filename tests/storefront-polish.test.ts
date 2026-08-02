import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("homepage exposes featured products and custom-work guidance", () => { const page = read("src/app/page.tsx"); assert.match(page, /loadFeaturedProducts/); assert.match(page, /Request custom work/); assert.match(page, /Common questions/); });
test("homepage covers what KeyMoura does, sells, and how custom work runs", () => {
  const page = read("src/app/page.tsx");
  for (const token of ["Capabilities", "From the catalog", "How custom work happens", "Browse the catalog", "Start a custom request"]) {
    assert.ok(page.includes(token), `homepage is missing: ${token}`);
  }
});
test("catalog supports discovery controls and clear empty states", () => { const page = read("src/app/catalog/page.tsx"); for (const token of ["Search products", "All categories", "Any availability", "Customizable only", "No products match"]) assert.match(page, new RegExp(token)); });
test("root metadata includes social previews", () => { const layout = read("src/app/layout.tsx"); assert.match(layout, /openGraph/); assert.match(layout, /twitter/); });
