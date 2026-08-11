import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { choicePresentation, presentationPatch } from "../src/lib/commerce/optionPresentation.ts";
import type { ProductOptionGroup } from "../src/lib/commerceTypes.ts";

const group = (input_type: ProductOptionGroup["input_type"], display_style: ProductOptionGroup["display_style"]): ProductOptionGroup => ({
  id: "group", product_id: "product", name: "Color", option_key: "color", input_type,
  display_style, description: null, placeholder: null, is_required: true, sort_order: 0,
});

test("staff presentation choices map onto the existing input type and display style", () => {
  assert.equal(choicePresentation(group("select", "buttons")), "dropdown");
  assert.equal(choicePresentation(group("radio", "buttons")), "buttons");
  assert.equal(choicePresentation(group("radio", "swatches")), "swatches");
  assert.deepEqual(presentationPatch("dropdown"), { input_type: "select", display_style: "buttons" });
  assert.deepEqual(presentationPatch("buttons"), { input_type: "radio", display_style: "buttons" });
  assert.deepEqual(presentationPatch("swatches"), { input_type: "radio", display_style: "swatches" });
});

test("visible editor and storefront expose previews, currency, media, errors, and configured totals", () => {
  const editor = readFileSync("src/app/staff/catalog/page.tsx", "utf8");
  const value = readFileSync("src/components/staff/ProductOptionValueRow.tsx", "utf8");
  const preview = readFileSync("src/components/staff/ProductOptionPreview.tsx", "utf8");
  const store = readFileSync("src/components/product/ProductPurchasePanel.tsx", "utf8");
  assert.match(editor, /label="Presentation"/);
  assert.match(editor, /ProductOptionPreview/);
  assert.match(editor, /moveValue/);
  assert.match(value, /label="Price change \(\$\)"/);
  assert.match(value, /Associated image/);
  assert.match(preview, /Customer preview/);
  assert.match(store, /Configured unit price/);
  assert.match(store, /before discounts/);
  assert.match(store, /aria-invalid/);
  assert.match(store, /ArrowLeft/);
});
