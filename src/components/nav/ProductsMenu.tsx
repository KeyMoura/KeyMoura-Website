"use client";

import Link from "next/link";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faChevronDown, faArrowRight } from "@fortawesome/free-solid-svg-icons";
import type { StorefrontNav } from "@/lib/commerce/storefrontNavModel";

/**
 * "Products" in the navigation bar: a link *and* a menu.
 *
 * ## Why it is two controls in one wrapper
 *
 * The tempting shape is a single `<button>` that opens a panel. It is also
 * wrong: Products is the shop's front door, `/catalog` is a real page, and the
 * commonest thing a customer wants from that word is to be taken there. A
 * button cannot be middle-clicked, opened in a new tab, bookmarked, or followed
 * by a crawler.
 *
 * So the word is an `<a href="/catalog">` that always navigates, and the
 * disclosure is a small sibling `<button>` carrying `aria-expanded` and
 * `aria-controls`. Pointer users rarely touch the button — hovering the wrapper
 * opens the panel — but it is what makes the menu reachable and announceable
 * without a pointer, and it is what a screen reader describes.
 *
 * ## Why the outline is on the wrapper and not on the link
 *
 * Two controls is the right *semantic* answer and it produced the wrong picture.
 * The pill — border, radius, padding, hover fill — used to be carried by the
 * `<a>` itself, so the chevron beside it sat outside the outline and Products
 * read as a button with a loose arrow next to it, while `More` (a single
 * button containing its own chevron) read as one control. Two adjacent things
 * doing the same job looked like two different kinds of thing.
 *
 * The pill therefore moved up one level, onto `.products-menu-trigger`, and the
 * two children became transparent. The wrapper is a `<span>`, so nothing about
 * the semantics changed: there is still exactly one link and one button, still
 * two tab stops, still no nested interactive elements. What changed is which box
 * paints the border — and because the wrapper now carries the same
 * `site-nav-link site-nav-primary-link` classes the other bar links carry, all
 * four Appearance navigation styles (classic, soft, framed, minimal) reach it
 * unchanged rather than needing a fifth case written for Products alone.
 *
 * Each child keeps its own `:focus-visible` ring, because they are still two
 * separate destinations; a single ring around the pair would tell a keyboard
 * user the wrong thing about where Enter is going to take them.
 *
 * ## Hover intent
 *
 * Opening on `mouseenter` with no delay makes the panel flash open every time
 * the cursor crosses Products on its way to Custom Projects. Closing on
 * `mouseleave` with no delay makes the panel vanish while the cursor is
 * travelling the few pixels between the trigger and the panel.
 *
 * Both are timers, and the close delay is the longer of the two: opening late
 * costs a moment, closing early costs the interaction. The panel and the
 * trigger share one wrapper and one set of handlers, so moving from one into
 * the other never leaves the wrapper and never starts the closing timer at all.
 *
 * A touch device has no hover, so the disclosure button is the only way in —
 * which is correct, and is why it is a real button rather than a decorative
 * chevron. The mobile drawer has its own expandable copy of this hierarchy.
 *
 * ## Focus
 *
 * Focus is never trapped: this is a menu, not a dialog. Tab moves out of it and
 * closes it, Escape closes it and returns focus to the trigger, and arrow keys
 * move between items when the panel was opened from the keyboard. Opening with
 * a pointer does not move focus, so a mouse user does not get a focus ring they
 * did not ask for.
 */

type ProductsMenuProps = {
  nav: StorefrontNav;
  /** Marks the trigger as the current section. */
  isActive: boolean;
  /**
   * The bar's own link classes. Applied to the *wrapper*, which is what paints
   * the outline around the label and the chevron together — see the note above.
   */
  controlClassName: string;
};

const OPEN_DELAY_MS = 110;
const CLOSE_DELAY_MS = 220;

export default function ProductsMenu({ nav, isActive, controlClassName }: ProductsMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const focusFirstRef = useRef(false);
  const panelId = useId();

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const schedule = useCallback((next: boolean, delay: number) => {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpen(next);
    }, delay);
  }, []);

  const close = useCallback((restoreFocus = false) => {
    clearTimer();
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => clearTimer, []);

  // Outside click, Escape, and focus leaving all dismiss it. Same three rules
  // `NavMenu` follows, so every menu in the header behaves identically.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const el = wrapRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      close(true);
    };
    const onFocusIn = (event: FocusEvent) => {
      const el = wrapRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) close();
    };

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, close]);

  // Move focus in only when the keyboard opened it.
  useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    panelRef.current?.querySelector<HTMLElement>("a")?.focus();
  }, [open]);

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Tab") {
      // Let the browser move focus. A panel left open behind the rest of the
      // header is a panel the next Tab lands inside unexpectedly.
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;

    const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("a"));
    if (!items.length) return;

    event.preventDefault();
    const current = items.indexOf(document.activeElement as HTMLElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };

  const onTriggerKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      if (!open) {
        event.preventDefault();
        focusFirstRef.current = true;
        clearTimer();
        setOpen(true);
      }
    }
  };

  /*
   * The link's own ArrowDown opens the menu too.
   *
   * Without it, a keyboard user tabbing onto "Products" has to know that a
   * second control exists one Tab further on. ArrowDown from a navigation item
   * that has a submenu is the conventional gesture, and it costs the link
   * nothing: Enter still follows it to /catalog.
   */
  const onLinkKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    focusFirstRef.current = true;
    clearTimer();
    setOpen(true);
  };

  const hasCategories = nav.categories.length > 0;

  return (
    <div
      ref={wrapRef}
      className="products-menu"
      onMouseEnter={() => schedule(true, OPEN_DELAY_MS)}
      onMouseLeave={() => schedule(false, CLOSE_DELAY_MS)}
    >
      {/*
        The one outlined control. `data-has-menu` is what lets the CSS give the
        chevron side less padding than the label side without guessing whether a
        chevron is there — a catalog with no categories renders the pill evenly.
      */}
      <span
        className={`products-menu-trigger ${controlClassName}`}
        data-has-menu={hasCategories ? "true" : undefined}
        data-testid="products-menu-trigger"
      >
        <Link
          href="/catalog"
          className="products-menu-link"
          aria-current={isActive ? "page" : undefined}
          onKeyDown={onLinkKeyDown}
          onClick={() => close()}
        >
          Products
        </Link>

        {hasCategories ? (
          <button
            ref={triggerRef}
            type="button"
            onClick={() => {
              clearTimer();
              setOpen((value) => !value);
            }}
            onKeyDown={onTriggerKeyDown}
            aria-expanded={open}
            aria-haspopup="true"
            aria-controls={open ? panelId : undefined}
            aria-label={open ? "Hide product categories" : "Show product categories"}
            className="products-menu-toggle"
            data-testid="products-menu-toggle"
          >
            <FontAwesomeIcon
              icon={faChevronDown}
              className="h-2.5 w-2.5 shrink-0 transition-transform"
              style={{ transform: open ? "rotate(180deg)" : undefined }}
              aria-hidden="true"
            />
          </button>
        ) : null}
      </span>

      {open && hasCategories ? (
        <div
          ref={panelRef}
          id={panelId}
          className="products-menu-panel"
          aria-label="Product categories"
          onKeyDown={onPanelKeyDown}
          onClick={() => close()}
          data-testid="products-menu-panel"
        >
          <div className="products-menu-columns">
            <div className="products-menu-tree">
              <Link href="/catalog" className="products-menu-all">
                <span>All products</span>
                <span className="products-menu-count">{nav.totalCount}</span>
              </Link>

              <ul className="products-menu-list">
                {nav.categories.map((category) => (
                  <li key={category.slug}>
                    <Link href={category.href} className="products-menu-parent">
                      <span className="products-menu-label">{category.name}</span>
                      <span className="products-menu-count">{category.count}</span>
                    </Link>

                    {category.children.length ? (
                      <ul className="products-menu-sublist">
                        {category.children.map((child) => (
                          <li key={child.slug}>
                            <Link href={child.href} className="products-menu-child">
                              <span className="products-menu-label">{child.name}</span>
                              <span className="products-menu-count">{child.count}</span>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>

            {/*
              The one panel on the right, and deliberately not a department
              mega-menu with promotional tiles. This catalog has three products;
              a wall of navigation would be furniture. What earns the space is
              the thing the categories cannot offer — the work that is not in
              the catalog at all, which for this shop is most of it.
            */}
            <div className="products-menu-feature">
              <p className="products-menu-feature-eyebrow">Not in the catalog?</p>
              <p className="products-menu-feature-title">We make one-offs.</p>
              <p className="products-menu-feature-body">
                Send a drawing, a CAD file, or a description. You get a reviewed quote before anything is charged.
              </p>
              <Link href="/orders/new" className="products-menu-feature-link">
                Start a custom project
                <FontAwesomeIcon icon={faArrowRight} className="h-3 w-3 shrink-0" aria-hidden="true" />
              </Link>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
