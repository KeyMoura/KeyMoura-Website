import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  describeLinkedMedia,
  imageForSelection,
  initialImageForSelections,
  optionImageIndex,
  optionImageKey,
  rendersAsSwatches,
  valuesWithMissingMedia,
} from "../src/lib/commerce/optionMedia.ts";
import { priceLine, type PricedProduct } from "../src/lib/commerce/pricing.ts";
import type { ProductMedia, ProductOptionGroup, ProductOptionValue } from "../src/lib/commerceTypes.ts";

/**
 * Option values: price adjustments, linked gallery images, and swatches.
 *
 * The pricing half is **not** new — `price_adjustment_cents` has been the
 * server-authoritative adjustment since `20260731060000`, and `priceLine` has
 * always summed it. What was missing was the editor: three columns the
 * storefront already obeyed (`is_default`, `is_active`, `requires_request`) could
 * not be changed anywhere in the product, and there was no way to associate a
 * choice with a photograph at all.
 *
 * So these tests do two jobs: prove the *new* relation behaves, and pin the
 * existing pricing rules so the new editor cannot quietly introduce a second,
 * competing adjustment.
 */

const read = (path: string) => readFileSync(path, "utf8");
const editor = read("src/app/staff/catalog/page.tsx");
const valueRow = read("src/components/staff/ProductOptionValueRow.tsx");
const panel = read("src/components/product/ProductPurchasePanel.tsx");
const gallery = read("src/components/product/ProductGallery.tsx");
const migration = read("supabase/migrations/20260809102004_option_value_media_and_display_style.sql");

const value = (over: Partial<ProductOptionValue> & { id: string; value: string }): ProductOptionValue => ({
  option_group_id: "g1",
  label: over.value,
  price_adjustment_cents: 0,
  is_default: false,
  is_active: true,
  sort_order: 0,
  ...over,
});

const group = (over: Partial<ProductOptionGroup> & { id: string; option_key: string }): ProductOptionGroup => ({
  product_id: "p1",
  name: over.option_key,
  input_type: "radio",
  description: null,
  placeholder: null,
  is_required: false,
  sort_order: 0,
  ...over,
});

const media = (id: string, over: Partial<ProductMedia> = {}): ProductMedia => ({
  id,
  product_id: "p1",
  kind: "image",
  url: `https://example.test/${id}.jpg`,
  alt_text: null,
  sort_order: 0,
  ...over,
});

const galleryOf = (...ids: string[]) => ids.map((id) => ({ id, url: `https://example.test/${id}.jpg` }));

const colour = group({
  id: "g1",
  option_key: "colour",
  name: "Colour",
  display_style: "swatches",
  product_option_values: [
    value({ id: "v-red", value: "red", label: "Red", media_id: "m1" }),
    value({ id: "v-blue", value: "blue", label: "Blue", media_id: "m2", price_adjustment_cents: 1000 }),
    value({ id: "v-black", value: "black", label: "Black" }),
  ],
});

// ---------------------------------------------------------------------------
// The relation
// ---------------------------------------------------------------------------

test("only values whose image is in this product's gallery resolve", () => {
  const index = optionImageIndex([colour], galleryOf("m1", "m2"));
  assert.equal(index.get(optionImageKey("colour", "red")), "m1");
  assert.equal(index.get(optionImageKey("colour", "blue")), "m2");
  assert.equal(index.has(optionImageKey("colour", "black")), false, "Black has no image");
});

test("a link to an image the page is not showing is inert, not broken", () => {
  // The database refuses a cross-product link, and the trigger is tested against
  // production. This is the second line of defence: an id that is not in the
  // gallery this page rendered yields nothing, so the gallery stays put rather
  // than jumping to the wrong photograph or to index 0.
  const index = optionImageIndex([colour], galleryOf("m2"));
  assert.equal(index.has(optionImageKey("colour", "red")), false);
  assert.equal(imageForSelection(index, "colour", "red"), null);
});

test("choosing a value with no image leaves the gallery alone", () => {
  const index = optionImageIndex([colour], galleryOf("m1", "m2"));
  assert.equal(imageForSelection(index, "colour", "black"), null);
  assert.equal(imageForSelection(index, "colour", null), null);
  assert.equal(imageForSelection(index, "colour", undefined), null);
});

test("the first paint uses the first image-bearing group in staff order", () => {
  const finish = group({
    id: "g2",
    option_key: "finish",
    sort_order: 1,
    product_option_values: [value({ id: "v-raw", value: "raw", media_id: "m3" })],
  });
  const index = optionImageIndex([colour, finish], galleryOf("m1", "m2", "m3"));

  // Both selected: the earlier group wins, deterministically, rather than
  // depending on the key order of a plain object.
  assert.equal(initialImageForSelections([colour, finish], index, { colour: "blue", finish: "raw" }), "m2");
  assert.equal(initialImageForSelections([finish, colour], index, { colour: "blue", finish: "raw" }), "m3");
  // Only the imageless one selected: nothing to show.
  assert.equal(initialImageForSelections([colour], index, { colour: "black" }), null);
});

// ---------------------------------------------------------------------------
// Swatches
// ---------------------------------------------------------------------------

test("swatches need the staff instruction and at least one real image", () => {
  const withImages = optionImageIndex([colour], galleryOf("m1", "m2"));
  assert.equal(rendersAsSwatches(colour, withImages), true);

  // Explicit instruction absent: buttons, however many images there are.
  assert.equal(rendersAsSwatches({ ...colour, display_style: "buttons" }, withImages), false);
  assert.equal(rendersAsSwatches({ ...colour, display_style: null }, withImages), false);

  // Instruction present but nothing resolves: buttons, because a swatch row
  // with no thumbnails is worse than the buttons it replaced.
  assert.equal(rendersAsSwatches(colour, optionImageIndex([colour], [])), false);
});

test("presentation is never inferred from the option's name", () => {
  const named = group({
    id: "g9",
    option_key: "colour",
    name: "Colour",
    product_option_values: [value({ id: "v", value: "red", media_id: "m1" })],
  });
  assert.equal(rendersAsSwatches(named, optionImageIndex([named], galleryOf("m1"))), false);
  // And nothing in the code sniffs the name either.
  assert.ok(!/name.*\.toLowerCase\(\).*(colou?r|finish|material)/i.test(panel));
});

// ---------------------------------------------------------------------------
// Pricing — the existing mechanism, pinned
// ---------------------------------------------------------------------------

const priced = (groups: ProductOptionGroup[]): PricedProduct => ({
  id: "p1",
  name: "Shift knob",
  slug: "shift-knob",
  is_published: true,
  archived_at: null,
  purchase_mode: "direct_purchase",
  starting_price_cents: 5000,
  availability_status: "available",
  inventory_policy: "unlimited",
  inventory_quantity: 0,
  continue_selling_when_out_of_stock: false,
  option_groups: groups.map((g) => ({
    id: g.id,
    option_key: g.option_key,
    name: g.name,
    is_required: g.is_required,
    input_type: g.input_type,
    values: (g.product_option_values ?? []).map((v) => ({
      id: v.id,
      label: v.label,
      value: v.value,
      price_adjustment_cents: v.price_adjustment_cents,
      is_active: v.is_active,
      requires_request: Boolean(v.requires_request),
    })),
  })),
});

test("a positive adjustment is added to the unit price", () => {
  const line = priceLine(priced([colour]), { productId: "p1", quantity: 1, selectedOptions: { colour: "blue" } });
  assert.ok(!("blocker" in line));
  assert.equal(line.unitPriceCents, 6000);
  assert.deepEqual(line.optionLabels, [{ group: "Colour", label: "Blue", adjustmentCents: 1000 }]);
});

test("a zero adjustment changes nothing", () => {
  const line = priceLine(priced([colour]), { productId: "p1", quantity: 1, selectedOptions: { colour: "black" } });
  assert.ok(!("blocker" in line));
  assert.equal(line.unitPriceCents, 5000);
});

test("a negative adjustment is honoured, and the unit price cannot go below zero", () => {
  const discount = group({
    id: "g3",
    option_key: "material",
    name: "Material",
    product_option_values: [value({ id: "v-cheap", value: "cheap", label: "Plain", price_adjustment_cents: -600 })],
  });
  const line = priceLine(priced([discount]), { productId: "p1", quantity: 1, selectedOptions: { material: "cheap" } });
  assert.ok(!("blocker" in line));
  assert.equal(line.unitPriceCents, 4400);

  const huge = group({
    id: "g4",
    option_key: "material",
    name: "Material",
    product_option_values: [value({ id: "v-free", value: "free", label: "Free", price_adjustment_cents: -99999 })],
  });
  const floored = priceLine(priced([huge]), { productId: "p1", quantity: 1, selectedOptions: { material: "free" } });
  assert.ok(!("blocker" in floored));
  assert.equal(floored.unitPriceCents, 0, "a combination of discounts must never produce a negative line");
});

test("adjustments from several groups sum", () => {
  const finish = group({
    id: "g5",
    option_key: "finish",
    name: "Finish",
    product_option_values: [value({ id: "v-anod", value: "anodised", label: "Anodised", price_adjustment_cents: 2500 })],
  });
  const line = priceLine(priced([colour, finish]), {
    productId: "p1",
    quantity: 2,
    selectedOptions: { colour: "blue", finish: "anodised" },
  });
  assert.ok(!("blocker" in line));
  assert.equal(line.unitPriceCents, 8500);
  assert.equal(line.lineSubtotalCents, 17000);
  assert.equal(line.optionLabels.length, 2);
});

test("an inactive value is not priced and cannot be selected", () => {
  const off = group({
    id: "g6",
    option_key: "colour",
    name: "Colour",
    product_option_values: [value({ id: "v-off", value: "gone", price_adjustment_cents: 900, is_active: false })],
  });
  const line = priceLine(priced([off]), { productId: "p1", quantity: 1, selectedOptions: { colour: "gone" } });
  assert.ok(!("blocker" in line));
  assert.equal(line.unitPriceCents, 5000, "an inactive value must contribute nothing");
  assert.deepEqual(line.selectedOptions, {});
});

test("the linked image never touches the price", () => {
  // The two features are independent by construction: `PricedOptionValue` has
  // no media field at all, so an image cannot become a pricing input.
  const withImage = priceLine(priced([colour]), { productId: "p1", quantity: 1, selectedOptions: { colour: "red" } });
  const withoutImage = priceLine(priced([{ ...colour, product_option_values: colour.product_option_values?.map((v) => ({ ...v, media_id: null })) }]), {
    productId: "p1",
    quantity: 1,
    selectedOptions: { colour: "red" },
  });
  assert.ok(!("blocker" in withImage) && !("blocker" in withoutImage));
  assert.equal(withImage.unitPriceCents, withoutImage.unitPriceCents);
});

test("there is exactly one price-adjustment mechanism", () => {
  const pricing = read("src/lib/commerce/pricing.ts");
  assert.ok(pricing.includes("price_adjustment_cents"));
  // No second column, no second name for the same idea.
  for (const source of [panel, editor, valueRow]) {
    assert.ok(!/price_delta|priceModifier|surcharge_cents|extra_cents/i.test(source));
  }
});

// ---------------------------------------------------------------------------
// Staff editor
// ---------------------------------------------------------------------------

test("the editor can now change every column the storefront obeys", () => {
  for (const field of ["is_default", "is_active", "requires_request", "media_id"]) {
    assert.ok(valueRow.includes(field), `${field} must be editable`);
  }
  // And the save writes them.
  assert.match(editor, /requires_request: Boolean\(value\.requires_request\)/);
  assert.match(editor, /media_id: value\.media_id \?\? null/);
  assert.match(editor, /display_style: group\.display_style === "swatches" \? "swatches" : "buttons"/);
});

test("the editor stores a media row id, never a copied URL", () => {
  assert.ok(!/media_url|image_url:\s*value\./.test(valueRow));
  assert.match(valueRow, /onChange\(\{ media_id: asset\.id \}\)/);
  assert.match(valueRow, /onChange\(\{ media_id: null \}\)/, "clearing must be offered");
});

test("select, change and clear are all reachable", () => {
  assert.ok(valueRow.includes("Select image"));
  assert.ok(valueRow.includes("Change image"));
  assert.ok(valueRow.includes("Clear image"));
});

test("a mistyped price cannot fail the whole save", () => {
  // `Number("1.2e")` is NaN, and PostgREST would send that as null into a NOT
  // NULL column, failing a save that touched nothing else.
  assert.match(editor, /Number\.isFinite\(value\.price_adjustment_cents\)/);
});

test("duplicating a product re-points swatches at the copy's own images", () => {
  // Keeping the source id would attach one product's photograph to another
  // product's colour, which the trigger refuses — so the duplicate would lose
  // its choices entirely.
  assert.match(editor, /copiedMediaId/);
  assert.match(editor, /media_id: value\.media_id \? copiedMediaId\.get\(value\.media_id\) \?\? null : null/);
});

test("deleting an image names the choices that used it, and clears them locally", () => {
  assert.match(editor, /associated image for/);
  assert.match(editor, /value\.media_id === item\.id \? \{ \.\.\.value, media_id: null \} : value/);
});

test("a link whose image is gone says so rather than reading as never set", () => {
  assert.match(valueRow, /dangling/);
  assert.ok(valueRow.includes("The linked image was deleted."));
});

test("describeLinkedMedia leads with position, which is how people find an image", () => {
  const assets = [media("m1"), media("m2", { alt_text: "Blue anodised", sort_order: 1 })];
  assert.equal(describeLinkedMedia(assets, "m1"), "Image 1");
  assert.equal(describeLinkedMedia(assets, "m2"), "Image 2 — Blue anodised");
  assert.equal(describeLinkedMedia(assets, "gone"), null);
  assert.equal(describeLinkedMedia(assets, null), null);
});

test("values whose image has been deleted are reportable", () => {
  const orphaned = valuesWithMissingMedia([colour], [media("m1")]);
  assert.deepEqual(orphaned.map((v) => v.id), ["v-blue"]);
});

// ---------------------------------------------------------------------------
// Storefront wiring
// ---------------------------------------------------------------------------

test("the gallery switches on the token, so re-picking a colour works", () => {
  // Comparing media ids would make the second press a no-op after the customer
  // browsed away by hand.
  assert.match(gallery, /request\.token !== lastToken/);
  assert.ok(!/request\.mediaId !== last/.test(gallery));
});

test("the gallery stays put when the requested image is not in it", () => {
  assert.match(gallery, /if \(target !== -1\)/);
});

test("switching is driven by the change, not by watching the selections object", () => {
  // "Most recently selected wins" is a fact about the interaction; a Record has
  // no order to recover it from, so an effect could not implement it.
  assert.match(panel, /const choose = useCallback\(/);
  assert.match(panel, /if \(mediaId\) showMedia\(mediaId\)/);
  assert.ok(!/useEffect\(\(\) => \{[\s\S]{0,200}showMedia/.test(panel));
});

test("other selections survive a gallery switch", () => {
  assert.match(panel, /setSelections\(\(current\) => \(\{ \.\.\.current, \[optionKey\]: value \}\)\)/);
});

test("swatches are keyboard reachable and not colour-only", () => {
  assert.match(panel, /role="radiogroup"/);
  assert.match(panel, /role="radio"/);
  assert.match(panel, /aria-checked=\{checked\}/);
  assert.match(panel, /product-option-swatch-label/, "the label is real text under the image");
  const css = read("src/app/globals.css");
  assert.match(css, /\.product-option-swatch\.is-selected \.product-option-swatch-frame::after/, "a tick, not just a ring");
});

test("a value with no image still appears in a swatch group", () => {
  // Dropping it would remove a purchasable choice from the page.
  assert.match(panel, /product-option-swatch-blank/);
});

// ---------------------------------------------------------------------------
// The migration
// ---------------------------------------------------------------------------

test("the migration is additive and default-safe", () => {
  assert.match(migration, /add column if not exists media_id uuid/);
  assert.match(migration, /add column if not exists display_style text not null default 'buttons'/);
  assert.ok(!/\bdrop column\b|\bdelete from\b|\bupdate public\./i.test(migration));
});

test("deleting an image nulls the link rather than deleting the choice", () => {
  assert.match(migration, /on delete set null/);
  assert.ok(!/on delete cascade/i.test(migration), "cascade here would take a colour off sale with a photograph");
});

test("the same-product rule is enforced in the database, not only in the UI", () => {
  assert.match(migration, /m\.product_id = g\.product_id/);
  assert.match(migration, /create trigger product_option_values_media_product_check/);
});

test("the trigger function is not exposed as an RPC", () => {
  const hardening = read("supabase/migrations/20260809102051_option_value_media_trigger_not_callable.sql");
  for (const role of ["public", "anon", "authenticated"]) {
    assert.ok(
      hardening.includes(`from ${role};`),
      `EXECUTE must be revoked from ${role} or PostgREST publishes the trigger function`
    );
  }
});
