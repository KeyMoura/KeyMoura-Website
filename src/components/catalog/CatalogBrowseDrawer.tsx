"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSliders, faXmark } from "@fortawesome/free-solid-svg-icons";
import { faList } from "@fortawesome/free-solid-svg-icons";
import CatalogCategoryTree from "@/components/catalog/CatalogCategoryTree";
import { MenuSelect } from "@/components/ui/MenuSelect";
import {
  AVAILABILITY_OPTIONS,
  MODE_OPTIONS,
  SORT_OPTIONS,
  type BrowseMenu,
  type CatalogFilters,
} from "@/lib/commerce/catalogBrowse";

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

type CatalogBrowseDrawerProps = {
  menu: BrowseMenu;
  filters: CatalogFilters;
  filterCount: number;
  onChange: (next: Partial<CatalogFilters>, mode?: "replace" | "push") => void;
  onClear: () => void;
};

/**
 * Categories, filters and sorting on a phone.
 *
 * The desktop bar is two rows of chips, which on a 375px screen would hide
 * everything past the third one behind a horizontal scroll nobody discovers.
 * One trigger and one sheet is the honest version of the same information.
 *
 * A real dialog: focus moves in on open and back to the trigger on close, Tab
 * is trapped in both directions, Escape closes, the page behind is locked at
 * its scroll offset, and the panel scrolls internally bounded by `100dvh`.
 *
 * Rendered through a **portal onto `document.body`**. `SiteHeader` carries
 * `transition-transform` for its auto-hide, and a transformed ancestor becomes
 * the containing block for `position: fixed` descendants (CSS Transforms L1
 * §3) — which is what rendered the customer navigation drawer 60px tall in
 * pass 6. This sheet is not inside the header, but the portal costs nothing
 * and states the rule where the next person will read it.
 *
 * Open state is stored as *the path it was opened on*, so navigating to a
 * category closes it by derivation. That also handles the back button, which a
 * per-link `onClick` does not.
 */
export default function CatalogBrowseDrawer({
  menu,
  filters,
  filterCount,
  onChange,
  onClear,
}: CatalogBrowseDrawerProps) {
  const pathname = usePathname();
  const [opened, setOpened] = useState<{ path: string; panel: "categories" | "filters" } | null>(null);
  const open = opened?.path === pathname;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const close = () => setOpened(null);
  const dismiss = () => {
    close();
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const { body } = document;
    const scrollY = window.scrollY;
    const previous = {
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
      overflow: body.style.overflow,
    };
    body.style.position = "fixed";
    body.style.top = `-${scrollY}px`;
    body.style.width = "100%";
    body.style.overflow = "hidden";
    return () => {
      body.style.position = previous.position;
      body.style.top = previous.top;
      body.style.width = previous.width;
      body.style.overflow = previous.overflow;
      window.scrollTo(0, scrollY);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpened(null);
        triggerRef.current?.focus();
        return;
      }
      if (event.key !== "Tab") return;
      const panel = panelRef.current;
      if (!panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (node) => node.offsetParent !== null || node === document.activeElement
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const here = menu.trail.length ? menu.trail[menu.trail.length - 1].name : menu.all.name;
  const title = opened?.panel === "categories" ? "Categories" : "Filters";

  return (
    <>
      <div className="catalog-compact-controls">
        <button ref={triggerRef} type="button" onClick={(event) => { triggerRef.current = event.currentTarget; setOpened({ path: pathname, panel: "categories" }); }}
          aria-expanded={open && opened?.panel === "categories"} aria-haspopup="dialog" className="catalog-drawer-trigger">
          <FontAwesomeIcon icon={faList} className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Categories<span className="catalog-drawer-trigger-here">{here}</span></span>
        </button>
        <button type="button" onClick={(event) => { triggerRef.current = event.currentTarget; setOpened({ path: pathname, panel: "filters" }); }}
          aria-expanded={open && opened?.panel === "filters"} aria-haspopup="dialog" className="catalog-drawer-trigger">
          <FontAwesomeIcon icon={faSliders} className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Filters</span>
          {filterCount ? <span className="catalog-drawer-trigger-badge">{filterCount}<span className="sr-only"> filters applied</span></span> : null}
        </button>
        <div className="catalog-mobile-sort">
          <MenuSelect ariaLabel="Sort products" className="ui-select-trigger" value={filters.sort}
            onChange={(value) => onChange({ sort: value as CatalogFilters["sort"] }, "push")} options={SORT_OPTIONS} />
        </div>
      </div>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div className="catalog-drawer-root">
              {/* Decorative: Escape and the labelled Close button are the
                  accessible dismissals, and this is not keyboard-reachable. */}
              <div className="catalog-drawer-backdrop" onClick={dismiss} aria-hidden="true" />
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="catalog-drawer-title"
                className="catalog-drawer-panel"
              >
                <div className="catalog-drawer-header">
                  <h2 id="catalog-drawer-title" className="catalog-drawer-title">
                    {title}
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    onClick={dismiss}
                    className="catalog-drawer-close"
                    aria-label={`Close ${title.toLowerCase()}`}
                  >
                    <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="catalog-drawer-scroll">
                  {opened?.panel === "categories" ? <nav aria-label="Product categories" className="catalog-drawer-section">
                    <p className="catalog-drawer-heading">Categories</p>
                    <CatalogCategoryTree menu={menu} variant="drawer" onNavigate={close} />
                  </nav> : <div className="catalog-drawer-section">
                    <p className="catalog-drawer-heading">Filter</p>
                    {/*
                      No search box here.

                      There used to be one, back when the toolbar's own field
                      was hidden below `lg` and this sheet was the only way to
                      reach it. Search is now the first thing on the results
                      toolbar at every width, so a second input would be two
                      controls writing one query parameter — and the one behind
                      a button would be the one that looked authoritative.
                    */}
                    <label className="catalog-drawer-field">
                      <span>Availability</span>
                      <MenuSelect
                        ariaLabel="Availability"
                        className="ui-select-trigger w-full"
                        value={filters.availability}
                        onChange={(value) =>
                          onChange({ availability: value as CatalogFilters["availability"] }, "push")
                        }
                        options={AVAILABILITY_OPTIONS}
                      />
                    </label>
                    <label className="catalog-drawer-field">
                      <span>How it is bought</span>
                      <MenuSelect
                        ariaLabel="How it is bought"
                        className="ui-select-trigger w-full"
                        value={filters.mode}
                        onChange={(value) => onChange({ mode: value as CatalogFilters["mode"] }, "push")}
                        options={MODE_OPTIONS}
                      />
                    </label>
                  </div>}
                </div>

                <div className="catalog-drawer-footer">
                  <button
                    type="button"
                    onClick={onClear}
                    disabled={filterCount === 0}
                    className="ui-btn ui-btn-ghost disabled:opacity-40"
                  >
                    Clear filters
                  </button>
                  <button type="button" onClick={dismiss} className="ui-btn ui-btn-primary">
                    Done
                  </button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
