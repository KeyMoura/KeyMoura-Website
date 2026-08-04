import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path: string) => readFileSync(path, "utf8");

test("catalog uses gallery media and exposes image navigation", () => {
  const catalog = read("src/app/catalog/page.tsx");
  const product = read("src/app/catalog/[slug]/page.tsx");
  const image = read("src/components/ProductImage.tsx");
  assert.match(catalog, /from\("product_media"\)/);
  // Fallback handling moved from inline DOM juggling into the shared image
  // component, which steps through every remaining candidate before the
  // brand mark and never leaves a broken <img> in the layout.
  assert.match(image, /productImageCandidates/);
  assert.match(image, /onError=/);
  assert.match(image, /product-image-fallback/);
  assert.doesNotMatch(catalog, /My requests & orders/);
  // Gallery navigation moved into its own component with the product-page
  // redesign; the labels dropped the redundant "product" because they are
  // already inside a group labelled "Product images".
  const galleryComponent = read("src/components/product/ProductGallery.tsx");
  assert.match(galleryComponent, /aria-label="Previous image"/);
  assert.match(galleryComponent, /aria-label="Next image"/);
  assert.match(product, /ProductGallery/);
});

test("account is the customer order launch point", () => {
  const account = read("src/app/account/page.tsx");
  assert.match(account, /href="\/orders"/);
  assert.match(account, /Requests & orders/);
  assert.match(account, /href="\/orders\/new"/);
  assert.match(account, /Manage your account/);
});

test("draft deletion is owner scoped and confirmed", () => {
  const page = read("src/app/orders/new/page.tsx");
  assert.match(page, /Delete this draft\?/);
  assert.match(page, /\.delete\(\)\.eq\("id",id\)\.eq\("customer_id",user\.id\)/);
});

test("staff customer-facing changes require review and clarify quote totals", () => {
  const page = read("src/app/staff/orders/[id]/page.tsx");
  assert.match(page, /Review & confirm update/);
  assert.match(page, /The customer will be notified/);
  assert.match(page, /Total customer price/);
  assert.match(page, /Internal material and labor costs are not the customer price/);
});
