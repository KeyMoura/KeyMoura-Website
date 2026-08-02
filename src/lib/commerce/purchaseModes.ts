/**
 * Product purchase modes.
 *
 * A product declares how it can be bought. The mode is enforced on the server
 * at every point where money or a cart is involved — a client cannot talk a
 * request-only product into direct checkout by editing a payload.
 */

export const PURCHASE_MODES = ["direct_purchase", "request_only", "direct_or_request"] as const;

export type PurchaseMode = (typeof PURCHASE_MODES)[number];

export const DEFAULT_PURCHASE_MODE: PurchaseMode = "request_only";

export function isPurchaseMode(value: unknown): value is PurchaseMode {
  return typeof value === "string" && (PURCHASE_MODES as readonly string[]).includes(value);
}

export function normalizePurchaseMode(value: unknown): PurchaseMode {
  return isPurchaseMode(value) ? value : DEFAULT_PURCHASE_MODE;
}

export const PURCHASE_MODE_COPY: Record<PurchaseMode, { label: string; staffLabel: string; help: string; customerHint: string }> = {
  direct_purchase: {
    label: "Buy now",
    staffLabel: "Direct purchase only",
    help: "Fixed price. Customers add it to the cart and pay at checkout.",
    customerHint: "Add to cart and check out.",
  },
  request_only: {
    label: "Request a quote",
    staffLabel: "Request only",
    help: "Quoted or made to order. Customers send a request and you price it before any payment.",
    customerHint: "Priced after review — nothing is charged until you approve a quote.",
  },
  direct_or_request: {
    label: "Buy now or request changes",
    staffLabel: "Direct purchase or request",
    help: "The standard version can be bought outright; customers can also request a customized version.",
    customerHint: "Buy the standard version, or request a custom variation.",
  },
};

/** True when this product can ever reach the cart. */
export function allowsDirectPurchase(mode: PurchaseMode): boolean {
  return mode === "direct_purchase" || mode === "direct_or_request";
}

/** True when this product can be sent through the request and quote workflow. */
export function allowsRequest(mode: PurchaseMode): boolean {
  return mode === "request_only" || mode === "direct_or_request";
}

/**
 * Why a specific configuration cannot be bought directly, or null when it can.
 *
 * Separate from `allowsDirectPurchase` because a directly purchasable product
 * can still be pushed onto the request path by the options chosen: an option
 * value flagged `requires_request`, or a product with no fixed price to charge.
 */
export type DirectPurchaseBlocker =
  | { reason: "mode"; message: string }
  | { reason: "no_price"; message: string }
  | { reason: "option_requires_request"; message: string; optionLabel: string }
  | { reason: "unavailable"; message: string };

export function describeBlocker(blocker: DirectPurchaseBlocker): string {
  return blocker.message;
}
