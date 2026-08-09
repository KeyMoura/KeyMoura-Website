/**
 * How long a verified guest browser stays verified, and how to say it.
 *
 * Separate from `guestOrders.ts` for one concrete reason: that module imports
 * `node:crypto`, and the checkout copy that has to quote this number lives in
 * client components. Importing the constant from there would drag Node's crypto
 * into the browser bundle. These are plain numbers with no imports at all, so
 * the server rules and the sentence a customer reads can share one source
 * without either dictating where the other runs.
 *
 * The values are re-exported by `guestOrders.ts`, which is where server code
 * should keep reading them from.
 */

/**
 * **24 hours.**
 *
 * This was 90 days when the session cookie was the only way back into a guest
 * order — losing it meant losing the order permanently, so it was made to last.
 * Six-digit email verification removes that cliff, and once recovery is cheap a
 * long-lived bearer credential in a browser is only a longer window for a
 * shared or stolen device. Short and renewable beats long and irreplaceable.
 */
export const GUEST_ACCESS_WINDOW_HOURS = 24;

/** The same window in the words a customer reads. Never write the number twice. */
export const GUEST_ACCESS_WINDOW_LABEL = `${GUEST_ACCESS_WINDOW_HOURS} hours`;

/** How long a verification code stays valid, and its label. */
export const GUEST_CODE_TTL_MINUTES = 15;

export const GUEST_CODE_TTL_LABEL = `${GUEST_CODE_TTL_MINUTES} minutes`;

/** Digits in a verification code. Quoted in UI copy and enforced server-side. */
export const GUEST_CODE_LENGTH = 6;
