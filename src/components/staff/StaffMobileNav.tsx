"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBars, faXmark } from "@fortawesome/free-solid-svg-icons";

import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { activeStaffNavItem, isStaffNavItemActive, visibleStaffNav } from "@/lib/staffNavigation";
import { StaffNavIcon } from "@/components/staff/StaffNavIcon";

/**
 * The staff navigation on small screens.
 *
 * Replaces a `<details>` element that expanded the whole sidebar inline. That
 * was not a dialog, so nothing was announced when it opened, the page behind it
 * stayed reachable by Tab and kept scrolling, and on a phone the list pushed
 * the page content an entire screen down.
 *
 * This is a real dialog: focus moves in on open and back to the trigger on
 * close, Tab is trapped, Escape closes, the page behind is locked at its scroll
 * offset, and the panel scrolls internally bounded by `100dvh`.
 *
 * Rendered through a **portal onto `document.body`**. The site header carries
 * `transition-transform` for its auto-hide behaviour, and a transformed
 * ancestor becomes the containing block for `position: fixed` descendants
 * (CSS Transforms L1 §3). This panel is not inside the header today, but the
 * customer drawer learned that lesson by rendering 60px tall, and a portal
 * costs nothing to state up front.
 *
 * Destinations come from `@/lib/staffNavigation` — the same module the desktop
 * sidebar reads, so there is no second route list to drift.
 */

const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function StaffMobileNav() {
  const pathname = usePathname();
  const { data: access } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const groups = visibleStaffNav(permissions);

  /*
   * Open state is stored as *the path it was opened on*, so navigating closes
   * the drawer by derivation rather than by an effect that calls `setState`
   * after the fact.
   *
   * Two things this gets right that the effect did not: there is no extra
   * render after every navigation, and a back-button navigation closes it too —
   * the per-link `onClick` alone would have left the panel sitting over the
   * page the browser had just gone back to.
   */
  const [openedOn, setOpenedOn] = useState<string | null>(null);
  const open = openedOn === pathname;

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  const close = () => setOpenedOn(null);

  // Lock the page behind the panel without losing its scroll position.
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

  // Escape closes and restores focus; Tab cycles inside the panel.
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

  if (!groups.length) return null;

  const here = activeStaffNavItem(pathname);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpenedOn(pathname)}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="staff-drawer-trigger lg:hidden"
      >
        <FontAwesomeIcon icon={faBars} className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">
          <span className="staff-drawer-trigger-label">Staff menu</span>
          {/* Where you are, on the button itself — so a phone user does not have
              to open the drawer to find out. */}
          <span className="staff-drawer-trigger-here">{here?.item.label ?? "Staff"}</span>
        </span>
      </button>

      {open && typeof document !== "undefined"
        ? createPortal(
            <div className="staff-drawer-root lg:hidden">
              {/* Decorative: Escape and the labelled Close button are the
                  accessible dismissals, and this is not keyboard-reachable. */}
              <div className="staff-drawer-backdrop" onClick={close} aria-hidden="true" />
              <div
                ref={panelRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby="staff-drawer-title"
                className="staff-drawer-panel"
              >
                <div className="staff-drawer-header">
                  <h2 id="staff-drawer-title" className="staff-drawer-title">
                    KeyMoura staff
                  </h2>
                  <button
                    ref={closeRef}
                    type="button"
                    onClick={() => {
                      close();
                      triggerRef.current?.focus();
                    }}
                    className="staff-drawer-close"
                    aria-label="Close the staff menu"
                  >
                    <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden="true" />
                  </button>
                </div>

                <div className="staff-drawer-scroll">
                  {groups.map((group) => {
                    const links = group.items.map((item) => (
                      <Link
                        key={item.href}
                        href={item.href}
                        onClick={close}
                        aria-current={isStaffNavItemActive(item, pathname) ? "page" : undefined}
                        className="staff-drawer-item"
                      >
                        <StaffNavIcon icon={item.icon} className="staff-drawer-item-icon h-4 w-4" />
                        <span className="min-w-0">
                          <span className="staff-drawer-item-label">{item.label}</span>
                          <span className="staff-drawer-item-description">{item.description}</span>
                        </span>
                      </Link>
                    ));

                    /*
                     * "More tools" folds on a phone too.
                     *
                     * Each drawer row is a label *and* a description, so it is
                     * about 64px tall; the eleven secondary destinations are
                     * most of a screen of scrolling between the reader and the
                     * four rows they opened the drawer for. `<details>` rather
                     * than component state because it is a disclosure the
                     * browser already implements accessibly, and it lives
                     * inside a dialog that is unmounted when closed — there is
                     * no state worth persisting across that.
                     */
                    if (group.secondary) {
                      return (
                        <details key={group.id} className="staff-drawer-group staff-drawer-more">
                          <summary className="staff-drawer-more-summary">{group.label}</summary>
                          <nav aria-label={group.label}>{links}</nav>
                        </details>
                      );
                    }

                    /* A group whose only item repeats its name contributes the
                       row and skips the caption above it. */
                    const bare = group.items.length === 1 && group.items[0].label === group.label;
                    return (
                      <nav key={group.id} aria-label={group.label} className="staff-drawer-group">
                        {bare ? null : <p className="staff-drawer-heading">{group.label}</p>}
                        {links}
                      </nav>
                    );
                  })}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
