import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  groupMediaByProduct,
  isOptimizableImageUrl,
  normalizeImageUrl,
  primaryProductImage,
  productImageCandidates,
} from "../src/lib/productImages.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const SUPABASE_URL = "https://project.supabase.co";
const withSupabaseUrl = <T>(run: () => T): T => {
  const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
  process.env.NEXT_PUBLIC_SUPABASE_URL = SUPABASE_URL;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    else process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
  }
};

test("gallery media wins over the denormalized products.image_url", () => {
  // The production regression: a product whose image_url was never backfilled
  // still has real gallery images and must not fall back to a placeholder.
  const product = {
    image_url: null,
    product_media: [
      { url: "https://cdn.example.com/second.png", kind: "image", sort_order: 2 },
      { url: "https://cdn.example.com/first.png", kind: "image", sort_order: 1 },
    ],
  };

  assert.equal(primaryProductImage(product), "https://cdn.example.com/first.png");
  assert.deepEqual(productImageCandidates(product), [
    "https://cdn.example.com/first.png",
    "https://cdn.example.com/second.png",
  ]);
});

test("image_url is used when a product has no gallery media", () => {
  assert.equal(
    primaryProductImage({ image_url: "https://cdn.example.com/only.png", product_media: [] }),
    "https://cdn.example.com/only.png"
  );
  assert.equal(primaryProductImage({ image_url: "https://cdn.example.com/only.png" }), "https://cdn.example.com/only.png");
});

test("a product with no usable image resolves to nothing so the fallback shows", () => {
  assert.equal(primaryProductImage({ image_url: null, product_media: [] }), null);
  assert.equal(primaryProductImage({ image_url: "   ", product_media: [{ url: "", kind: "image" }] }), null);
  assert.equal(primaryProductImage(null), null);
  assert.deepEqual(productImageCandidates(undefined), []);
});

test("non-image media never becomes a product image", () => {
  const product = {
    image_url: null,
    product_media: [{ url: "https://cdn.example.com/model.glb", kind: "model", sort_order: 0 }],
  };
  assert.equal(primaryProductImage(product), null);
});

test("candidates are deduplicated so a broken URL is not retried", () => {
  const product = {
    image_url: "https://cdn.example.com/a.png",
    product_media: [
      { url: "https://cdn.example.com/a.png", kind: "image", sort_order: 0 },
      { url: "https://cdn.example.com/b.png", kind: "image", sort_order: 1 },
    ],
  };
  assert.deepEqual(productImageCandidates(product), ["https://cdn.example.com/a.png", "https://cdn.example.com/b.png"]);
});

test("supported URL shapes normalize consistently", () => {
  assert.equal(normalizeImageUrl("https://cdn.example.com/a.png"), "https://cdn.example.com/a.png");
  assert.equal(normalizeImageUrl("http://cdn.example.com/a.png"), "http://cdn.example.com/a.png");
  assert.equal(normalizeImageUrl("//cdn.example.com/a.png"), "https://cdn.example.com/a.png");
  assert.equal(normalizeImageUrl("/brand/keymoura-colored.png"), "/brand/keymoura-colored.png");
  assert.equal(normalizeImageUrl("  https://cdn.example.com/a.png  "), "https://cdn.example.com/a.png");
  assert.equal(normalizeImageUrl("data:image/png;base64,AAAA"), "data:image/png;base64,AAAA");
});

test("unsafe or unusable values are rejected rather than rendered", () => {
  assert.equal(normalizeImageUrl("javascript:alert(1)"), null);
  assert.equal(normalizeImageUrl("file:///etc/passwd"), null);
  assert.equal(normalizeImageUrl(""), null);
  assert.equal(normalizeImageUrl(null), null);
  assert.equal(normalizeImageUrl(42), null);
});

test("bare Supabase Storage paths resolve against the project URL", () => {
  withSupabaseUrl(() => {
    assert.equal(
      normalizeImageUrl("product-assets/abc/photo.png"),
      `${SUPABASE_URL}/storage/v1/object/public/product-assets/abc/photo.png`
    );
    assert.equal(
      normalizeImageUrl("/storage/v1/object/public/product-assets/abc/photo.png"),
      `${SUPABASE_URL}/storage/v1/object/public/product-assets/abc/photo.png`
    );
  });
});

test("a bare path stays unresolved when no Supabase URL is configured", () => {
  const previous = process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  try {
    assert.equal(normalizeImageUrl("product-assets/abc/photo.png"), null);
    assert.equal(normalizeImageUrl("/brand/logo.png"), "/brand/logo.png");
  } finally {
    if (previous !== undefined) process.env.NEXT_PUBLIC_SUPABASE_URL = previous;
  }
});

test("media rows group by product and stay ordered", () => {
  const grouped = groupMediaByProduct([
    { product_id: "a", url: "a2", sort_order: 2 },
    { product_id: "b", url: "b1", sort_order: 0 },
    { product_id: "a", url: "a1", sort_order: 1 },
    { product_id: null, url: "orphan", sort_order: 0 },
  ]);

  assert.deepEqual(grouped.get("a")?.map((row) => row.url), ["a1", "a2"]);
  assert.deepEqual(grouped.get("b")?.map((row) => row.url), ["b1"]);
  assert.equal(grouped.size, 2);
});

test("homepage and catalog resolve product images through the shared pipeline", () => {
  const home = read("src/app/page.tsx");
  const catalog = read("src/app/catalog/page.tsx");
  const card = read("src/components/ProductCard.tsx");
  const image = read("src/components/ProductImage.tsx");

  // Both surfaces must join product_media, not read image_url alone.
  for (const [name, source] of [["homepage", home], ["catalog", catalog]] as const) {
    assert.match(source, /product_media/, `${name} must query gallery media`);
    assert.match(source, /groupMediaByProduct/, `${name} must group media through the shared helper`);
    assert.match(source, /ProductCard/, `${name} must render the shared product card`);
  }

  assert.match(home, /\.is\("archived_at", null\)/, "homepage must exclude archived products");
  assert.match(card, /ProductImage/);
  assert.match(image, /productImageCandidates/);
});

test("the product image box is reserved so a missing image cannot shift layout", () => {
  const css = read("src/app/globals.css");
  assert.match(css, /\.product-image\s*\{[^}]*aspect-ratio:\s*4\s*\/\s*3/);
  assert.match(css, /\.product-image-media\s*\{[^}]*object-fit:\s*cover/);
});

test("a broken image steps to the next candidate before the brand fallback", () => {
  const image = read("src/components/ProductImage.tsx");
  assert.match(image, /const nextCandidate = \(\) => setIndex\(\(current\) => current \+ 1\);/);
  assert.equal((image.match(/onError=\{nextCandidate\}/g) ?? []).length, 2, "both image paths must recover");
  assert.match(image, /product-image-fallback/);
});

test("only allow-listed hosts go through the image optimizer", () => {
  withSupabaseUrl(() => {
    assert.equal(isOptimizableImageUrl(`${SUPABASE_URL}/storage/v1/object/public/product-assets/a.png`), true);
    assert.equal(isOptimizableImageUrl("/brand/keymoura-colored.png"), true);
    // Operator URLs on unknown hosts must not be handed to next/image, which
    // would throw instead of rendering the picture.
    assert.equal(isOptimizableImageUrl("https://cdn.example.com/a.png"), false);
    assert.equal(isOptimizableImageUrl(`${SUPABASE_URL}/rest/v1/not-storage.png`), false);
    assert.equal(isOptimizableImageUrl("data:image/png;base64,AAAA"), false);
  });
});

test("the optimizer allow-list is limited to public Supabase Storage objects", () => {
  const config = read("next.config.ts");
  assert.match(config, /remotePatterns/);
  assert.match(config, /pathname: "\/storage\/v1\/object\/public\/\*\*"/);
  assert.match(config, /protocol: "https"/);
  assert.match(config, /NEXT_PUBLIC_SUPABASE_URL/);
});
