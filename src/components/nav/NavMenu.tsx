"use client";

import * as React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

/**
 * The dropdown behaviour shared by every navbar menu.
 *
 * The header previously grew one menu at a time, each re-implementing its own
 * open state, outside-click handler and Escape key. They had already diverged —
 * the More menu restored focus to its trigger on Escape, the notification
 * popover did not, so dismissing it dropped the caret back to the top of the
 * document. Anything that behaves like a menu now behaves the same way:
 *
 * - `Escape` closes and returns focus to the trigger.
 * - A click outside closes without moving focus, because the click has already
 *   put focus where the user wanted it.
 * - `ArrowDown` / `ArrowUp` move through items and wrap; `Home` / `End` jump.
 *   Roving focus rather than `aria-activedescendant`, so the browser's own
 *   focus ring follows and `:focus-visible` keeps working.
 * - Opening with the keyboard focuses the first item; opening with a pointer
 *   does not, so a mouse user does not get a focus ring they did not ask for.
 * - Tabbing out closes it. A menu that stays open behind the rest of the header
 *   is a menu the next Tab press lands inside unexpectedly.
 *
 * **Items are found by querying the open panel, not by registering refs.** The
 * first cut threaded an `itemProps(index)` callback through a render prop and
 * asked each caller to declare how many items it would render. That made the
 * count a hand-maintained number sitting a hundred lines away from the markup
 * it described — the account menu already had to remember to add one for its
 * Sign out row — and a wrong count silently truncates keyboard navigation.
 * Reading `[role="menuitem"]` out of the panel cannot disagree with what was
 * rendered, and the panel only exists while it is open.
 *
 * Reduced motion is honoured by CSS (`.nav-menu-panel`), not by a JS branch, so
 * there is no media query to read during server rendering and no mismatch when
 * it hydrates.
 */

type NavMenuProps = {
  /** Rendered inside the trigger button. */
  trigger: React.ReactNode;
  triggerClassName?: string;
  /** Accessible name for the trigger when its content is an icon. */
  triggerLabel?: string;
  /** Accessible name for the menu itself. */
  menuLabel: string;
  /** Marks the trigger as containing the current page. */
  isHighlighted?: boolean;
  align?: "left" | "right";
  panelClassName?: string;
  /** Each item must carry `role="menuitem"` and `tabIndex={-1}`. */
  children: React.ReactNode;
};

export default function NavMenu({
  trigger,
  triggerClassName = "",
  triggerLabel,
  menuLabel,
  isHighlighted = false,
  align = "right",
  panelClassName = "",
  children,
}: NavMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Set when the menu is opened from the keyboard, so focus should move in. */
  const focusFirstRef = useRef(false);
  const menuId = useId();

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);

  // Outside click, Escape, and focus leaving the menu all dismiss it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent | TouchEvent) => {
      const el = wrapRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) setOpen(false);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close(true);
      }
    };

    const onFocusIn = (event: FocusEvent) => {
      const el = wrapRef.current;
      if (el && event.target instanceof Node && !el.contains(event.target)) setOpen(false);
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

  // Move focus into the panel only when the keyboard opened it.
  useEffect(() => {
    if (!open || !focusFirstRef.current) return;
    focusFirstRef.current = false;
    panelRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (event.key === "Tab") {
      // Let the browser move focus; closing keeps the panel from lingering
      // behind the controls that follow it in the tab order.
      setOpen(false);
      return;
    }
    if (!keys.includes(event.key)) return;

    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')
    );
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
        setOpen(true);
      }
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={onTriggerKeyDown}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={open ? menuId : undefined}
        aria-label={triggerLabel}
        className={`${triggerClassName}${isHighlighted ? " is-highlighted" : ""}`}
      >
        {trigger}
      </button>

      {open ? (
        <div
          ref={panelRef}
          id={menuId}
          role="menu"
          aria-label={menuLabel}
          onKeyDown={onPanelKeyDown}
          onClick={() => setOpen(false)}
          className={`nav-menu-panel absolute top-full z-50 mt-2 ${
            align === "right" ? "right-0" : "left-0"
          } ${panelClassName}`}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
