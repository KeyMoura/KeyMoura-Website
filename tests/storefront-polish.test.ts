import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
test("homepage exposes featured products and custom-work guidance", () => { const page = read("src/app/page.tsx"); assert.match(page, /featuredProducts/); assert.match(page, /Request custom work/); assert.match(page, /Common questions/); });
test("catalog supports discovery controls and clear empty states", () => { const page = read("src/app/catalog/page.tsx"); for (const token of ["Search products", "All categories", "Any availability", "Customizable only", "No products match"]) assert.match(page, new RegExp(token)); });
test("root metadata includes social previews", () => { const layout = read("src/app/layout.tsx"); assert.match(layout, /openGraph/); assert.match(layout, /twitter/); });
