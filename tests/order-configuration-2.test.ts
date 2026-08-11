import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { purchasedOptions, snapshotPurchasedOptions } from "../src/lib/commerce/orderConfiguration.ts";

const line = {
  optionLabels: [{ groupId: "group-color", groupKey: "color", group: "Color", valueId: "value-blue", value: "blue", label: "Blue", adjustmentCents: 500 }],
};

test("purchase snapshot preserves names, ids, and authoritative adjustment", () => {
  assert.deepEqual(snapshotPurchasedOptions(line), {
    color: { option_id: "group-color", option_name: "Color", value_id: "value-blue", value_name: "Blue", value: "blue", price_adjustment_cents: 500 },
  });
});

test("later catalog rename or repricing cannot alter a purchased snapshot", () => {
  const snapshot = snapshotPurchasedOptions(line);
  line.optionLabels[0].label = "Navy";
  line.optionLabels[0].adjustmentCents = 800;
  assert.deepEqual(purchasedOptions(snapshot).map(({ option_name, value_name, price_adjustment_cents }) => ({ option_name, value_name, price_adjustment_cents })), [
    { option_name: "Color", value_name: "Blue", price_adjustment_cents: 500 },
  ]);
});

test("deleted catalog rows are irrelevant to order history", () => {
  const snapshot = snapshotPurchasedOptions(line);
  line.optionLabels.length = 0;
  assert.equal(purchasedOptions(snapshot)[0]?.value_name, "Navy");
});

test("checkout writes the rich snapshot instead of raw cart selections", () => {
  const checkout = readFileSync("src/app/api/cart/checkout/route.ts", "utf8");
  assert.match(checkout, /selected_options: snapshotPurchasedOptions\(line\)/);
  assert.doesNotMatch(checkout, /selected_options: line\.selectedOptions/);
});

test("required options are not silently selected without an explicit default", () => {
  const panel = readFileSync("src/components/product/ProductPurchasePanel.tsx", "utf8");
  assert.match(panel, /find\(\(value\) => value\.is_default && value\.is_active\)/);
  assert.doesNotMatch(panel, /\?\? values\[0\]/);
});

test("3D texture warning remains permanent", () => {
  const viewer = readFileSync("src/components/ProductModelViewer.tsx", "utf8");
  assert.ok(viewer.includes('"Textures may not be accurate."'));
});
