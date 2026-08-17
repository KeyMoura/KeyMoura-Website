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
 * ## Why the gate is the event's own pointer, not a media query
 *
 * A touch tap synthesises `mouseenter` before `click` in every major browser.
 * On a control whose trigger is also its toggle — which `More` is — that reads
 * as open-then-close, and the menu appears not to work at all on a phone. So
 * hover has to be ignored when the thing doing it cannot hover.
 *
 * The first version of this asked a media query: `(hover: hover) and (pointer:
 * fine)`. **That was a regression and this is what it broke.** Those queries
 * describe the device's *primary* input, and on a Windows laptop with a
 * touchscreen the primary input is the touchscreen — Chrome reports `pointer:
 * coarse` and `hover: none` on that hardware even with a mouse plugged in and
 * in use. So the gate returned false for a real mouse, and Products and More
 * both became click-only on an extremely ordinary machine. Products had had no
 * gate at all before the two menus were unified, which is why unifying them is
 * what broke it.
 *
 * `any-hover` / `any-pointer` would fix that particular device and still be the
 * wrong question: both ask *what is attached*, when the thing worth knowing is
 * what is happening right now. A hybrid device has both, and the answer has to
 * differ between the finger and the mouse on the same machine.
 *
 * So the handlers are `pointerenter` / `pointerleave` and the gate is
 * `event.pointerType`. It is exact, it is per-interaction, and it needs no
 * device taxonomy: a mouse or a pen hovers, a finger does not, and a hybrid
 * device gets both behaviours from the same code depending on which the person
 * actually used. `pointerenter` and `pointerleave` carry the same
 * enter/leave semantics as their mouse equivalents, so the wrapper bridge above
 * is unaffected.
 *
 * Attaching unconditionally also keeps SSR honest: there is no capability to
 * read while rendering and no mismatch to correct after hydration.
 */

export const NAV_HOVER_OPEN_DELAY_MS = 110;
export const NAV_HOVER_CLOSE_DELAY_MS = 220;

/**
 * Whether this particular interaction came from something that hovers.
 *
 * Pen included: a stylus reports proximity and genuinely hovers. Touch is the
 * only type excluded, and an unknown or absent type is treated as hovering
 * because every non-touch input this has to serve does.
 */
export function pointerTypeHovers(pointerType: string | undefined): boolean {
  return pointerType !== "touch";
}

export type NavHoverIntent = {
  /** Spread onto the wrapper that contains both the trigger and the panel. */
  hoverProps: {
    onPointerEnter: (event: { pointerType?: string }) => void;
    onPointerLeave: (event: { pointerType?: string }) => void;
  };
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

  /**
   * The latest `setOpen`, read by the timer rather than captured by it.
   *
   * Updated in an effect and not during render: writing a ref while rendering
   * is a tear under concurrent rendering, and `react-hooks/refs` is right to
   * refuse it. An effect is early enough — a timer can only fire after the
   * render that scheduled it has committed.
   */
  const setOpenRef = useRef(setOpen);
  useEffect(() => {
    setOpenRef.current = setOpen;
  });

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
      onPointerEnter: (event: { pointerType?: string }) => {
        if (!enabled || !pointerTypeHovers(event?.pointerType)) return;
        schedule(true, NAV_HOVER_OPEN_DELAY_MS);
      },
      onPointerLeave: (event: { pointerType?: string }) => {
        if (!enabled || !pointerTypeHovers(event?.pointerType)) return;
        schedule(false, NAV_HOVER_CLOSE_DELAY_MS);
      },
    }),
    [enabled, schedule]
  );

  return { hoverProps, cancel };
}
