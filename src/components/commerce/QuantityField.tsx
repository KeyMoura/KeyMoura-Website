"use client";

import { useId, useRef, useState } from "react";
import {
  commitQuantityInput,
  quantityCeiling,
  quantityWarning,
  stepQuantity,
} from "@/lib/commerce/quantity";

type QuantityFieldProps = {
  /** The committed quantity. This component never owns it. */
  value: number;
  /** Available stock, or `null` when the product tracks none. */
  max: number | null;
  /**
   * The server rule this field mirrors, when it is not the cart line cap.
   * Stated rather than assumed: a field looser than its server is a field that
   * silently rewrites what the customer asked for.
   */
  absoluteMax?: number;
  /** Called only when the customer has finished saying what they mean. */
  onCommit: (quantity: number) => void;
  label?: string;
  /** Names the line this field belongs to, for a screen reader in a cart. */
  describedItem?: string;
  disabled?: boolean;
  size?: "default" | "compact";
  /** Renders "5 available" beside the control. Off inside a cart row. */
  showMax?: boolean;
  id?: string;
};

/**
 * One quantity control, used by the product page, the cart page and the cart
 * drawer.
 *
 * ## Why the text is not clamped as it is typed
 *
 * See `src/lib/commerce/quantity.ts`. In short: with five in stock and a `1`
 * in the box, typing `2` makes the intermediate string `"12"`, and clamping
 * that to the maximum turned a typed 2 into a 5. **While the field has focus
 * it holds exactly what was typed**, including an empty string; parsing and
 * clamping happen at commit — blur, Enter, or a step button.
 *
 * That also removes a second defect the cart had: it posted a mutation on
 * every keystroke, so clearing the box sent `quantity: 0` to the server and
 * typing `12` asked for a 1 before it asked for a 12.
 *
 * ## Why this is not `<input type="number">`
 *
 * A number input reports `value === ""` for anything the browser considers
 * incomplete, so "2.5" and "abc" arrive here indistinguishable from an empty
 * box — the field cannot say *why* it refused something it never saw. It also
 * varies by browser on whether a scroll wheel over a focused field changes the
 * value, which is a surprising way to buy four of something.
 *
 * `inputMode="numeric"` gives the same keypad on a phone. The spinners are
 * replaced by real buttons, which are larger than a native spinner arrow
 * (44px, the WCAG 2.2 AA target), keyboard reachable, and nameable — a native
 * spinner has no accessible name at all. ArrowUp and ArrowDown keep working on
 * the field itself, so the keyboard behaviour a number input provides is kept
 * rather than dropped.
 */
export default function QuantityField({
  value,
  max,
  absoluteMax,
  onCommit,
  label = "Quantity",
  describedItem,
  disabled = false,
  size = "default",
  showMax = true,
  id,
}: QuantityFieldProps) {
  const generatedId = useId();
  const inputId = id ?? `quantity-${generatedId}`;
  const messageId = `${inputId}-message`;

  /**
   * What the box shows while it is being edited, or `null` when it is showing
   * the committed value.
   *
   * Keeping "editing" as a distinct state is what lets the box be empty. A
   * single numeric state cannot represent an empty field, which is why the
   * previous implementation refilled itself the moment it was cleared.
   */
  const [draft, setDraft] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  /*
   * A quantity that changed elsewhere — a refetch, another tab, a server
   * correction — must not overwrite a half-typed entry, and the draft must not
   * outlive the edit that created it.
   *
   * Both hold without an effect. A draft exists only while the customer is
   * typing, and every exit from typing clears it: `commit` runs on blur and on
   * Enter, and `step` clears it too. So `draft ?? String(value)` shows what was
   * typed while it is being typed and the live value at every other moment.
   *
   * The earlier version cleared the draft from a `useEffect` on `value`, which
   * is a `setState` inside an effect — a cascading render on every cart
   * refetch, and exactly what `react-hooks/set-state-in-effect` exists to
   * catch. Deriving it is both correct and cheaper.
   */
  const bounds = { max, absoluteMax };
  const ceiling = quantityCeiling(bounds);
  const shown = draft ?? String(value);
  const warning = quantityWarning(value, max);
  const notice = message ?? warning;

  function commit(raw: string) {
    const result = commitQuantityInput(raw, { ...bounds, fallback: value });
    setDraft(null);
    setMessage(result.message);
    if (result.value !== value) onCommit(result.value);
  }

  function step(direction: 1 | -1) {
    const next = stepQuantity(value, direction, bounds);
    setDraft(null);
    setMessage(null);
    if (next !== value) onCommit(next);
  }

  const compact = size === "compact";

  return (
    <div className="quantity-field">
      <label htmlFor={inputId} className={compact ? "sr-only" : "quantity-field-label"}>
        {label}
        {describedItem ? ` for ${describedItem}` : null}
      </label>

      <div className={`quantity-stepper${compact ? " is-compact" : ""}`}>
        <button
          type="button"
          className="quantity-step"
          onClick={() => step(-1)}
          disabled={disabled || value <= 1}
          aria-label={describedItem ? `Decrease quantity for ${describedItem}` : "Decrease quantity"}
          aria-controls={inputId}
        >
          <span aria-hidden="true">−</span>
        </button>

        <input
          ref={inputRef}
          id={inputId}
          // Text, not number: see the note above. `pattern` keeps the numeric
          // keypad on iOS, which ignores `inputMode` on some versions.
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          value={shown}
          disabled={disabled}
          // The box holds what was typed. No parsing, no clamping, no request.
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage(null);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onBlur={(event) => commit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit(event.currentTarget.value);
              return;
            }
            // The arrow-key behaviour a native number input would have given,
            // kept rather than lost along with the spinners.
            if (event.key === "ArrowUp") {
              event.preventDefault();
              step(1);
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              step(-1);
            }
          }}
          aria-describedby={notice ? messageId : undefined}
          className="quantity-input"
        />

        <button
          type="button"
          className="quantity-step"
          onClick={() => step(1)}
          disabled={disabled || value >= ceiling}
          aria-label={describedItem ? `Increase quantity for ${describedItem}` : "Increase quantity"}
          aria-controls={inputId}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>

      {showMax && max != null ? <span className="quantity-max">{max} available</span> : null}

      {/*
        One live region for both cases. A refusal ("Only 5 available") and a
        stock change under an untouched value ("reduce the quantity") are the
        same news to whoever is reading the page, and two regions would
        announce one of them twice.
      */}
      {notice ? (
        <p id={messageId} role="status" aria-live="polite" className="quantity-message">
          {notice}
        </p>
      ) : null}
    </div>
  );
}
