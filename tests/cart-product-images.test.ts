import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { primaryProductImage, productImageCandidates } from "../src/lib/productImages.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const cartService = read("src/lib/commerce/cartService.ts");
const productDisplay = read("src/lib/commerce/productDisplay.ts");
const wishlistService = read("src/lib/commerce/wishlistService.ts");
const sharedCartService = read("src/lib/commerce/sharedCartService.ts");
const drawer = read("src/components/commerce/CartDrawer.tsx");
const cartPage = read("src/app/cart/page.tsx");
const css = read("src/app/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");

// ---------------------------------------------------------------------------
// One resolver, one loader
// ---------------------------------------------------------------------------

test("every commerce surface resolves cover images through one loader", () => {
  // The loader was copy-pasted into the wishlist and shared-cart services, and
  // the cart would have been a third copy. Three answers to "which image wins"
  // is how one of them quietly stops agreeing with the catalog.
  for (const [name, source] of [
    ["cartService", cartService],
    ["wishlistService", wishlistService],
    ["sharedCartService", sharedCartService],
  ] as const) {
    assert.match(source, /loadProductImageSources/, `${name} must use the shared loader`);
    assert.doesNotMatch(
      source,
      /async function loadDisplayFields/,
      `${name} must not keep its own copy of the image loader`
    );
    assert.doesNotMatch(
      source,
      /from\("product_media"\)/,
      `${name} must not query product_media directly; that is the loader's job`
    );
  }
});

test("the shared loader resolves through the canonical image pipeline", () => {
  assert.match(productDisplay, /groupMediaByProduct/, "media ordering must come from the shared helper");
  assert.match(productDisplay, /from\("product_media"\)/);
  assert.match(productDisplay, /\.eq\("kind", "image"\)/, "only image media may become a cover image");
  assert.match(productDisplay, /\.order\("sort_order"\)/, "gallery order decides the primary image");
  assert.match(productDisplay, /image_url/, "the denormalized column stays available as a fallback");
});

test("cover images are fetched in batches, never per line", () => {
  // An N+1 here is invisible on a two-line cart and painful on a fifty-line one.
  // Both queries filter by `in(...)` over a de-duplicated id list.
  assert.match(productDisplay, /Array\.from\(new Set\(productIds\)\)/, "ids must be de-duplicated first");
  assert.equal(
    (productDisplay.match(/\.in\(/g) ?? []).length,
    2,
    "exactly two batched queries: products and their media"
  );
  assert.match(productDisplay, /Promise\.all/, "the two reads must not be sequential");
  assert.doesNotMatch(productDisplay, /for\s*\([^)]*\)\s*\{[^}]*await/, "no per-product await loop");
});

test("the cart loads images alongside pricing rather than after it", () => {
  assert.match(
    cartService,
    /Promise\.all\(\[loadPricedProducts\(productIds\), loadProductImageSources\(productIds\)\]\)/,
    "one round trip, not two"
  );
});

// ---------------------------------------------------------------------------
// Wire shape
// ---------------------------------------------------------------------------

test("the cart API exposes an image for available and unavailable lines alike", () => {
  const serializer = cartService.slice(cartService.indexOf("export function serializeCart"));
  assert.equal(
    (serializer.match(/image: resolved\.images\.get\(/g) ?? []).length,
    2,
    "both the items list and the unavailable list must carry an image"
  );
  assert.match(serializer, /EMPTY_IMAGE_SOURCE/, "a product with no media must resolve to an explicit empty source");
});

test("the cart API exposes only public catalog media", () => {
  // The wire shape is `{ image_url, product_media: [{url, kind, sort_order}] }`
  // — public catalog columns. No storage credentials, no owner identity, and no
  // signed URLs that would outlive the response.
  assert.match(productDisplay, /select\("id,image_url"\)/);
  assert.match(productDisplay, /select\("product_id,url,kind,sort_order"\)/);
  assert.doesNotMatch(productDisplay, /createSignedUrl|service_role|customer_id|guest_token/);
});

test("the empty cart still satisfies the serialized shape", () => {
  assert.match(cartService, /images: new Map\(\)/, "an empty cart needs an images map, not undefined");
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

test("the drawer and the cart page both render the shared ProductImage", () => {
  for (const [name, source] of [["drawer", drawer], ["cart page", cartPage]] as const) {
    assert.match(source, /import ProductImage from "@\/components\/ProductImage"/, `${name} must import the shared component`);
    assert.match(source, /<ProductImage\s+product=\{(item|entry)\.image\}/, `${name} must render the line's image`);
    assert.doesNotMatch(source, /<img\s/, `${name} must not hand-roll an <img>`);
    assert.doesNotMatch(source, /primaryProductImage|normalizeImageUrl/, `${name} must not resolve URLs itself`);
  }
});

test("cart thumbnails carry empty alt text because the name links beside them", () => {
  // The product name is already a link to the same destination. A described
  // thumbnail would make a screen reader announce every cart line twice.
  for (const [name, source] of [["drawer", drawer], ["cart page", cartPage]] as const) {
    const images = source.match(/<ProductImage[\s\S]{0,200}?\/>/g) ?? [];
    assert.ok(images.length, `${name} must render at least one thumbnail`);
    for (const image of images) {
      assert.match(image, /alt=""/, `${name} thumbnails must use empty alt`);
    }
  }
});

test("the thumbnail link is hidden from assistive tech and from the tab order", () => {
  for (const [name, source] of [["drawer", drawer], ["cart page", cartPage]] as const) {
    // The drawer adds its own width class alongside the shared one, so the
    // class attribute is matched by prefix rather than by equality.
    const link = source.match(/className="cart-thumb-link[ "]/);
    assert.ok(link, `${name} must wrap the thumbnail in the shared link class`);
    const block = source.slice(0, source.indexOf('className="cart-thumb-link'));
    assert.match(block.slice(-220), /tabIndex=\{-1\}/, `${name} must not add a second tab stop`);
    assert.match(block.slice(-220), /aria-hidden="true"/, `${name} must not duplicate the product announcement`);
  }
});

test("thumbnails reserve their box so a loading image cannot shift the controls", () => {
  assert.match(css, /\.cart-thumb\s*\{[^}]*aspect-ratio:\s*1\s*\/\s*1/);
  assert.match(css, /\.cart-thumb\s*\{[^}]*width:\s*4rem/);
  assert.match(css, /\.cart-thumb\s*\{[^}]*flex:\s*0 0 auto/, "the thumbnail must never flex-shrink into a sliver");
  // object-fit lives on .product-image-media, shared with every other surface.
  assert.match(css, /\.product-image-media\s*\{[^}]*object-fit:\s*cover/);
});

test("the cart row keeps the thumbnail beside the text at 320px", () => {
  // basis-48 (12rem) no longer fits beside a 4rem thumbnail at 320px: the row
  // wrapped and left the image stranded on a line of its own. Measured in the
  // browser at 320, 375 and up.
  assert.match(cartPage, /className="min-w-0 flex-1 basis-40"/, "the text column must fit beside the thumbnail");

  /*
   * The drawer states the same thing as a grid rather than as a flex row, since
   * it became a sheet: a fixed thumbnail track, a text track that may shrink,
   * and a price track sized to its own content. `minmax(0, 1fr)` is the part
   * that matters — a bare `1fr` floors at min-content, which for an unbroken
   * product name is the whole name, and the price would be pushed off the row.
   */
  assert.match(css, /\.cart-drawer-item\s*\{[^}]*grid-template-columns:\s*4rem minmax\(0, 1fr\) auto/);
  assert.match(css, /\.cart-drawer-item-body\s*\{[^}]*min-width:\s*0/);
});

test("the shared-cart page renders the same canonical image", () => {
  const shared = read("src/app/cart/shared/[token]/page.tsx");
  assert.match(shared, /<ProductImage product=\{line\.image\}/);
});

// ---------------------------------------------------------------------------
// The four media cases, at cart-line shape
// ---------------------------------------------------------------------------

test("a line with primary media uses the gallery image", () => {
  const image = {
    image_url: "https://cdn.example.com/stale.png",
    product_media: [
      { url: "https://cdn.example.com/b.png", kind: "image", sort_order: 2 },
      { url: "https://cdn.example.com/a.png", kind: "image", sort_order: 1 },
    ],
  };
  assert.equal(primaryProductImage(image), "https://cdn.example.com/a.png");
});

test("a line whose cached image_url is null still shows its gallery image", () => {
  // The exact production regression that made products with real photos render
  // as placeholders.
  const image = {
    image_url: null,
    product_media: [{ url: "https://cdn.example.com/a.png", kind: "image", sort_order: 0 }],
  };
  assert.equal(primaryProductImage(image), "https://cdn.example.com/a.png");
});

test("a line with only the fallback image_url still shows a picture", () => {
  assert.equal(
    primaryProductImage({ image_url: "https://cdn.example.com/only.png", product_media: [] }),
    "https://cdn.example.com/only.png"
  );
});

test("a line with no usable image falls back rather than rendering a broken box", () => {
  assert.equal(primaryProductImage({ image_url: null, product_media: [] }), null);
  assert.deepEqual(productImageCandidates({ image_url: "  ", product_media: [{ url: "", kind: "image" }] }), []);
});

test("a deleted product carries an empty image source, not a missing key", () => {
  // `EMPTY_IMAGE_SOURCE` is what a removed product resolves to, so the renderer
  // takes the fallback branch instead of dereferencing undefined.
  assert.match(productDisplay, /export const EMPTY_IMAGE_SOURCE: ProductImageSource = \{ image_url: null, product_media: \[\] \}/);
  assert.equal(primaryProductImage({ image_url: null, product_media: [] }), null);
});
