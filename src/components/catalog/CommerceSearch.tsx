"use client";

import { useRef } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faXmark } from "@fortawesome/free-solid-svg-icons";

type CommerceSearchProps = {
  /** The text in the box. Held by the parent so the grid can filter as it is typed. */
  value: string;
  onChange: (next: string) => void;
  /** Enter or the button: commit the text to the URL now, without waiting for the debounce. */
  onSubmit: (value: string) => void;
  onClear: () => void;
  /** The id the label points at. Supplied so two instances cannot collide. */
  inputId: string;
  placeholder?: string;
  className?: string;
};

/**
 * The storefront's search control.
 *
 * ## Why this is a form and not an input
 *
 * The catalog filters as you type, so a submit button is technically redundant
 * — and it was left out for exactly that reason, which is how the storefront
 * ended up with a search box indistinguishable from an admin table's filter
 * field. On a shop, search is the primary way a customer states what they came
 * for, and a bare input with a placeholder does not read as a thing you *do*.
 * A labelled row with an icon, a real submit button and a visible clear action
 * does.
 *
 * The button is not decorative. It gives the control a keyboard-and-touch
 * commit that skips the 350ms debounce, it gives the mobile keyboard a real
 * "Search" key through `type="search"` inside a form, and it is the affordance
 * that tells a customer this box is worth typing a sentence into. Enter submits
 * the form, which is the same path.
 *
 * ## Why the parent owns the text
 *
 * The results filter from a list already in memory, so the grid can respond to
 * every keystroke. The URL is the source of truth and catches up when the
 * typing pauses (see `CatalogBrowser`). This component is the presentation of
 * that arrangement and holds no state of its own beyond a ref for focus.
 */
export default function CommerceSearch({
  value,
  onChange,
  onSubmit,
  onClear,
  inputId,
  // Short on purpose. "Search products, categories, or keywords" is more
  // informative and does not fit: at 375 the field is about 250px and the
  // sentence clips mid-word, which reads as a broken control rather than a
  // helpful one. The icon and the button already say this is a search; the
  // placeholder only has to say what is being searched.
  placeholder = "Search products…",
  className,
}: CommerceSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <form
      role="search"
      // A search landmark needs a name of its own; without one a screen reader
      // announces "search" twice on any page that has a second one.
      aria-label="Search products"
      className={`commerce-search ${className ?? ""}`.trim()}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
        // Keeps the caret where the customer left it after a submit, so a
        // refinement is one keystroke rather than a re-click.
        inputRef.current?.focus();
      }}
    >
      <div className="commerce-search-field">
        <label className="sr-only" htmlFor={inputId}>
          Search products
        </label>
        <FontAwesomeIcon icon={faMagnifyingGlass} className="commerce-search-icon" aria-hidden="true" />
        <input
          ref={inputRef}
          id={inputId}
          name="q"
          type="search"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          // The browser's own clear affordance is suppressed in the stylesheet:
          // it is unlabelled, invisible to a screen reader, and sits where our
          // own button goes. This one has a name.
          className="commerce-search-input"
        />
        {value ? (
          <button
            type="button"
            onClick={() => {
              onClear();
              inputRef.current?.focus();
            }}
            className="commerce-search-clear"
            aria-label="Clear search"
          >
            <FontAwesomeIcon icon={faXmark} className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      <button type="submit" className="ui-btn ui-btn-primary commerce-search-submit">
        <FontAwesomeIcon icon={faMagnifyingGlass} className="commerce-search-submit-icon" aria-hidden="true" />
        <span className="commerce-search-submit-label">Search</span>
      </button>
    </form>
  );
}
