"use client";

import { useCallback, useEffect, useId, useRef } from "react";

import { useStoredPreference } from "@/lib/hooks/useStoredPreference";
import {
  CATALOG_VIEWS,
  CATALOG_VIEW_KEY,
  CATALOG_VIEW_LABELS,
  CATALOG_VIEW_SHORT_LABELS,
  catalogViewAttribute,
  DEFAULT_CATALOG_VIEW,
  parseCatalogView,
  type CatalogView,
} from "@/lib/commerce/catalogView";

/**
 * How the results are laid out, as a customer-visible control: `List | 2 | 3 | 4`.
 *
 * A radio group rather than four toggle buttons: the choices are mutually
 * exclusive and one is always in force, which is exactly what `radiogroup`
 * means. That also gives the arrow-key behaviour for free through a roving
 * tabindex — the group is one tab stop, and left/right moves within it, so it
 * does not add four stops to the path between the search box and the products.
 *
 * The icons are decorative; every button carries a real spoken name ("List
 * view", "Three columns"), because a control whose only label is a picture of a
 * grid is unusable by voice or by screen reader. The list option additionally
 * shows the word *List* — "1" would be a lie about what that view is, and the
 * difference between a one-across card and a horizontal result row is the one
 * difference in this group a customer cannot guess from an icon. Nothing here
 * is conveyed by colour alone: the pressed state is a filled background *and* a
 * border *and* `aria-checked`.
 *
 * The grid densities are hidden below `lg` in CSS rather than by a width check
 * in JavaScript — a media query cannot disagree with the layout it is
 * describing, and there is no mount-time flash while a listener works out how
 * wide the window is. **List is not hidden**: a phone is exactly where a
 * customer might want one readable result at a time instead of a column of
 * cropped cards, so the choice stays meaningful all the way down.
 *
 * Which leaves a hole: below `lg` a group whose only visible member is *List*
 * is a switch you can turn on and not off. So there is one extra button —
 * *Grid* — visible only where the densities are not. It is not a fifth stored
 * value; it writes the ordinary default. `display: none` takes the hidden half
 * out of the accessibility tree too, so exactly one option is ever checked, at
 * either width.
 */

export default function CatalogViewControl() {
  const [view, setView] = useStoredPreference<CatalogView>(
    CATALOG_VIEW_KEY,
    DEFAULT_CATALOG_VIEW,
    parseCatalogView
  );

  /*
   * Ids come from `useId`, not from the column count.
   *
   * `catalog-density-3` looked stable and unique and was neither: the catalog
   * route mounts the browser inside a Suspense boundary, and a second instance
   * — a fallback still in the tree, or simply two browsers on one page — put
   * duplicate ids in the document. Duplicate ids break `getElementById`, break
   * `aria-labelledby`, and are exactly the kind of thing that works until it
   * silently does not.
   */
  const groupId = useId();
  const optionId = (value: string) => `${groupId}-${value}`;
  const groupRef = useRef<HTMLDivElement | null>(null);

  /*
   * Keep the document attribute in step with the preference.
   *
   * The pre-paint script in the catalog layout sets it for the first paint;
   * this handles every change after that. Writing an attribute on an element
   * outside React's tree is exactly what an effect is for, and it is
   * idempotent, so a re-render cannot thrash the layout.
   */
  useEffect(() => {
    document.documentElement.dataset.catalogDensity = catalogViewAttribute(view);
  }, [view]);

  /*
   * Arrows move between the options that are *on screen*, read from the DOM
   * rather than from `CATALOG_VIEWS`.
   *
   * Half this group is hidden at any given width, and walking the static list
   * would step onto a `display: none` button — which cannot take focus, so the
   * selection would move while the focus ring stayed behind. Reading
   * `offsetParent` asks the layout what it actually did, which is the only
   * thing that can be right at both widths without a media query in script.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !back) return;
      const group = groupRef.current;
      if (!group) return;
      event.preventDefault();

      const visible = Array.from(group.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter(
        (node) => node.offsetParent !== null
      );
      if (!visible.length) return;
      const current = visible.findIndex((node) => node.getAttribute("aria-checked") === "true");
      const next = visible[(Math.max(0, current) + (forward ? 1 : -1) + visible.length) % visible.length];
      const value = next.dataset.view ?? "";
      // Focus follows selection, which is the expected behaviour for a radio
      // group. Scoped to this group's own element rather than looked up on the
      // document, so a second instance elsewhere cannot steal the focus.
      setView(value === "grid" ? DEFAULT_CATALOG_VIEW : parseCatalogView(value));
      next.focus();
    },
    [setView]
  );

  const isGrid = view !== "list";

  return (
    <div className="catalog-view" role="radiogroup" aria-label="Result layout" ref={groupRef}>
      {CATALOG_VIEWS.map((value) => {
        const checked = value === view;
        const key = String(value);
        return (
          <button
            key={key}
            id={optionId(key)}
            type="button"
            role="radio"
            aria-checked={checked}
            // One tab stop for the group: only the selected option is reachable
            // by Tab, and the arrows move between them.
            tabIndex={checked ? 0 : -1}
            data-view={key}
            title={CATALOG_VIEW_LABELS[key]}
            onClick={() => setView(value)}
            onKeyDown={onKeyDown}
            className={`catalog-view-option${checked ? " is-selected" : ""}`}
          >
            <span className="catalog-view-icon" aria-hidden="true">
              {value === "list" ? (
                <>
                  <span />
                  <span />
                  <span />
                </>
              ) : (
                Array.from({ length: value }, (_, bar) => <span key={bar} />)
              )}
            </span>
            {value === "list" ? (
              <span className="catalog-view-word" aria-hidden="true">
                {CATALOG_VIEW_SHORT_LABELS[key]}
              </span>
            ) : null}
            <span className="sr-only">{CATALOG_VIEW_LABELS[key]}</span>
          </button>
        );
      })}

      {/*
        The narrow-width other half of the switch, and the reason *List* can be
        turned off on a phone. Hidden from `lg`, where the density buttons above
        take over and say the same thing more precisely. Pressing it when a
        density is already stored keeps that density rather than rewriting it.
      */}
      <button
        id={optionId("grid")}
        type="button"
        role="radio"
        aria-checked={isGrid}
        tabIndex={isGrid ? 0 : -1}
        data-view="grid"
        title={CATALOG_VIEW_LABELS.grid}
        onClick={() => setView(isGrid ? view : DEFAULT_CATALOG_VIEW)}
        onKeyDown={onKeyDown}
        className={`catalog-view-option${isGrid ? " is-selected" : ""}`}
      >
        <span className="catalog-view-icon catalog-view-icon-grid" aria-hidden="true">
          <span />
          <span />
          <span />
          <span />
        </span>
        <span className="catalog-view-word" aria-hidden="true">
          {CATALOG_VIEW_SHORT_LABELS.grid}
        </span>
        <span className="sr-only">{CATALOG_VIEW_LABELS.grid}</span>
      </button>
    </div>
  );
}
