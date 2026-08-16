"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faXmark, faMagnifyingGlass, faChevronDown } from "@fortawesome/free-solid-svg-icons";
import StorefrontSearch from "@/components/nav/StorefrontSearch";
import { EMPTY_STOREFRONT_NAV, type StorefrontNav } from "@/lib/commerce/storefrontNavModel";
import {
  accountNav,
  accountSecondaryNav,
  isNavItemActive,
  primaryNav,
  secondaryNav,
  staffNavItems,
  type NavItem,
} from "@/lib/navigation";

/**
 * The mobile navigation drawer.
 *
 * Replaces a `max-h-96` height transition on a plain `<div>`. That approach had
 * three problems beyond the styling: it was not a dialog, so a screen reader
 * announced nothing when it opened and the page behind it stayed reachable by
 * Tab; the page behind it scrolled under the open panel; and 24rem of max-height
 * silently clipped the list once it grew past six links — which it does here,
 * now that the drawer carries the full destination set.
 *
 * What this does instead:
 *
 * - `role="dialog"` + `aria-modal` + a labelled heading, so it is announced.
 * - Focus moves to the close button on open and returns to the trigger on close.
 * - Tab is trapped inside the panel while it is open.
 * - `overflow: hidden` on `<body>` with the scroll position pinned, so the page
 *   behind does not scroll and does not jump when the drawer closes.
 * - Rendered through a **portal onto `<body>`**, not in place. The header
 *   carries `transition-transform` for its auto-hide behaviour, and a
 *   transformed ancestor becomes the containing block for `position: fixed`
 *   descendants (CSS Transforms L1 §3). Left inside the header, the drawer's
 *   `inset: 0` resolved against the 60px-tall bar instead of the viewport, so
 *   it rendered 60px tall with its list clipped away. Nothing about the markup
 *   looked wrong; it was only visible by measuring the panel in a browser.
 * - The panel scrolls internally and is bounded by `100dvh`, so a long list is
 *   reachable rather than clipped — `dvh` rather than `vh` because mobile
 *   browsers shrink the viewport when their toolbar appears.
 * - `env(safe-area-inset-*)` padding, so the last item clears a home indicator.
 *
 * Every destination comes from `@/lib/navigation`, which is also what the
 * desktop bar reads. The two cannot drift.
 */

type MobileNavDrawerProps = {
  open: boolean;
  onClose: () => void;
  /** Focus returns here on close. */
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  pathname: string;
  isStaff: boolean;
  signedIn: boolean;
  onOpenSearch: () => void;
  unreadMessages: number;
  unreadNotifications: number;
  /** The canonical category hierarchy, same source as the desktop dropdown. */
  productsNav?: StorefrontNav;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input, [tabindex]:not([tabindex="-1"])';

export default function MobileNavDrawer({
  open,
  onClose,
  triggerRef,
  pathname,
  isStaff,
  signedIn,
  onOpenSearch,
  unreadMessages,
  unreadNotifications,
  productsNav = EMPTY_STOREFRONT_NAV,
}: MobileNavDrawerProps) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  /*
   * The category tree starts collapsed.
   *
   * A phone drawer that opens with every category and subcategory already
   * expanded buries Custom Projects, the account group and Sign out below a
   * scroll — and it does it to a customer who may not have been looking for a
   * category at all. One tap opens it; the tap target is a real button carrying
   * `aria-expanded`, so a screen reader is told there is something behind it.
   */
  const [categoriesOpen, setCategoriesOpen] = useState(false);

  // Lock the page behind the drawer without losing its scroll position.
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

  // Focus in on open, back to the trigger on close.
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  // Escape closes; Tab is trapped inside the panel.
  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
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
  }, [open, onClose, triggerRef]);

  // `open` only becomes true from a click, so this is never true on the server;
  // the `document` guard states that rather than relying on it.
  if (!open || typeof document === "undefined") return null;

  const staffItems = staffNavItems(isStaff);

  const renderLink = (item: NavItem, badge?: number) => (
    <Link
      key={item.href}
      href={item.href}
      onClick={onClose}
      aria-current={isNavItemActive(item, pathname) ? "page" : undefined}
      className="mobile-nav-item"
    >
      <span className="min-w-0">
        <span className="mobile-nav-item-label">{item.label}</span>
        {item.description ? (
          <span className="mobile-nav-item-description">{item.description}</span>
        ) : null}
      </span>
      {badge && badge > 0 ? (
        <span className="mobile-nav-item-count">{badge > 99 ? "99+" : badge}</span>
      ) : null}
    </Link>
  );

  return createPortal(
    <div className="mobile-nav-root lg:hidden">
      {/* Decorative: Escape and the labelled Close button are the accessible
          dismissals, and the backdrop is not reachable by keyboard. */}
      <div className="mobile-nav-backdrop" onClick={onClose} aria-hidden="true" />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mobile-nav-title"
        className="mobile-nav-panel"
      >
        <div className="mobile-nav-header">
          <h2 id="mobile-nav-title" className="mobile-nav-title">
            Menu
          </h2>
          <button
            ref={closeRef}
            type="button"
            onClick={() => {
              onClose();
              triggerRef.current?.focus();
            }}
            className="mobile-nav-close"
            aria-label="Close menu"
          >
            <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="mobile-nav-scroll">
          {/*
            A real field, not a button that opens one somewhere else. The header
            carries the same component on its second row; this copy exists so a
            customer who opened the menu first does not have to close it again
            to search.
          */}
          <StorefrontSearch variant="drawer" className="mobile-nav-search-field" onNavigate={onClose} />

          <nav aria-label="Primary" className="mobile-nav-group">
            {/*
              Products, with the catalog hierarchy behind a disclosure.

              The link and the disclosure are separate controls for the same
              reason they are on desktop: tapping the word must take you to the
              catalog. The chevron is what opens the tree, and it is a real
              button rather than a decorative arrow.
            */}
            <div className="mobile-nav-branch">
              <Link
                href="/catalog"
                onClick={onClose}
                aria-current={isNavItemActive({ href: "/catalog" }, pathname) ? "page" : undefined}
                className="mobile-nav-item mobile-nav-item-branch"
              >
                <span className="min-w-0">
                  <span className="mobile-nav-item-label">Products</span>
                  <span className="mobile-nav-item-description">Ready designs and made-to-order parts</span>
                </span>
              </Link>

              {productsNav.categories.length ? (
                <button
                  type="button"
                  onClick={() => setCategoriesOpen((value) => !value)}
                  aria-expanded={categoriesOpen}
                  aria-controls="mobile-nav-categories"
                  aria-label={categoriesOpen ? "Hide product categories" : "Show product categories"}
                  className="mobile-nav-branch-toggle"
                  data-testid="mobile-products-toggle"
                >
                  <FontAwesomeIcon
                    icon={faChevronDown}
                    className="h-3 w-3 shrink-0 transition-transform"
                    style={{ transform: categoriesOpen ? "rotate(180deg)" : undefined }}
                    aria-hidden="true"
                  />
                </button>
              ) : null}
            </div>

            {categoriesOpen && productsNav.categories.length ? (
              <div id="mobile-nav-categories" className="mobile-nav-categories" data-testid="mobile-products-categories">
                <Link href="/catalog" onClick={onClose} className="mobile-nav-category">
                  <span>All products</span>
                  <span className="mobile-nav-category-count">{productsNav.totalCount}</span>
                </Link>

                {productsNav.categories.map((category) => (
                  <div key={category.slug}>
                    <Link href={category.href} onClick={onClose} className="mobile-nav-category">
                      <span>{category.name}</span>
                      <span className="mobile-nav-category-count">{category.count}</span>
                    </Link>

                    {category.children.map((child) => (
                      <Link
                        key={child.slug}
                        href={child.href}
                        onClick={onClose}
                        className="mobile-nav-category is-child"
                      >
                        <span>{child.name}</span>
                        <span className="mobile-nav-category-count">{child.count}</span>
                      </Link>
                    ))}
                  </div>
                ))}
              </div>
            ) : null}

            {primaryNav.filter((item) => item.href !== "/catalog").map((item) => renderLink(item))}
          </nav>

          <div className="mobile-nav-group">
            <p className="mobile-nav-heading">Your account</p>
            {signedIn ? (
              <>
                {/*
                  Cart follows Wishlist here, the way it does on the desktop bar.
                  It was missing from the signed-in list and present in the guest
                  one below, so signing in silently removed a destination — and
                  it broke the Account → Wishlist → Cart relationship the header
                  states everywhere else.

                  Injected at render rather than added to `accountNav`, because
                  that list is also the desktop account *menu*, and a Cart entry
                  inside a dropdown that sits two controls away from the cart
                  button is a second answer to a question already answered.
                */}
                {accountNav.map((item) => (
                  <Fragment key={item.href}>
                    {renderLink(
                      item,
                      item.href === "/messages"
                        ? unreadMessages
                        : item.href === "/account/notifications"
                          ? unreadNotifications
                          : undefined
                    )}
                    {item.href === "/wishlist" ? renderLink({ href: "/cart", label: "Cart" }) : null}
                  </Fragment>
                ))}
                {accountSecondaryNav.map((item) => renderLink(item))}
              </>
            ) : (
              <>
                {renderLink({ href: "/wishlist", label: "Wishlist" })}
                {renderLink({ href: "/cart", label: "Cart" })}
                <Link href="/auth/login" onClick={onClose} className="mobile-nav-signin">
                  Log in
                </Link>
              </>
            )}
          </div>

          <nav aria-label="More" className="mobile-nav-group">
            <p className="mobile-nav-heading">More</p>
            {secondaryNav.map((item) => renderLink(item))}

            {/*
              The site-wide palette. It is no longer the storefront's search, but
              it is still the only way to search projects and site sections — and
              on a phone there is no Ctrl+K to reach it with.
            */}
            <button
              type="button"
              onClick={() => {
                onClose();
                onOpenSearch();
              }}
              className="mobile-nav-item mobile-nav-item-button"
            >
              <span className="min-w-0">
                <span className="mobile-nav-item-label">
                  <FontAwesomeIcon icon={faMagnifyingGlass} className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
                  Search the whole site
                </span>
                <span className="mobile-nav-item-description">Projects, guides, and site sections</span>
              </span>
            </button>
          </nav>

          {staffItems.length ? (
            <nav aria-label="Staff" className="mobile-nav-group">
              <p className="mobile-nav-heading">Staff</p>
              {staffItems.map((item) => renderLink(item))}
            </nav>
          ) : null}

          {signedIn ? (
            <div className="mobile-nav-group">
              <Link href="/auth/logout" onClick={onClose} className="mobile-nav-signout">
                Sign out
              </Link>
            </div>
          ) : null}
        </div>
      </div>
    </div>,
    document.body
  );
}
