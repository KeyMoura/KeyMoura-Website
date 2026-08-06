"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faSliders, faXmark } from "@fortawesome/free-solid-svg-icons";
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
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const close = () => setOpenedOn(null);
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
        setOpenedOn(null);
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

  const here =
    menu.trail.length ? menu.trail[menu.trail.length - 1].name : menu.all.name;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpenedOn(pathname)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="catalog-drawer-trigger"
      >
        <FontAwesomeIcon icon={faSliders} className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          Browse &amp; filter
          {/* Where you are, on the button — so a phone user does not have to
              open the sheet to find out which category they are in. */}
          <span className="catalog-drawer-trigger-here">{here}</span>
        </span>
        {filterCount ? (
          <span className="catalog-drawer-trigger-badge">
            {filterCount}
            <span className="sr-only"> filters applied</span>
          </span>
        ) : null}
      </button>

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
                    Browse products
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    onClick={dismiss}
                    className="catalog-drawer-close"
                    aria-label="Close browse and filter"
                  >
                    <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="catalog-drawer-scroll">
                  <nav aria-label="Product categories" className="catalog-drawer-section">
                    <p className="catalog-drawer-heading">Categories</p>
                    <Link
                      href={menu.all.href}
                      onClick={close}
                      aria-current={menu.all.isActive ? "page" : undefined}
                      className={`catalog-drawer-item${menu.all.isActive ? " is-active" : ""}`}
                    >
                      <span className="min-w-0 truncate">{menu.all.name}</span>
                      <span className="catalog-drawer-count">{menu.all.count}</span>
                    </Link>

                    {menu.categories.map((entry) => (
                      <div key={entry.id}>
                        <Link
                          href={entry.href}
                          onClick={close}
                          aria-current={entry.isActive ? "page" : undefined}
                          className={`catalog-drawer-item${entry.isActive ? " is-active" : ""}`}
                        >
                          <span className="min-w-0 truncate">{entry.name}</span>
                          <span className="catalog-drawer-count">{entry.count}</span>
                        </Link>
                        {/* Subcategories are always listed here rather than
                            hidden behind a second tap: the sheet is already a
                            deliberate detour, and making the customer take two
                            to reach a subcategory is what makes them invisible. */}
                        {entry.children.map((child) => (
                          <Link
                            key={child.id}
                            href={child.href}
                            onClick={close}
                            aria-current={child.isActive ? "page" : undefined}
                            className={`catalog-drawer-item is-child${child.isActive ? " is-active" : ""}`}
                          >
                            <span className="min-w-0 truncate">{child.name}</span>
                            <span className="catalog-drawer-count">{child.count}</span>
                          </Link>
                        ))}
                      </div>
                    ))}
                  </nav>

                  <div className="catalog-drawer-section">
                    <p className="catalog-drawer-heading">Filter</p>
                    <label className="catalog-drawer-field">
                      <span>Search</span>
                      <input
                        type="search"
                        value={filters.query}
                        onChange={(event) => onChange({ query: event.target.value })}
                        placeholder="Search products…"
                        className="ui-input"
                      />
                    </label>
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
                    <label className="catalog-drawer-field">
                      <span>Sort</span>
                      <MenuSelect
                        ariaLabel="Sort products"
                        className="ui-select-trigger w-full"
                        value={filters.sort}
                        onChange={(value) => onChange({ sort: value as CatalogFilters["sort"] }, "push")}
                        options={SORT_OPTIONS}
                      />
                    </label>
                  </div>
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
                    Show products
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
