/**
 * Quantity parsing, clamping and commit rules.
 *
 * Pure and dependency-free, so the product page, the cart page, the cart
 * drawer, the request wizard and the tests all read the same rules. Four
 * copies of "what does typing this mean" is how one of them quietly starts
 * disagreeing with the others — which is exactly what happened here.
 *
 * ## The defect this exists to close
 *
 * Every quantity field clamped **on every keystroke**:
 *
 *     const next = Number(event.target.value);
 *     setQuantity(Math.min(Math.max(1, next), maxQuantity ?? 999));
 *
 * With five in stock and `1` already in the box, typing `2` produces the
 * intermediate string `"12"` — and `Math.min(12, 5)` is `5`. The customer
 * typed a 2 and watched the field become a 5. Clearing the box first does not
 * help: `Number("")` is `0`, `Math.max(1, 0)` is `1`, so the field refills
 * itself the instant it is emptied and the next keystroke appends to a digit
 * the customer did not type.
 *
 * The arrows worked because they never produce an intermediate value.
 *
 * ## The rule
 *
 * **A keystroke is not a decision.** While the field has focus it holds
 * exactly what was typed, including nothing at all. Parsing, clamping and
 * refusing all happen at *commit* — blur, Enter, or pressing a step button —
 * which is the first moment the customer has actually said what they mean.
 *
 * Nothing here is authoritative. The server re-checks availability when the
 * line is added, when the cart is displayed and again at checkout, so a stale
 * `max` in a browser tab cannot oversell. This module decides what the *field*
 * does, never what may be bought.
 */

/** A cart line is at least one unit; zero is "remove", which is its own control. */
export const QUANTITY_MIN = 1;

/**
 * The ceiling when nothing else limits the field.
 *
 * 99 mirrors `MAX_LINE_QUANTITY` in `pricing.ts`, which is the number the
 * server actually enforces on a cart line. The product page previously
 * defaulted to 999 for an untracked product — so a customer could type 500,
 * add it, and find 99 in their cart with nothing said. A field whose ceiling
 * is looser than the server's is a field that silently rewrites the number.
 *
 * Surfaces with a different server rule pass their own (`absoluteMax`); the
 * custom-request wizard does, because `/api/orders/custom` allows 1000.
 */
export const QUANTITY_ABSOLUTE_MAX = 99;

export type QuantityBounds = {
  /** Tracked stock, or `null` when stock is not what limits this field. */
  max: number | null | undefined;
  /** The server rule this field mirrors. Defaults to the cart line cap. */
  absoluteMax?: number;
};

export type QuantityParse =
  | { status: "empty" }
  | { status: "invalid"; reason: "not_whole" | "negative" | "not_a_number" }
  | { status: "ok"; value: number };

/**
 * What a raw field value means, without deciding anything about it.
 *
 * Deliberately **not** `parseInt`. `parseInt("2.9")` is `2`, `parseInt("2abc")`
 * is `2`, and `parseInt("1e3")` is `1` — each of which silently turns what the
 * customer typed into a different number. Pass 4 fixed the same class of bug in
 * the staff discount form, where `Math.trunc` published a 12% code for someone
 * who typed 12.5. Refusing clearly is the honest answer; quietly changing the
 * number is not.
 *
 * Surrounding whitespace is dropped, because a pasted value routinely carries
 * it and " 3 " is unambiguously a 3.
 */
export function parseQuantityInput(raw: string): QuantityParse {
  const trimmed = raw.trim();
  if (!trimmed) return { status: "empty" };

  // Digits only. Leading zeros are fine ("007" is a 7); everything else is
  // named rather than coerced.
  if (/^\d+$/.test(trimmed)) {
    const value = Number(trimmed);
    // A number long enough to lose integer precision is not a quantity anyone
    // typed on purpose, and beyond `Number.MAX_SAFE_INTEGER` the comparisons
    // below stop distinguishing values that differ.
    if (!Number.isSafeInteger(value)) return { status: "invalid", reason: "not_a_number" };
    return { status: "ok", value };
  }

  if (/^-\s*\d/.test(trimmed)) return { status: "invalid", reason: "negative" };
  if (/^\d+[.,]\d*$/.test(trimmed) || /^[.,]\d+$/.test(trimmed)) {
    return { status: "invalid", reason: "not_whole" };
  }
  return { status: "invalid", reason: "not_a_number" };
}

/** The ceiling in force for a field, never above the server's own rule. */
export function quantityCeiling(bounds: QuantityBounds): number {
  const absolute = Math.max(QUANTITY_MIN, Math.trunc(bounds.absoluteMax ?? QUANTITY_ABSOLUTE_MAX));
  const { max } = bounds;
  if (max == null || !Number.isFinite(max)) return absolute;
  return Math.max(QUANTITY_MIN, Math.min(Math.trunc(max), absolute));
}

export function clampQuantity(value: number, bounds: QuantityBounds): number {
  return Math.min(Math.max(QUANTITY_MIN, Math.trunc(value)), quantityCeiling(bounds));
}

export type QuantityCommit = {
  /** The value the field should hold from now on. */
  value: number;
  /**
   * Why it is not what was typed, or `null` when it is.
   *
   * A message is only ever produced when the field *changed* the customer's
   * input. Normalising an empty box back to the value it already had is not
   * news and says nothing.
   */
  message: string | null;
};

/**
 * What a field becomes when the customer stops editing it.
 *
 * `fallback` is the value the field held before this edit, so abandoning a
 * half-typed entry restores what was there rather than jumping to a bound.
 * That is the difference between "I changed my mind" and "the box picked a
 * number for me".
 */
export function commitQuantityInput(
  raw: string,
  options: QuantityBounds & { fallback: number }
): QuantityCommit {
  const ceiling = quantityCeiling(options);
  const fallback = clampQuantity(options.fallback, options);
  const parsed = parseQuantityInput(raw);

  if (parsed.status === "empty") return { value: fallback, message: null };

  if (parsed.status === "invalid") {
    if (parsed.reason === "not_whole") {
      return { value: fallback, message: "Quantities are whole units." };
    }
    if (parsed.reason === "negative") {
      return { value: fallback, message: `The smallest quantity is ${QUANTITY_MIN}.` };
    }
    return { value: fallback, message: "Enter a quantity as a number." };
  }

  if (parsed.value < QUANTITY_MIN) {
    return {
      value: QUANTITY_MIN,
      // Zero is the one refused value with an obvious intent behind it, so it
      // gets its own sentence pointing at the control that does what was meant.
      message:
        parsed.value === 0
          ? "Use Remove to take this out of your cart."
          : `The smallest quantity is ${QUANTITY_MIN}.`,
    };
  }

  if (parsed.value > ceiling) {
    return {
      value: ceiling,
      message:
        options.max == null || !Number.isFinite(options.max)
          ? `The most that can be ordered at once is ${ceiling}.`
          : `Only ${ceiling} available.`,
    };
  }

  return { value: parsed.value, message: null };
}

/**
 * Whether the field should say something about a value it is already holding.
 *
 * Stock moves while a page is open. When it drops below a quantity the
 * customer already chose, the field says so and **keeps the number** rather
 * than rewriting it underneath them — silently changing a value nobody touched
 * is the defect this module exists to close, and it is no better when the
 * trigger is a refetch than when it is a keystroke. The server refuses the line
 * either way, which is the guarantee that matters.
 */
export function quantityWarning(value: number, max: number | null | undefined): string | null {
  if (max == null || !Number.isFinite(max)) return null;
  const ceiling = Math.trunc(max);
  if (ceiling <= 0) return "This product is out of stock.";
  return value > ceiling ? `Only ${ceiling} available — reduce the quantity to continue.` : null;
}

/** One step up or down, bounded, for the − and + controls and the arrow keys. */
export function stepQuantity(value: number, direction: 1 | -1, bounds: QuantityBounds): number {
  return clampQuantity(clampQuantity(value, bounds) + direction, bounds);
}
