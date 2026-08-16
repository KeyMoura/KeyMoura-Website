"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";

/**
 * Hover intent for navbar dropdowns, in one place.
 *
 * `ProductsMenu` grew this behaviour first and owned the only copy: two timers,
 * a short one to open and a longer one to close. `More` had none, so the two
 * controls sitting next to each other on the same bar answered the pointer
 * differently — one opened as you approached it, the other only on click. This
 * is that behaviour lifted out so both use it, rather than a second hover system
 * written beside the first.
 *
 * ## Why two delays, and why they are not equal
 *
 * Opening on `mouseenter` with no delay flashes the panel open every time a
 * cursor crosses the trigger on its way somewhere else. Closing on `mouseleave`
 * with no delay kills the panel while the cursor is still travelling the few
 * pixels of gap between the trigger and the panel it is aiming for.
 *
 * So both are timers, and the close delay is the longer one: opening late costs
 * a moment, closing early costs the interaction.
 *
 * ## Why the gap does not flicker
 *
 * The trigger and the panel share one wrapper, and both handlers live on that
 * wrapper. The panel is absolutely positioned with a small offset, so the gap
 * between them is outside the wrapper's box and crossing it *does* fire
 * `mouseleave` — but that only schedules the close. Entering the panel
 * immediately fires `mouseenter` on the wrapper again (the pointer came from
 * outside it), which clears the pending close before it runs. The menu never
 * shuts, and no invisible bridge element is needed to hold it open.
 *
 * ## Why hover is gated on the pointer, not the viewport
 *
 * A touch tap synthesises `mouseenter` before `click` in every major browser.
 * On a control whose trigger is also its toggle — which `More` is — that reads
 * as open-then-close, and the menu appears not to work at all on a phone. So
 * every handler asks the platform whether this pointer can actually hover, and
 * does nothing when it cannot. Tap keeps going through `onClick`, untouched.
 *
 * The check runs inside the handler rather than deciding whether to attach the
 * handler, because a handler is not markup: attaching it unconditionally means
 * the server and the client render the identical tree and there is no media
 * query to read during SSR and no mismatch to correct after hydration.
 */

export const NAV_HOVER_OPEN_DELAY_MS = 110;
export const NAV_HOVER_CLOSE_DELAY_MS = 220;

/** Whether this pointer can hover at all. False on touch, and during SSR. */
function pointerCanHover(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export type NavHoverIntent = {
  /** Spread onto the wrapper that contains both the trigger and the panel. */
  hoverProps: { onMouseEnter: () => void; onMouseLeave: () => void };
  /**
   * Cancels any pending open/close. Call before any deliberate state change —
   * a click, a key press — so a timer scheduled by the pointer cannot land
   * afterwards and undo it.
   */
  cancel: () => void;
};

export function useNavHoverIntent({
  enabled,
  setOpen,
}: {
  /** `false` leaves the control click-only; the handlers become no-ops. */
  enabled: boolean;
  setOpen: (open: boolean) => void;
}): NavHoverIntent {
  const timerRef = useRef<number | null>(null);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const schedule = useCallback(
    (next: boolean, delay: number) => {
      cancel();
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setOpenRef.current(next);
      }, delay);
    },
    [cancel]
  );

  useEffect(() => cancel, [cancel]);

  const hoverProps = useMemo(
    () => ({
      onMouseEnter: () => {
        if (!enabled || !pointerCanHover()) return;
        schedule(true, NAV_HOVER_OPEN_DELAY_MS);
      },
      onMouseLeave: () => {
        if (!enabled || !pointerCanHover()) return;
        schedule(false, NAV_HOVER_CLOSE_DELAY_MS);
      },
    }),
    [enabled, schedule]
  );

  return { hoverProps, cancel };
}
