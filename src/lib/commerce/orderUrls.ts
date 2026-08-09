/**
 * Where a customer's order lives, decided in one place.
 *
 * An order has two possible homes and they are not interchangeable:
 *
 * - `/orders/<id>` reads `orders` **through RLS as the signed-in customer**, so
 *   it can only ever render for the account that owns the row.
 * - `/orders/guest/<id>` runs on the server and authenticates on the guest
 *   session cookie or a verified six-digit code.
 *
 * Sending a guest to the account path shows them a permission error for their
 * own order; sending an account customer to the guest path asks them to verify
 * an email for something their session already proves. Both are decided by one
 * fact — whether `customer_id` is set — so that fact is turned into a path
 * exactly once, here, rather than at every email call site.
 *
 * Neither form ever carries a credential. No `?token=`, no `?code=`: a URL
 * lands in browser history, in the `Referer` of the next outbound click, and in
 * whatever a customer pastes into a support chat. The credential is a cookie or
 * a code typed into a form, and nothing else.
 */

/** `/orders/<id>` for an account order, `/orders/guest/<id>` for a guest one. */
export function customerOrderPath(orderId: string, customerId: string | null | undefined): string {
  return customerId ? `/orders/${orderId}` : `/orders/guest/${orderId}`;
}

/** The same decision, absolute, for an email or any other off-site link. */
export function customerOrderUrl(
  siteUrl: string,
  orderId: string,
  customerId: string | null | undefined
): string {
  return `${siteUrl.replace(/\/$/, "")}${customerOrderPath(orderId, customerId)}`;
}
