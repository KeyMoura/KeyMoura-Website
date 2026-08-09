"use client";

import { useCallback, useEffect, useId, useRef } from "react";

import { useStoredPreference } from "@/lib/hooks/useStoredPreference";
import {
  CATALOG_DENSITIES,
  CATALOG_DENSITY_KEY,
  CATALOG_DENSITY_LABELS,
  DEFAULT_CATALOG_DENSITY,
  parseCatalogDensity,
  type CatalogDensity,
} from "@/lib/commerce/catalogDensity";

/**
 * How many products per row, as a customer-visible control.
 *
 * A radio group rather than three toggle buttons: the choices are mutually
 * exclusive and one is always in force, which is exactly what `radiogroup`
 * means. That also gives the arrow-key behaviour for free through a roving
 * tabindex — the group is one tab stop, and left/right moves within it, so it
 * does not add three stops to the path between the search box and the products.
 *
 * The icons are decorative squares; every button carries a real spoken name
 * ("Three columns"), because a control whose only label is a picture of a grid
 * is unusable by voice or by screen reader. Nothing here is conveyed by colour
 * alone — the pressed state is a filled background *and* `aria-checked`.
 *
 * It is hidden below `lg` in CSS rather than by a width check in JavaScript: a
 * media query cannot disagree with the layout it is describing, and there is no
 * mount-time flash while a listener works out how wide the window is. Below
 * that width the grid is one or two columns and the choice is meaningless.
 */

export default function CatalogDensityControl() {
  const [density, setDensity] = useStoredPreference<CatalogDensity>(
    CATALOG_DENSITY_KEY,
    DEFAULT_CATALOG_DENSITY,
    parseCatalogDensity
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
  const optionId = (columns: CatalogDensity) => `${groupId}-${columns}`;
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
    document.documentElement.dataset.catalogDensity = String(density);
  }, [density]);

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
      const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
      if (!forward && !back) return;
      event.preventDefault();
      const index = CATALOG_DENSITIES.indexOf(density);
      const next = CATALOG_DENSITIES[(index + (forward ? 1 : -1) + CATALOG_DENSITIES.length) % CATALOG_DENSITIES.length];
      setDensity(next);
      // Focus follows selection, which is the expected behaviour for a radio
      // group. Scoped to this group's own element rather than looked up on the
      // document, so a second instance elsewhere cannot steal the focus.
      // The id is rebuilt here rather than through `optionId`: that helper is
      // recreated on every render, so depending on it would defeat this
      // callback's memoization — which the React Compiler refuses outright.
      // `groupId` is stable for the life of the component.
      groupRef.current
        ?.querySelector<HTMLButtonElement>(`#${CSS.escape(`${groupId}-${next}`)}`)
        ?.focus();
    },
    [density, setDensity, groupId]
  );

  return (
    <div className="catalog-density" role="radiogroup" aria-label="Products per row" ref={groupRef}>
      {CATALOG_DENSITIES.map((columns) => {
        const checked = columns === density;
        return (
          <button
            key={columns}
            id={optionId(columns)}
            type="button"
            role="radio"
            aria-checked={checked}
            // One tab stop for the group: only the selected option is reachable
            // by Tab, and the arrows move between them.
            tabIndex={checked ? 0 : -1}
            data-columns={columns}
            onClick={() => setDensity(columns)}
            onKeyDown={onKeyDown}
            className={`catalog-density-option${checked ? " is-selected" : ""}`}
          >
            <span className="catalog-density-icon" aria-hidden="true">
              {Array.from({ length: columns }, (_, bar) => (
                <span key={bar} />
              ))}
            </span>
            <span className="sr-only">{CATALOG_DENSITY_LABELS[columns]}</span>
          </button>
        );
      })}
    </div>
  );
}
