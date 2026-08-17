"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faMagnifyingGlass, faXmark, faArrowRight } from "@fortawesome/free-solid-svg-icons";
import {
  normalizeSuggestQuery,
  SUGGEST_LIMITS,
  suggestionRows,
  type SuggestResponse,
  type SuggestRow,
} from "@/lib/commerce/catalogSuggest";
import {
  ALL_SCOPE,
  buildSearchScopes,
  projectsDestination,
  resolveScope,
  scopeGroups,
  scopePlaceholder,
  scopeSearchLabel,
  searchDestination,
} from "@/lib/commerce/searchScopes";
import { EMPTY_STOREFRONT_NAV, type StorefrontNav } from "@/lib/commerce/storefrontNavModel";

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
 * This is a real search field, on the bar, at the width the space allows. The
 * palette is untouched and still on Ctrl+K for anyone who wants site-wide
 * navigation; what changed is which of the two the storefront leads with.
 *
 * ## The scope selector
 *
 * `[ All ▾ ][ Search… ][ Search ]`, the shape every shop uses, and for the
 * reason every shop uses it: this business sells catalog products *and* custom
 * work, and publishes project write-ups that are most of what it actually
 * makes. A single unscoped box could only ever hand all three to `/catalog`,
 * so "cnc" — which lives in the Gallery — returned nothing and looked like a
 * broken search rather than a scoped one.
 *
 * The scopes come from `buildSearchScopes`, which reads the **same
 * `StorefrontNav`** the Products dropdown is built from. There is no second
 * list of categories: a scope cannot name a department the catalog does not
 * have, and an emptied category leaves the dropdown at the same moment it
 * leaves the menu.
 *
 * It is a native `<select>`. A styled listbox would have been a second custom
 * dropdown sitting inches from the Products one — two panels that can be open
 * at once, competing for the same corner of the viewport and the same Escape
 * key. The native control renders in the platform layer where it cannot collide
 * with either, and arrives with keyboard support, a touch picker and a screen
 * reader contract already correct.
 *
 * ## URL, not state
 *
 * Submitting goes to a real address — `/catalog?q=…`, `/catalog/interior?q=…`
 * or `/projects?q=…` — every one of which already read `?q=` before this
 * existed. The catalog renders "12 results for shift knob" from the URL it was
 * handed, and Back works because the query is a place.
 *
 * ## Suggestions
 *
 * Debounced, aborted on every new keystroke, and bounded on the *server*.
 * Nothing about the catalog is loaded into the browser to make this work. An
 * in-flight request whose query **or scope** is no longer current is discarded
 * rather than rendered, which is what stops the list flickering backwards
 * through older answers on a fast typist — or showing the previous scope's
 * products for a moment after the scope changes.
 *
 * ## Combobox semantics
 *
 * `role="combobox"` on the input, `role="listbox"` on the panel, `role="group"`
 * per result kind, `role="option"` on each row, and the active row named
 * through `aria-activedescendant`. Focus stays in the input the whole time —
 * that is the pattern's whole point — so typing continues to work while the
 * arrow keys move the selection. Escape closes the list first and clears the
 * box second, so one keypress never does both.
 *
 * The groups are what make a mixed result list readable: a product, a category
 * and a project are three different kinds of destination, and a flat list of
 * them is a list where the customer cannot tell what pressing Enter will do.
 * Each row also carries its kind in words, because a heading is only visible
 * while you are looking at the top of the group.
 */

type StorefrontSearchProps = {
  /** `header` on the bar, `drawer` inside the mobile navigation panel. */
  variant?: "header" | "drawer";
  className?: string;
  /** Called after a submit or a suggestion pick, so a drawer can close itself. */
  onNavigate?: () => void;
  autoFocus?: boolean;
  /** The catalog hierarchy the scope dropdown is built from. */
  nav?: StorefrontNav;
};

const DEBOUNCE_MS = 180;

const GROUP_LABELS = { product: "Products", category: "Categories", project: "Projects" } as const;
/** The word on the row itself, singular — "Product", not "Products". */
const KIND_LABELS = { product: "Product", category: "Category", project: "Project" } as const;

export default function StorefrontSearch({
  variant = "header",
  className = "",
  onNavigate,
  autoFocus = false,
  nav = EMPTY_STOREFRONT_NAV,
}: StorefrontSearchProps) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [scopeId, setScopeId] = useState(ALL_SCOPE.id);
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<SuggestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(-1);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const inputId = useId();
  const scopeSelectId = useId();

  const scopes = useMemo(() => buildSearchScopes(nav), [nav]);
  const scope = useMemo(() => resolveScope(scopes, scopeId), [scopes, scopeId]);
  const groups = scopeGroups(scope);

  const query = normalizeSuggestQuery(value);
  const canSuggest = query.length >= SUGGEST_LIMITS.minQueryLength;

  /*
   * One request per pause, and never a stale one rendered.
   *
   * The abort controller matters more than the debounce here: a customer typing
   * "shift knob" produces overlapping requests, and without cancelling them the
   * list is whichever response happened to land last rather than the one that
   * matches what is in the box. `scope.id` is in the dependency list for the
   * same reason the query is — changing it changes the answer.
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
          const response = await fetch(
            `/api/public/catalog-suggest?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope.id)}`,
            { signal: controller.signal }
          );
          if (!response.ok) throw new Error("suggest failed");
          const payload = (await response.json()) as SuggestResponse;
          setResults(payload);
          setActive(-1);
        } catch {
          // An aborted request is the normal case, not a failure worth showing.
          // A genuine one leaves the panel offering "See all results", which is
          // still a complete search — the destination does its own matching.
          if (!controller.signal.aborted) {
            setResults({ query, scope: scope.id, products: [], categories: [], projects: [], error: true });
          }
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, canSuggest, scope.id]);

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

  /*
   * Only rows that came back *for this scope* are selectable.
   *
   * The response carries the scope it was computed for, so the moment between
   * changing the scope and the new answer landing renders nothing rather than
   * the previous scope's products under the new scope's heading.
   */
  const rows: SuggestRow[] = useMemo(
    () => (results && results.scope === scope.id ? suggestionRows(results) : []),
    [results, scope.id]
  );
  const total = rows.length;

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    // A highlighted suggestion wins: the customer chose a specific thing and
    // sending them to a result page for it instead would be ignoring the choice.
    const chosen = rows[active]?.href;
    go(chosen ?? searchDestination(scope, value));
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
  const searchLabel = scopeSearchLabel(scope);

  /** Rows of one kind, with the index each carries in the flat selection order. */
  const groupRows = (kind: SuggestRow["kind"]) =>
    rows.map((row, index) => ({ row, index })).filter((entry) => entry.row.kind === kind);

  const renderGroup = (kind: SuggestRow["kind"]) => {
    const entries = groupRows(kind);
    if (!entries.length) return null;
    const headingId = `${listId}-group-${kind}`;

    return (
      <div role="group" aria-labelledby={headingId} className="storefront-search-group">
        <p id={headingId} className="storefront-search-group-heading">
          {GROUP_LABELS[kind]}
        </p>
        {entries.map(({ row, index }) => (
          <div
            key={`${row.kind}-${row.href}`}
            id={`${listId}-option-${index}`}
            role="option"
            aria-selected={active === index}
            className={`storefront-search-option${row.kind === "product" ? "" : " is-compact"}${
              active === index ? " is-active" : ""
            }`}
            onMouseEnter={() => setActive(index)}
            onMouseDown={(event) => {
              // mousedown, not click: the input blurs before click fires and
              // the outside-click handler would have closed the panel first.
              event.preventDefault();
              go(row.href);
            }}
          >
            {row.kind === "product" ? (
              <span className="storefront-search-thumb" aria-hidden="true">
                {row.product.image ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={row.product.image} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="storefront-search-thumb-fallback">KM</span>
                )}
              </span>
            ) : null}

            <span className="storefront-search-option-text">
              <span className="storefront-search-option-name">
                {row.kind === "product"
                  ? row.product.name
                  : row.kind === "category"
                    ? row.category.trail
                    : row.project.title}
              </span>
              {/*
                The kind, in words, on every row. The group heading says it too,
                but a heading is only visible while the reader is looking at the
                top of its group — and the whole failure this replaces was a
                mixed list where a customer could not tell whether Enter opened
                a product, a department or an article.
              */}
              <span className="storefront-search-option-meta">
                {row.kind === "product" && row.product.category
                  ? `${KIND_LABELS.product} · ${row.product.category}`
                  : KIND_LABELS[row.kind]}
              </span>
            </span>

            {row.kind === "product" ? (
              <span className="storefront-search-option-price">{row.product.price}</span>
            ) : row.kind === "category" ? (
              <span className="storefront-search-option-price">{row.category.count}</span>
            ) : null}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div ref={wrapRef} className={`storefront-search ${className}`.trim()} data-variant={variant}>
      <form
        role="search"
        // A search landmark needs a name of its own, or a screen reader
        // announces "search" twice on a page that has two — and the name says
        // the scope, so the landmark describes what it currently searches.
        aria-label={searchLabel}
        onSubmit={submit}
        className="storefront-search-form"
      >
        {/*
          The scope, first, because it qualifies everything typed after it —
          and because that is the order it is read in, by eye and by a screen
          reader walking the form.
        */}
        <label className="sr-only" htmlFor={scopeSelectId}>
          Search in
        </label>
        <select
          id={scopeSelectId}
          className="storefront-search-scope"
          value={scope.id}
          onChange={(event) => {
            setScopeId(event.target.value);
            // The previous scope's answer is not this scope's answer. Clearing
            // it stops the panel showing products under a Projects heading for
            // the ~200ms before the new response lands.
            setResults(null);
            setActive(-1);
            if (value) setOpen(true);
          }}
          data-testid="storefront-search-scope"
        >
          {scopes.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {/* Two spaces of indent for a subcategory. `<optgroup>` was the
                  obvious alternative and is wrong here: its labels are not
                  selectable, and a department is a scope a customer must be
                  able to choose. */}
              {entry.depth ? `  ${entry.label}` : entry.label}
            </option>
          ))}
        </select>

        <label className="sr-only" htmlFor={inputId}>
          {searchLabel}
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
          placeholder={scopePlaceholder(scope)}
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

        <button type="submit" className="storefront-search-submit" aria-label={searchLabel}>
          <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="storefront-search-submit-label">Search</span>
        </button>
      </form>

      {showPanel ? (
        <div className="storefront-search-panel" data-testid="storefront-search-panel">
          <div id={listId} role="listbox" aria-label={`${searchLabel} suggestions`} className="storefront-search-list">
            {renderGroup("product")}
            {renderGroup("category")}
            {renderGroup("project")}
          </div>

          {!total && !loading ? (
            <p className="storefront-search-empty">
              Nothing matches “{query}” in {scope.label.toLowerCase()} yet — the full search may still find it.
            </p>
          ) : null}

          {/*
            Always offered, including when there are no suggestions: the
            destination searches descriptions this endpoint only samples, and a
            dead end at the moment a customer has finished typing is the worst
            place to have one. Not listbox options, so the arrow keys cannot
            land on them and Enter with nothing selected already goes to the
            first.

            In the All scope there are two, because All is the one scope with no
            single page behind it. Offering only the catalog would have made All
            a synonym for Products with extra suggestions, which is exactly the
            behaviour the scope selector exists to end.
          */}
          <div className="storefront-search-actions">
            {groups.products ? (
              <button
                type="button"
                className="storefront-search-all"
                onMouseDown={(event) => {
                  event.preventDefault();
                  go(searchDestination(scope, value));
                }}
              >
                {scope.kind === "category"
                  ? `See all ${scope.label} results for “${query}”`
                  : `See all product results for “${query}”`}
                <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
            ) : null}
            {groups.projects ? (
              <button
                type="button"
                className="storefront-search-all"
                onMouseDown={(event) => {
                  event.preventDefault();
                  go(projectsDestination(value));
                }}
              >
                See all project results for “{query}”
                <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3 shrink-0" aria-hidden="true" />
              </button>
            ) : null}
          </div>

          {/* The count, for anyone who cannot see the list change under them. */}
          <p className="sr-only" role="status" aria-live="polite">
            {loading ? "Searching" : `${total} suggestion${total === 1 ? "" : "s"} in ${scope.label}`}
          </p>
        </div>
      ) : null}
    </div>
  );
}
