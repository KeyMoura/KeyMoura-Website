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
  /**
   * The department currently being browsed, when there is one.
   *
   * Names the control after what it actually narrows — "Filter Interior" rather
   * than "Search products" — which is the difference between this and the
   * navbar's search. See the note below.
   */
  scopeName?: string | null;
  className?: string;
};

/**
 * The catalog's own filter.
 *
 * ## Why it is a filter now, and not a second search
 *
 * It used to call itself "Search products", with a search landmark of that
 * name, a `Search` button and a "Search products…" placeholder — while the
 * navbar, two inches above it, carried a control with the identical name that
 * writes the identical `?q=` parameter. Two boxes, one search: a screen reader
 * met two `search` landmarks called the same thing on one page, and a customer
 * met a field that looked like it might search something *else*.
 *
 * It was not removed, because it does something the navbar cannot. The navbar
 * navigates — every scope it offers resolves to a URL and going there is the
 * whole interaction. This narrows the list already on the screen, per keystroke,
 * from products already in memory, without a round trip. Refining in place and
 * going somewhere are different actions, and the brief's rule keeps a local
 * control that serves a genuinely different scoped purpose.
 *
 * So what changed is what it claims to be. It is named for the narrowing it
 * does, it says which department it is narrowing when the customer is inside
 * one, and its landmark no longer collides with the global search's.
 *
 * ## Why this is a form and not an input
 *
 * The catalog filters as you type, so a submit button is technically redundant
 * — and it was left out for exactly that reason, which is how the storefront
 * ended up with a filter field indistinguishable from an admin table's. The
 * button gives the control a keyboard-and-touch commit that skips the 350ms
 * debounce, it gives the mobile keyboard a real action key through
 * `type="search"` inside a form, and it is the affordance that tells a customer
 * this box is worth typing into. Enter submits the form, which is the same path.
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
  scopeName,
  className,
}: CommerceSearchProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Short on purpose. "Filter by name, description, or keyword" is more
  // informative and does not fit: at 375 the field is about 250px and the
  // sentence clips mid-word, which reads as a broken control rather than a
  // helpful one. The icon and the button already say what kind of control this
  // is; the label only has to say what it narrows.
  const label = scopeName ? `Filter ${scopeName}` : "Filter products";
  const placeholder = `${label}…`;

  return (
    <form
      role="search"
      // A search landmark needs a name of its own; without one a screen reader
      // announces "search" twice on this page, which has the navbar's as well.
      aria-label={label}
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
          {label}
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
            aria-label="Clear filter"
          >
            <FontAwesomeIcon icon={faXmark} className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/* `aria-label` as well as the visible word, because the word is hidden
          below the breakpoint where the button becomes icon-only. */}
      <button type="submit" className="ui-btn ui-btn-primary commerce-search-submit" aria-label={label}>
        <FontAwesomeIcon icon={faMagnifyingGlass} className="commerce-search-submit-icon" aria-hidden="true" />
        <span className="commerce-search-submit-label">Filter</span>
      </button>
    </form>
  );
}
