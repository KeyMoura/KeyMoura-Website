"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faXmark, faArrowRight } from "@fortawesome/free-solid-svg-icons";
import {
  catalogSearchHref,
  normalizeSuggestQuery,
  SUGGEST_LIMITS,
  suggestionCount,
  type SuggestResponse,
} from "@/lib/commerce/catalogSuggest";

/**
 * The storefront's global search.
 *
 * ## What it replaces
 *
 * A 38px icon button that opened a modal command palette. Measured at 1024px,
 * the header's navigation column had 261px of unused space beside it — so the
 * shop's search was the smallest control on the bar, and pressing it covered
 * the page with a dialog offering "Search products, projects, and threads…"
 * across four result kinds including a dormant forum. That is a community
 * site's navigator wearing a shop's hat.
 *
 * This is a real search field, on the bar, at the width the space allows, and
 * it searches **products**. The palette is untouched and still on Ctrl+K for
 * anyone who wants site-wide navigation; what changed is which of the two the
 * storefront leads with.
 *
 * ## URL, not state
 *
 * Submitting goes to `/catalog?q=…` — the same URL the catalog's own search box
 * writes and reads, so a navbar search and a catalog search are the same
 * search. There is no second query state to drift: the catalog renders "12
 * results for shift knob" from the URL it was handed, and Back works because
 * the query is a real address.
 *
 * ## Suggestions
 *
 * Debounced, aborted on every new keystroke, and bounded on the *server* to
 * five products and three categories. Nothing about the catalog is loaded into
 * the browser to make this work. An in-flight request whose query is no longer
 * current is discarded rather than rendered, which is what stops the list
 * flickering backwards through older answers on a fast typist.
 *
 * ## Combobox semantics
 *
 * `role="combobox"` on the input, `role="listbox"` on the panel,
 * `role="option"` on each row, and the active row named through
 * `aria-activedescendant`. Focus stays in the input the whole time — that is
 * the pattern's whole point — so typing continues to work while the arrow keys
 * move the selection. Escape closes the list first and clears the box second,
 * so one keypress never does both.
 */

type StorefrontSearchProps = {
  /** `header` on the bar, `drawer` inside the mobile navigation panel. */
  variant?: "header" | "drawer";
  className?: string;
  /** Called after a submit or a suggestion pick, so a drawer can close itself. */
  onNavigate?: () => void;
  autoFocus?: boolean;
};

const DEBOUNCE_MS = 180;

export default function StorefrontSearch({
  variant = "header",
  className = "",
  onNavigate,
  autoFocus = false,
}: StorefrontSearchProps) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const inputId = useId();

  const total = suggestionCount(results);
  const query = normalizeSuggestQuery(value);
  const canSuggest = query.length >= SUGGEST_LIMITS.minQueryLength;

  /*
   * One request per pause, and never a stale one rendered.
   *
   * The abort controller matters more than the debounce here: a customer typing
   * "shift knob" produces overlapping requests, and without cancelling them the
   * list is whichever response happened to land last rather than the one that
   * matches what is in the box.
   */
  useEffect(() => {
    if (!canSuggest) {
      setResults(null);
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    setLoading(true);

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/public/catalog-suggest?q=${encodeURIComponent(query)}`, {
            signal: controller.signal,
          });
          if (!response.ok) throw new Error("suggest failed");
          const payload = (await response.json()) as SuggestResponse;
          setResults(payload);
          setActive(-1);
        } catch {
          // An aborted request is the normal case, not a failure worth showing.
          // A genuine one leaves the panel offering "See all results", which is
          // still a complete search — the catalog does its own matching.
          if (!controller.signal.aborted) setResults({ query, products: [], categories: [], error: true });
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, canSuggest]);

  // Outside click closes the list. Focus is left where the click put it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const el = wrapRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
    };
  }, [open]);

  const go = useCallback(
    (href: string) => {
      setOpen(false);
      setActive(-1);
      onNavigate?.();
      router.push(href);
    },
    [onNavigate, router]
  );

  /** The href for row `index`, products first then categories, or null. */
  const hrefAt = (index: number): string | null => {
    if (!results || index < 0) return null;
    if (index < results.products.length) return `/catalog/${results.products[index].slug}`;
    const category = results.categories[index - results.products.length];
    return category ? category.href : null;
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // A highlighted suggestion wins: the customer chose a specific thing and
    // sending them to a result page for it instead would be ignoring the choice.
    const chosen = hrefAt(active);
    go(chosen ?? catalogSearchHref(value));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      // One layer at a time: the list, then the text.
      if (open) {
        event.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (value) {
        event.preventDefault();
        setValue("");
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!total) return;
      event.preventDefault();
      setOpen(true);
      setActive((current) => {
        const step = event.key === "ArrowDown" ? 1 : -1;
        // -1 is "nothing selected, Enter runs the search", and it is a real
        // position in the cycle rather than a state you can only leave.
        const next = current + step;
        if (next < -1) return total - 1;
        if (next >= total) return -1;
        return next;
      });
    }
  };

  const showPanel = open && canSuggest;
  const hasResults = Boolean(results && (results.products.length || results.categories.length));

  return (
    <div ref={wrapRef} className={`storefront-search ${className}`.trim()} data-variant={variant}>
      <form
        role="search"
        // A search landmark needs a name of its own, or a screen reader
        // announces "search" twice on the catalog, which has two.
        aria-label="Search products"
        onSubmit={submit}
        className="storefront-search-form"
      >
        <label className="sr-only" htmlFor={inputId}>
          Search products
        </label>

        <FontAwesomeIcon icon={faMagnifyingGlass} className="storefront-search-icon" aria-hidden="true" />

        <input
          ref={inputRef}
          id={inputId}
          name="q"
          type="search"
          role="combobox"
          aria-expanded={showPanel}
          aria-controls={showPanel ? listId : undefined}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-option-${active}` : undefined}
          autoComplete="off"
          autoFocus={autoFocus}
          value={value}
          placeholder="Search products…"
          onChange={(event) => {
            setValue(event.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          className="storefront-search-input no-zoom-input"
          data-testid="storefront-search-input"
        />

        {value ? (
          <button
            type="button"
            className="storefront-search-clear"
            aria-label="Clear search"
            onClick={() => {
              setValue("");
              setResults(null);
              setActive(-1);
              inputRef.current?.focus();
            }}
          >
            <FontAwesomeIcon icon={faXmark} className="h-3 w-3" aria-hidden="true" />
          </button>
        ) : null}

        <button type="submit" className="storefront-search-submit" aria-label="Search products">
          <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="storefront-search-submit-label">Search</span>
        </button>
      </form>

      {showPanel ? (
        <div className="storefront-search-panel" data-testid="storefront-search-panel">
          <ul id={listId} role="listbox" aria-label="Product suggestions" className="storefront-search-list">
            {results?.products.map((product, index) => (
              <li
                key={product.id}
                id={`${listId}-option-${index}`}
                role="option"
                aria-selected={active === index}
                className={`storefront-search-option${active === index ? " is-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  // mousedown, not click: the input blurs before click fires and
                  // the outside-click handler would have closed the panel first.
                  event.preventDefault();
                  go(`/catalog/${product.slug}`);
                }}
              >
                <span className="storefront-search-thumb" aria-hidden="true">
                  {product.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={product.image} alt="" loading="lazy" decoding="async" />
                  ) : (
                    <span className="storefront-search-thumb-fallback">KM</span>
                  )}
                </span>
                <span className="storefront-search-option-text">
                  <span className="storefront-search-option-name">{product.name}</span>
                  {product.category ? (
                    <span className="storefront-search-option-meta">{product.category}</span>
                  ) : null}
                </span>
                <span className="storefront-search-option-price">{product.price}</span>
              </li>
            ))}

            {results?.categories.map((category, offset) => {
              const index = (results.products.length ?? 0) + offset;
              return (
                <li
                  key={category.href}
                  id={`${listId}-option-${index}`}
                  role="option"
                  aria-selected={active === index}
                  className={`storefront-search-option is-category${active === index ? " is-active" : ""}`}
                  onMouseEnter={() => setActive(index)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    go(category.href);
                  }}
                >
                  <span className="storefront-search-option-text">
                    <span className="storefront-search-option-name">{category.trail}</span>
                    <span className="storefront-search-option-meta">Category</span>
                  </span>
                  <span className="storefront-search-option-price">{category.count}</span>
                </li>
              );
            })}
          </ul>

          {!hasResults && !loading ? (
            <p className="storefront-search-empty">
              Nothing matches “{query}” yet — the full catalog search may still find it.
            </p>
          ) : null}

          {/*
            Always offered, including when there are no suggestions: the catalog
            searches descriptions this endpoint only samples, and a dead end at
            the moment a customer has finished typing is the worst place to have
            one. Not a listbox option, so the arrow keys cannot land on it and
            Enter with nothing selected already goes here.
          */}
          <button
            type="button"
            className="storefront-search-all"
            onMouseDown={(event) => {
              event.preventDefault();
              go(catalogSearchHref(value));
            }}
          >
            See all results for “{query}”
            <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3 shrink-0" aria-hidden="true" />
          </button>

          {/* The count, for anyone who cannot see the list change under them. */}
          <p className="sr-only" role="status" aria-live="polite">
            {loading ? "Searching" : `${total} suggestion${total === 1 ? "" : "s"}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
