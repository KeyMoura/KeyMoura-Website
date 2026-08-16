import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clampQuantity,
  commitQuantityInput,
  parseQuantityInput,
  quantityCeiling,
  quantityWarning,
  stepQuantity,
  QUANTITY_ABSOLUTE_MAX,
  QUANTITY_MIN,
} from "../src/lib/commerce/quantity.ts";
import { displayableLineCeiling, MAX_LINE_QUANTITY } from "../src/lib/commerce/pricing.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** Source with comments stripped: several assertions below name what must not appear. */
const code = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");

const field = read("src/components/commerce/QuantityField.tsx");
const panel = read("src/components/product/ProductPurchasePanel.tsx");
const cartPage = read("src/app/cart/page.tsx");
const cartDrawer = read("src/components/commerce/CartDrawer.tsx");
const requestForm = read("src/components/product/ProductRequestForm.tsx");
const customRequestPage = read("src/app/orders/new/page.tsx");
const css = read("src/app/globals.css");

// ---------------------------------------------------------------------------
// The reported bug, stated as assertions
// ---------------------------------------------------------------------------
//
// Five in stock, the customer types 2, the field becomes 5. The old code ran
// `Math.min(Math.max(1, Number(value)), max)` on every keystroke, so the
// intermediate string "12" — what a `1` already in the box becomes when a `2`
// is typed after it — clamped straight to the maximum.

test("stock 5, type 2 → 2", () => {
  assert.deepEqual(commitQuantityInput("2", { max: 5, fallback: 1 }), { value: 2, message: null });
});

test("stock 5, type 5 → 5, at the boundary", () => {
  assert.deepEqual(commitQuantityInput("5", { max: 5, fallback: 1 }), { value: 5, message: null });
});

test("stock 5, type 6 → the safe maximum, and it says so", () => {
  const result = commitQuantityInput("6", { max: 5, fallback: 1 });
  assert.equal(result.value, 5);
  assert.match(result.message ?? "", /Only 5 available/);
});

test("every value from 1 to the maximum survives being typed", () => {
  for (let typed = QUANTITY_MIN; typed <= 5; typed += 1) {
    const result = commitQuantityInput(String(typed), { max: 5, fallback: 1 });
    assert.equal(result.value, typed, `typing ${typed} must stay ${typed}`);
    assert.equal(result.message, null);
  }
});

test("the intermediate string that caused the bug is never clamped mid-edit", () => {
  // "12" is what "1" becomes when a 2 is typed after it. Committing it is a
  // real refusal — but it is only ever reached at commit, and the field holds
  // the raw text until then. The regression is the *keystroke* clamp, which is
  // asserted against the components below.
  const result = commitQuantityInput("12", { max: 5, fallback: 1 });
  assert.equal(result.value, 5);
  assert.match(result.message ?? "", /Only 5 available/);
});

// ---------------------------------------------------------------------------
// Empty, and the values that are not numbers
// ---------------------------------------------------------------------------

test("an emptied field is a real state, not a zero and not the maximum", () => {
  assert.deepEqual(parseQuantityInput(""), { status: "empty" });
  assert.deepEqual(parseQuantityInput("   "), { status: "empty" });
});

test("blurring an empty field restores what was there, silently", () => {
  // Not the minimum and emphatically not the maximum: the customer cleared the
  // box and walked away, which is "I changed my mind", not "give me five".
  assert.deepEqual(commitQuantityInput("", { max: 5, fallback: 3 }), { value: 3, message: null });
  assert.deepEqual(commitQuantityInput("", { max: 5, fallback: 1 }), { value: 1, message: null });
});

test("0 is refused and points at the control that means it", () => {
  const result = commitQuantityInput("0", { max: 5, fallback: 2 });
  assert.equal(result.value, QUANTITY_MIN);
  assert.match(result.message ?? "", /Remove/);
});

test("-1 is refused as a minimum problem, not read as a 1", () => {
  assert.deepEqual(parseQuantityInput("-1"), { status: "invalid", reason: "negative" });
  const result = commitQuantityInput("-1", { max: 5, fallback: 2 });
  assert.equal(result.value, 2, "the previous value is restored rather than a bound being invented");
  assert.match(result.message ?? "", /smallest quantity is 1/);
});

test("2.5 is refused rather than silently truncated to 2", () => {
  assert.deepEqual(parseQuantityInput("2.5"), { status: "invalid", reason: "not_whole" });
  assert.deepEqual(parseQuantityInput("2,5"), { status: "invalid", reason: "not_whole" });
  const result = commitQuantityInput("2.5", { max: 5, fallback: 1 });
  assert.equal(result.value, 1);
  assert.match(result.message ?? "", /whole units/);
});

test("letters, scientific notation and mixed text are refused, never coerced", () => {
  for (const raw of ["abc", "1e3", "2abc", "--3", "+3", "3px", "٣"]) {
    assert.equal(parseQuantityInput(raw).status, "invalid", `${raw} must not parse as a quantity`);
  }
  // parseInt would have made these 1, 2 and 3 respectively.
  assert.equal(commitQuantityInput("1e3", { max: 5, fallback: 4 }).value, 4);
  assert.equal(commitQuantityInput("2abc", { max: 5, fallback: 4 }).value, 4);
  assert.equal(commitQuantityInput("3px", { max: 5, fallback: 4 }).value, 4);
});

test("a pasted value with whitespace or leading zeros is understood", () => {
  assert.deepEqual(commitQuantityInput("3", { max: 5, fallback: 1 }), { value: 3, message: null });
  assert.deepEqual(commitQuantityInput(" 3 ", { max: 5, fallback: 1 }), { value: 3, message: null });
  assert.deepEqual(commitQuantityInput("\t3\n", { max: 5, fallback: 1 }), { value: 3, message: null });
  assert.deepEqual(commitQuantityInput("003", { max: 5, fallback: 1 }), { value: 3, message: null });
});

test("a number too large to be an exact integer is refused, not clamped from garbage", () => {
  assert.equal(parseQuantityInput("99999999999999999999").status, "invalid");
  assert.equal(commitQuantityInput("99999999999999999999", { max: 5, fallback: 2 }).value, 2);
});

// ---------------------------------------------------------------------------
// Ceilings
// ---------------------------------------------------------------------------

test("an untracked field is bounded by the rule the server actually enforces", () => {
  // The old product page defaulted to 999 while the cart clamps a line to 99,
  // so 500 could be typed, added, and silently become 99.
  assert.equal(QUANTITY_ABSOLUTE_MAX, MAX_LINE_QUANTITY);
  assert.equal(quantityCeiling({ max: null }), MAX_LINE_QUANTITY);
  const result = commitQuantityInput("500", { max: null, fallback: 1 });
  assert.equal(result.value, MAX_LINE_QUANTITY);
  assert.match(result.message ?? "", /ordered at once/, "and it does not claim a stock level it has no basis for");
});

test("a surface with a different server rule states it, and is honoured", () => {
  // `/api/orders/custom` allows 1000, so the request wizard is not bound by the
  // cart's line cap.
  assert.equal(quantityCeiling({ max: null, absoluteMax: 1000 }), 1000);
  assert.deepEqual(commitQuantityInput("400", { max: null, absoluteMax: 1000, fallback: 1 }), {
    value: 400,
    message: null,
  });
  assert.equal(commitQuantityInput("1001", { max: null, absoluteMax: 1000, fallback: 1 }).value, 1000);
});

test("tracked stock always wins over the absolute cap, never the other way round", () => {
  assert.equal(quantityCeiling({ max: 5, absoluteMax: 1000 }), 5);
  assert.equal(quantityCeiling({ max: 5000, absoluteMax: 1000 }), 1000);
});

test("a ceiling of zero still leaves the field usable rather than un-typeable", () => {
  // Zero stock is a purchase problem, not a field problem: the buy control is
  // hidden in that case, and a ceiling below the minimum would make the field
  // refuse its own only legal value.
  assert.equal(quantityCeiling({ max: 0 }), QUANTITY_MIN);
  assert.equal(clampQuantity(3, { max: 0 }), QUANTITY_MIN);
});

// ---------------------------------------------------------------------------
// Steps — the controls that already worked must keep working
// ---------------------------------------------------------------------------

test("stepping up and down stays inside the bounds", () => {
  assert.equal(stepQuantity(1, 1, { max: 5 }), 2);
  assert.equal(stepQuantity(5, 1, { max: 5 }), 5);
  assert.equal(stepQuantity(1, -1, { max: 5 }), 1);
  assert.equal(stepQuantity(3, -1, { max: 5 }), 2);
});

test("stepping from a value that is already over the ceiling comes back inside it", () => {
  // Stock fell to 1 while 4 was in the box. Pressing − must reach a legal
  // value rather than counting down from an impossible one.
  assert.equal(stepQuantity(4, -1, { max: 1 }), 1);
  assert.equal(stepQuantity(4, 1, { max: 1 }), 1);
});

// ---------------------------------------------------------------------------
// Stock moving under a value nobody touched
// ---------------------------------------------------------------------------

test("stock dropping from 5 to 1 warns and keeps the number", () => {
  assert.equal(quantityWarning(2, 5), null);
  const warning = quantityWarning(2, 1);
  assert.match(warning ?? "", /Only 1 available/);
  // Deliberately *not* rewritten. Changing a value the customer chose, without
  // them touching it, is the same defect as changing it as they type; the
  // server refuses the line either way, which is the guarantee that matters.
});

test("an untracked product never warns, and no stock at all says so plainly", () => {
  assert.equal(quantityWarning(50, null), null);
  assert.match(quantityWarning(1, 0) ?? "", /out of stock/);
});

test("the server, not the field, is what a stale maximum is measured against", () => {
  // A tab open since yesterday can hold any `max`. Committing against it still
  // produces a number the *server* re-checks: nothing here writes stock, and
  // the ceiling only ever narrows what the field offers.
  assert.equal(clampQuantity(99, { max: 1 }), 1);
  assert.equal(clampQuantity(99, { max: null }), MAX_LINE_QUANTITY);
});

// ---------------------------------------------------------------------------
// The line ceiling the cart sends
// ---------------------------------------------------------------------------

const trackedProduct = {
  id: "p",
  name: "n",
  slug: "s",
  is_published: true,
  archived_at: null,
  purchase_mode: "direct_purchase" as const,
  starting_price_cents: 1000,
  availability_status: "available" as const,
  inventory_policy: "track" as const,
  inventory_quantity: 5,
  continue_selling_when_out_of_stock: false,
};

test("a cart line carries the ceiling, and null when stock is not the limit", () => {
  assert.equal(displayableLineCeiling(trackedProduct), 5);
  assert.equal(displayableLineCeiling({ ...trackedProduct, inventory_policy: "unlimited" }), null);
  assert.equal(displayableLineCeiling({ ...trackedProduct, continue_selling_when_out_of_stock: true }), null);
  assert.equal(displayableLineCeiling({ ...trackedProduct, availability_status: "unavailable" }), 0);
  // Never above the line cap, whatever the warehouse says.
  assert.equal(displayableLineCeiling({ ...trackedProduct, inventory_quantity: 5000 }), MAX_LINE_QUANTITY);
});

// ---------------------------------------------------------------------------
// The components: the defective pattern must be gone from every one of them
// ---------------------------------------------------------------------------

const surfaces: [string, string][] = [
  ["the product purchase panel", panel],
  ["the cart page", cartPage],
  ["the cart drawer", cartDrawer],
  ["the product request wizard", requestForm],
  ["the custom request page", customRequestPage],
];

test("no quantity surface clamps as the customer types", () => {
  for (const [name, source] of surfaces) {
    const stripped = code(source);
    assert.doesNotMatch(
      stripped,
      /Math\.min\(Math\.max\([^)]*Number\(/,
      `${name} must not clamp a keystroke`
    );
    assert.doesNotMatch(
      stripped,
      /quantity:\s*Number\(event\.target\.value\)/,
      `${name} must not post a keystroke to the server`
    );
    assert.doesNotMatch(
      stripped,
      /setQuantity\(Math\.max\(1,\s*Number\(/,
      `${name} must not refill an emptied field`
    );
    assert.doesNotMatch(stripped, /parseInt\([^)]*\)\s*\|\|/, `${name} must not use parseInt(value) || fallback`);
  }
});

test("every quantity surface goes through the one field", () => {
  for (const [name, source] of surfaces) {
    assert.match(source, /QuantityField/, `${name} must use the shared control`);
  }
  // And none of them keeps a second, hand-rolled numeric quantity box beside it.
  for (const [name, source] of surfaces) {
    assert.doesNotMatch(
      code(source),
      /type="number"[^>]*value=\{(quantity|item\.quantity|form\.quantity)\}/,
      `${name} must not keep a raw number input for quantity`
    );
  }
});

test("the field holds what was typed and decides at commit", () => {
  const stripped = code(field);
  // The draft is a string, and `null` means "showing the committed value" —
  // which is what makes an empty box representable at all.
  assert.match(stripped, /useState<string \| null>\(null\)/);
  assert.match(stripped, /onChange=\{\(event\) => \{\s*setDraft\(event\.target\.value\)/);
  assert.doesNotMatch(stripped, /onChange[\s\S]{0,200}commitQuantityInput/, "commit must not run on change");
  assert.match(stripped, /onBlur=\{\(event\) => commit\(event\.target\.value\)/);
  assert.match(stripped, /event\.key === "Enter"/);
});

test("the field is not a number input, and keeps the keyboard behaviour of one", () => {
  const stripped = code(field);
  assert.doesNotMatch(stripped, /type="number"/, 'a number input reports "" for 2.5 and for abc alike');
  assert.match(stripped, /inputMode="numeric"/, "the phone keypad is kept");
  assert.match(stripped, /pattern="\[0-9\]\*"/);
  assert.match(stripped, /event\.key === "ArrowUp"/);
  assert.match(stripped, /event\.key === "ArrowDown"/);
});

test("a value that changed elsewhere never overwrites a half-typed entry", () => {
  const stripped = code(field);
  // The draft is what is shown whenever one exists, so a refetch landing
  // mid-edit cannot replace what the customer is typing.
  assert.match(stripped, /const shown = draft \?\? String\(value\)/);
  // And it is derived, not synchronised: an earlier version cleared the draft
  // from a `useEffect` on `value`, which is a setState inside an effect and a
  // cascading render on every cart refetch.
  assert.doesNotMatch(stripped, /useEffect/, "no effect is needed to keep the draft correct");
  // Every exit from typing clears it, which is what stops a draft outliving
  // its edit.
  assert.match(stripped, /function commit\(raw: string\) \{\s*[\s\S]{0,200}setDraft\(null\)/);
  assert.match(stripped, /function step\(direction: 1 \| -1\) \{\s*[\s\S]{0,200}setDraft\(null\)/);
  assert.match(stripped, /onBlur=\{\(event\) => commit\(event\.target\.value\)/);
});

test("the step controls are real buttons with names, and disable at the bounds", () => {
  const stripped = code(field);
  const buttons = stripped.match(/<button[\s\S]*?\/button>/g) ?? [];
  assert.equal(buttons.length, 2, "one − and one +");
  for (const button of buttons) {
    assert.match(button, /type="button"/, "never a submit inside a form");
    assert.match(button, /aria-label=/, "a native spinner arrow has no accessible name; these do");
    assert.match(button, /disabled=\{disabled \|\| /);
  }
});

test("the control meets the 44px touch target on every part", () => {
  for (const selector of ["quantity-step", "quantity-input"]) {
    const rule = css.match(new RegExp(`\\.${selector} \\{([^}]*)\\}`));
    assert.ok(rule, `globals.css must define .${selector}`);
    assert.match(rule[1], /min-height: 2\.75rem/, `.${selector} must be at least 44px tall`);
  }
  assert.match(css.match(/\.quantity-step \{([^}]*)\}/)?.[1] ?? "", /min-width: 2\.75rem/);
});
