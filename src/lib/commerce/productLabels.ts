import { moneyFromCents } from "@/lib/orderHub";
import type { PurchaseMode } from "@/lib/commerce/purchaseModes";

/**
 * How a product's price and call to action are worded.
 *
 * These three functions used to live in `ProductCard.tsx`, which carries a
 * `"use client"` directive. That was fine for as long as only client components
 * called them, and it stopped being fine the moment a server component wanted
 * to render one product's price:
 *
 *     Attempted to call priceLabel() from the server but priceLabel is on the
 *     client. It's not possible to invoke a client function from the server.
 *
 * A function exported from a client module is a *client reference*, not a
 * function — the server gets a marshalling stub. So the wording rules moved
 * here, to a module with no directive at all, which both sides can call.
 * `ProductCard` re-exports them so every existing importer is unaffected.
 *
 * There is nothing client-specific in any of them: given cents and a purchase
 * mode they return a string. That was always true, and putting them in a
 * component file was what hid it.
 */

export function productPrice(cents: number | null | undefined): string {
  return cents == null ? "Price after review" : `From ${moneyFromCents(cents)}`;
}

/**
 * A directly purchasable product has a real price, not a starting point, so
 * "From $40" would understate what the customer is actually committing to.
 *
 * Formatted through the same `moneyFromCents` the cart, the order pages and
 * every email use. `toFixed(2)` was doing the job and doing it *differently*:
 * a £1,299 fixture read "$1299.00" on its catalog card and "$1,299.00" on the
 * order confirming it, which is one product with two prices as far as anyone
 * reading quickly is concerned.
 */
export function priceLabel(mode: PurchaseMode, cents: number | null | undefined): string {
  if (cents == null) return "Price after review";
  if (mode === "direct_purchase") return moneyFromCents(cents);
  return `From ${moneyFromCents(cents)}`;
}

export function cardAction(mode: PurchaseMode, available: boolean): string {
  if (!available) return "View";
  if (mode === "direct_purchase") return "Buy now";
  if (mode === "direct_or_request") return "Buy or customize";
  return "Customize";
}
