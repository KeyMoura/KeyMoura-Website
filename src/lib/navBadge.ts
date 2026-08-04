/**
 * The count bubble on a navbar utility control.
 *
 * One definition for the cart, the wishlist, messages, and notifications. Four
 * copies of `count > 9 ? "9+" : count` is how one of them ends up saying "9+"
 * next to another saying "12", and how a three-character value quietly widens a
 * control that everything to its left is positioned against.
 *
 * Capped at "99+" rather than "9+": a customer with a dozen wishlist items is
 * ordinary, and telling them "9+" reads as a bug. Three characters is the most
 * the bubble is sized for, so that is where it stops.
 */

/** The widest string this can return, for reserving the bubble's width. */
export const MAX_BADGE_TEXT = "99+";

export function badgeCount(count: number | null | undefined): string {
  if (!Number.isFinite(count as number)) return "";
  const whole = Math.max(0, Math.trunc(count as number));
  if (whole === 0) return "";
  return whole > 99 ? MAX_BADGE_TEXT : String(whole);
}

/**
 * The accessible name for a control carrying a count.
 *
 * Screen readers get the real number rather than the truncated bubble text —
 * "Cart, 128 items" is useful where "Cart, 99+ items" is not.
 */
export function badgeLabel(noun: string, count: number | null | undefined): string {
  const whole = Number.isFinite(count as number) ? Math.max(0, Math.trunc(count as number)) : 0;
  return whole === 1 ? `${noun}, 1 item` : `${noun}, ${whole} items`;
}
