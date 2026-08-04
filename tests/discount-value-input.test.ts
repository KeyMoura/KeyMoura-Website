import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { buildDiscountDraft, parseDiscountValue } from "../src/lib/commerce/discountAdmin.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const page = read("src/app/staff/catalog/discounts/page.tsx");

const base = { code: "SPRING10", description: "", startsAt: "", endsAt: "", maxDiscount: "", minimumSubtotal: "" };
const draftFor = (discountType: string, discountValue: string) =>
  buildDiscountDraft({ ...base, discountType, discountValue });

// ---------------------------------------------------------------------------
// Typing a percentage
// ---------------------------------------------------------------------------

test("a typed whole percentage is stored exactly as typed", () => {
  for (const typed of ["1", "5", "10", "25", "99", "100"]) {
    const result = parseDiscountValue("percent", typed);
    assert.deepEqual(result, { ok: true, value: Number(typed) }, `"${typed}" must survive unchanged`);
  }
});

test("the field accepts the intermediate states of typing", () => {
  // The input holds a string and is never coerced mid-edit, so these are the
  // states the box legitimately passes through. Each has to produce its own
  // sentence rather than a range error about a number nobody entered.
  assert.deepEqual(parseDiscountValue("percent", ""), {
    ok: false,
    problem: "Give the discount a value.",
  });
  assert.deepEqual(parseDiscountValue("percent", "   "), {
    ok: false,
    problem: "Give the discount a value.",
  });
});

test("an empty field is not silently read as zero", () => {
  // `Number("")` is 0, which is finite, so an empty box used to slip past the
  // "is this a number" guard and come back as "a percentage discount is between
  // 1 and 100" — an answer to a question nobody asked.
  const result = parseDiscountValue("percent", "");
  assert.equal(result.ok, false);
  assert.doesNotMatch((result as { problem: string }).problem, /between 1 and 100/);
});

test("clearing and retyping lands on the new value, not the old one", () => {
  assert.deepEqual(parseDiscountValue("percent", "10"), { ok: true, value: 10 });
  assert.equal(parseDiscountValue("percent", "").ok, false);
  assert.deepEqual(parseDiscountValue("percent", "35"), { ok: true, value: 35 });
});

test("a pasted value with surrounding whitespace is accepted", () => {
  assert.deepEqual(parseDiscountValue("percent", "  25  "), { ok: true, value: 25 });
  assert.deepEqual(parseDiscountValue("fixed", " 12.50 "), { ok: true, value: 1250 });
});

// ---------------------------------------------------------------------------
// Decimals: refused, not truncated
// ---------------------------------------------------------------------------

test("a decimal percentage is refused rather than quietly truncated", () => {
  // The regression. `discount_codes.discount_value` is an integer and the CHECK
  // pins percentages to 1..100, so 12.5% cannot be stored. This used to
  // Math.trunc, so staff typed 12.5, saw no complaint, and published 12%.
  const result = parseDiscountValue("percent", "12.5");
  assert.equal(result.ok, false);
  assert.match((result as { problem: string }).problem, /whole number/);

  for (const typed of ["0.5", "99.9", "10.0001"]) {
    assert.equal(parseDiscountValue("percent", typed).ok, false, `${typed} must be refused`);
  }
});

test("a percentage that is a whole number written with a decimal point is fine", () => {
  // "10.0" is still ten percent; refusing it would be pedantry.
  assert.deepEqual(parseDiscountValue("percent", "10.0"), { ok: true, value: 10 });
});

test("a fixed amount takes dollars and cents but no finer", () => {
  assert.deepEqual(parseDiscountValue("fixed", "12.50"), { ok: true, value: 1250 });
  assert.deepEqual(parseDiscountValue("fixed", "5"), { ok: true, value: 500 });
  assert.deepEqual(parseDiscountValue("fixed", "0.01"), { ok: true, value: 1 });

  const tooFine = parseDiscountValue("fixed", "12.345");
  assert.equal(tooFine.ok, false, "a third decimal place would be rounded away silently");
  assert.match((tooFine as { problem: string }).problem, /two decimal places/);
});

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

test("negative and out-of-range percentages are refused", () => {
  for (const typed of ["-1", "-25", "0"]) {
    const result = parseDiscountValue("percent", typed);
    assert.equal(result.ok, false, `${typed} must be refused`);
    assert.match((result as { problem: string }).problem, /between 1 and 100/);
  }
  assert.equal(parseDiscountValue("percent", "101").ok, false);
  assert.equal(parseDiscountValue("percent", "1000").ok, false);
  assert.deepEqual(parseDiscountValue("percent", "100"), { ok: true, value: 100 }, "100% is the boundary and allowed");
});

test("a negative or zero fixed amount is refused", () => {
  assert.equal(parseDiscountValue("fixed", "-5").ok, false);
  assert.equal(parseDiscountValue("fixed", "0").ok, false);
});

test("nonsense is refused with its own sentence", () => {
  for (const typed of ["abc", "1,5", "--", "1e", "NaN"]) {
    const result = parseDiscountValue("percent", typed);
    assert.equal(result.ok, false, `${typed} must be refused`);
  }
  assert.deepEqual(parseDiscountValue("percent", "abc"), { ok: false, problem: "That is not a number." });
});

// ---------------------------------------------------------------------------
// The two types stay independent
// ---------------------------------------------------------------------------

test("the same digits mean different things in each type", () => {
  assert.deepEqual(parseDiscountValue("percent", "10"), { ok: true, value: 10 }, "ten percent");
  assert.deepEqual(parseDiscountValue("fixed", "10"), { ok: true, value: 1000 }, "ten dollars, in cents");
});

test("a value valid for one type can be invalid for the other", () => {
  // $150.00 is a fine fixed discount; 150% is not a discount at all.
  assert.deepEqual(parseDiscountValue("fixed", "150"), { ok: true, value: 15000 });
  assert.equal(parseDiscountValue("percent", "150").ok, false);
});

test("switching type clears the value instead of reinterpreting it", () => {
  // "10" as a percentage and "10" as dollars are the same digits and a very
  // different offer; carrying it across is how a ten-percent code ships as a
  // ten-dollar one.
  assert.match(page, /function changeDiscountType/);
  assert.match(page, /setDraft\(\{ \.\.\.draft, discountType, discountValue: "" \}\)/);
  assert.match(page, /onChange=\{\(event\) => changeDiscountType\(/);
});

// ---------------------------------------------------------------------------
// Whole-draft behaviour, create and edit
// ---------------------------------------------------------------------------

test("a valid percentage discount builds a row", () => {
  const result = draftFor("percent", "25");
  assert.equal(result.ok, true);
  assert.equal((result as { draft: { discount_value: number } }).draft.discount_value, 25);
  assert.equal((result as { draft: { discount_type: string } }).draft.discount_type, "percent");
});

test("a valid fixed discount builds a row in cents", () => {
  const result = draftFor("fixed", "12.50");
  assert.equal(result.ok, true);
  assert.equal((result as { draft: { discount_value: number } }).draft.discount_value, 1250);
});

test("the draft builder refuses what the field refuses, with the same words", () => {
  // One parser, so the inline message and the route's reply cannot drift.
  for (const [type, typed] of [
    ["percent", "12.5"],
    ["percent", ""],
    ["percent", "0"],
    ["percent", "101"],
    ["fixed", "0"],
    ["fixed", "12.345"],
  ] as const) {
    const direct = parseDiscountValue(type, typed);
    const viaDraft = draftFor(type, typed);
    assert.equal(direct.ok, false);
    assert.equal(viaDraft.ok, false, `${type} "${typed}" must be refused by the draft builder too`);
    assert.equal(
      (viaDraft as { problem: string }).problem,
      (direct as { problem: string }).problem,
      "the two validators must produce one sentence"
    );
  }
});

test("the stored percentage still satisfies the database CHECK", () => {
  // discount_codes_value_check: percent => discount_value between 1 and 100,
  // integer column. Anything this parser accepts must fit that.
  for (const typed of ["1", "50", "100"]) {
    const result = parseDiscountValue("percent", typed);
    assert.equal(result.ok, true);
    const value = (result as { value: number }).value;
    assert.ok(Number.isInteger(value) && value >= 1 && value <= 100);
  }
});

// ---------------------------------------------------------------------------
// The form surface
// ---------------------------------------------------------------------------

test("the value field is a plain controlled string, never coerced mid-edit", () => {
  // Coercing on every keystroke is the classic way a numeric field becomes
  // untypeable: the box snaps back to 0 the moment it is emptied.
  assert.match(page, /value=\{draft\.discountValue\}/);
  assert.match(page, /onChange=\{\(event\) => setDraft\(\{ \.\.\.draft, discountValue: event\.target\.value \}\)\}/);
  assert.doesNotMatch(page, /discountValue: Number\(/);
  assert.doesNotMatch(page, /discountValue: parseInt|discountValue: parseFloat/);
});

test("the keypad matches what the field will accept", () => {
  // A decimal keypad on a whole-number field invites a value the column cannot
  // hold.
  assert.match(page, /inputMode=\{draft\.discountType === "percent" \? "numeric" : "decimal"\}/);
});

test("validation is announced inline and tied to the field", () => {
  assert.match(page, /aria-invalid=\{showValueError \|\| undefined\}/);
  assert.match(page, /aria-describedby=\{showValueError \? "discount-value-error" : "discount-value-hint"\}/);
  assert.match(page, /id="discount-value-error"[\s\S]{0,60}role="alert"/);
  assert.match(page, /id="discount-value-hint"/);
});

test("the error waits for a blur or a submit rather than firing mid-keystroke", () => {
  assert.match(page, /const showValueError = valueTouched && !valueCheck\.ok/);
  assert.match(page, /onBlur=\{\(\) => setValueTouched\(true\)\}/);
  // Opening a fresh form, or an existing code, must not start marked invalid.
  assert.equal((page.match(/setValueTouched\(false\)/g) ?? []).length, 3);
});

test("submitting an invalid value stops locally and moves focus to the field", () => {
  assert.match(page, /if \(!valueCheck\.ok\) \{/);
  assert.match(page, /document\.getElementById\("discount-value"\)\?\.focus\(\)/);
});

test("the form and the server share one validator", () => {
  assert.match(page, /parseDiscountValue/, "the page must not reimplement the rules");
  assert.match(page, /const valueCheck = parseDiscountValue\(draft\.discountType, draft\.discountValue\)/);
});
