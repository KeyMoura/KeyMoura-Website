/**
 * What a catalog result offers to do, and what it says about itself.
 *
 * One module, no React, no Supabase, so the grid, the list row, the homepage
 * row and the tests all read the same answers. Before this the wording lived in
 * `productLabels.cardAction`, which knew about the purchase mode and nothing
 * else — so it offered "Buy now" on a card whose button could not buy anything,
 * and "Customize" on a product that needed no customization at all.
 *
 * ## The rule the storefront is built on
 *
 * A catalog card is for **discovery and quick cart entry**. The product page is
 * for **configuration**. So the question a card asks is not "what kind of
 * product is this" but "can I put this in a cart exactly as it is shown".
 *
 *   - Yes                              → Add to cart, from the card.
 *   - Yes, and it can also be customized → *still* Add to cart. Customization
 *     being available is not a reason to make somebody who does not want it
 *     take a detour through the product page.
 *   - No, because a choice is required  → Choose options, opening the product.
 *   - No, because it is priced by quote → the request path.
 *
 * The third case is the one that used to be wrong in both directions: a product
 * with a required option group rendered "Buy now", and the add would then be
 * refused by the server with "Choose a material for …" — an error the customer
 * could have been spared by the button naming the actual next step.
 *
 * ## This is a convenience, never a control
 *
 * `priceLine` in `pricing.ts` is the authority. It re-checks publication,
 * purchase mode, stock, price and every required option group when the line is
 * added, when the cart is displayed and again at checkout. Everything here is a
 * prediction of that answer, computed from the same fields, so the button can
 * say the truth before the customer presses it. A wrong prediction costs a
 * clear error message; it cannot sell anything that should not be sold.
 */

import { productCanBeRequested } from "@/lib/commerceTypes";
import { moneyFromCents } from "@/lib/orderHub";
import {
  allowsDirectPurchase,
  allowsRequest,
  normalizePurchaseMode,
  type PurchaseMode,
} from "@/lib/commerce/purchaseModes";

/**
 * The fields an action decision needs.
 *
 * Deliberately a structural type rather than `CatalogProduct`: the homepage row
 * and the cart's "you might also like" carry fewer columns, and a decision that
 * needs the whole row cannot be made by anything but the catalog.
 */
export type ActionableProduct = {
  purchase_mode?: string | null;
  starting_price_cents?: number | null;
  availability_status?: string | null;
  inventory_policy?: string | null;
  inventory_quantity?: number | null;
  continue_selling_when_out_of_stock?: boolean | null;
  is_custom?: boolean | null;
  /**
   * True when at least one *required* option group has at least one active
   * value to choose from — the exact condition `priceLine` refuses on.
   *
   * A required group with no values does not block a purchase and must not be
   * reported here: the shop has one of those today ("Epoxy Coated", zero
   * values), and treating it as a blocker would send a $15 product that adds to
   * the cart perfectly well off to a configuration page with nothing on it.
   */
  requires_configuration?: boolean | null;
  /** True when the product has any option group at all, required or not. */
  has_options?: boolean | null;
};

export type CatalogActionKind = "add_to_cart" | "configure" | "request" | "view";

export type CatalogActionDecision = {
  kind: CatalogActionKind;
  label: string;
  /**
   * Why this is not a quick add, for the cases where that is worth knowing.
   * Null on `add_to_cart`.
   */
  reason: "configuration_required" | "quote_only" | "no_price" | "unavailable" | null;
};

/** Whether this product could ever reach a cart as listed. */
export function isDirectlyPurchasable(product: ActionableProduct): boolean {
  const mode = normalizePurchaseMode(product.purchase_mode);
  if (!allowsDirectPurchase(mode)) return false;
  if (product.starting_price_cents == null) return false;
  return isAvailable(product);
}

/**
 * Stock and status, matching `productCanBeRequested`.
 *
 * A product with no availability data at all is treated as available: several
 * lighter surfaces select fewer columns, and a missing column is not evidence
 * of being out of stock.
 */
export function isAvailable(product: ActionableProduct): boolean {
  if (product.availability_status == null) return true;
  return productCanBeRequested({
    availability_status: product.availability_status as "available" | "limited" | "made_to_order" | "unavailable",
    inventory_policy: (product.inventory_policy ?? "unlimited") as "unlimited" | "track",
    inventory_quantity: product.inventory_quantity ?? 0,
    continue_selling_when_out_of_stock: product.continue_selling_when_out_of_stock ?? false,
  });
}

/**
 * True when the customer *may* customize but does not have to.
 *
 * Three independent signals, because the catalog carries three:
 *
 *   - `direct_or_request` — buy the standard version, or ask for a variation.
 *   - `is_custom` — staff flagged the product itself as custom-capable.
 *   - an optional option group — a choice exists that nobody is forced to make.
 *
 * A product whose configuration is *required* is excluded: that is a different
 * promise and gets different wording. See `customizationSignal`.
 */
export function isOptionallyCustomizable(product: ActionableProduct): boolean {
  if (product.requires_configuration) return false;
  const mode = normalizePurchaseMode(product.purchase_mode);
  if (mode === "direct_or_request") return true;
  if (product.is_custom) return true;
  return Boolean(product.has_options);
}

export type CustomizationSignal = "customizable" | "choose_options" | null;

/**
 * The customization badge a card should show, or null for neither.
 *
 * `Customizable` and `Choose options` must never be the same pill: one says
 * "there is more available if you want it", the other says "this cannot be
 * bought until you decide something". Showing the softer word for the stricter
 * case is how a customer ends up at a checkout that refuses them.
 *
 * A request-only product gets neither. Everything about it is customized by
 * definition, so the word adds nothing the price line ("Price after review")
 * and the request button have not already said.
 */
export function customizationSignal(product: ActionableProduct): CustomizationSignal {
  const mode = normalizePurchaseMode(product.purchase_mode);
  if (!allowsDirectPurchase(mode)) return null;
  if (product.requires_configuration) return "choose_options";
  return isOptionallyCustomizable(product) ? "customizable" : null;
}

export const CUSTOMIZATION_LABELS: Record<Exclude<CustomizationSignal, null>, string> = {
  customizable: "Customizable",
  choose_options: "Choose options",
};

/**
 * The action one catalog result offers.
 *
 * Ordered by what stops a quick add first, so the label always names the
 * nearest real obstacle rather than the most interesting one.
 */
export function catalogAction(product: ActionableProduct): CatalogActionDecision {
  const mode = normalizePurchaseMode(product.purchase_mode);
  const available = isAvailable(product);
  const canRequest = allowsRequest(mode);

  // Nothing to sell and nothing to quote: the card still opens the product,
  // because a page explaining that something is unavailable is more use than a
  // dead tile.
  if (!available) {
    return canRequest
      ? { kind: "request", label: "Request a quote", reason: "unavailable" }
      : { kind: "view", label: "View details", reason: "unavailable" };
  }

  if (!allowsDirectPurchase(mode)) {
    return { kind: "request", label: "Request a quote", reason: "quote_only" };
  }

  // Direct purchase is allowed, so work out whether it is possible *as listed*.
  if (product.starting_price_cents == null) {
    return canRequest
      ? { kind: "request", label: "Request a quote", reason: "no_price" }
      : { kind: "view", label: "View details", reason: "no_price" };
  }

  if (product.requires_configuration) {
    return { kind: "configure", label: "Choose options", reason: "configuration_required" };
  }

  return { kind: "add_to_cart", label: "Add to cart", reason: null };
}

/**
 * The price, worded for what the number actually means.
 *
 * Unchanged in spirit from `productLabels.priceLabel`, and restated here
 * against the richer type so a product that needs configuration says "From"
 * rather than quoting a base price the customer cannot actually pay. A required
 * material group ranging −$5 to +$35 makes the bare number wrong in both
 * directions.
 */
export function catalogPriceLabel(product: ActionableProduct): string {
  const cents = product.starting_price_cents;
  if (cents == null) return "Price after review";
  const mode = normalizePurchaseMode(product.purchase_mode);
  if (mode === "direct_purchase" && !product.requires_configuration) return moneyFromCents(cents);
  return `From ${moneyFromCents(cents)}`;
}

/**
 * Availability, said the way a customer would say it, plus lead time when the
 * catalog genuinely holds one.
 *
 * `lead_time_text` is free text staff type in. It is shown verbatim and never
 * parsed, invented or defaulted: a shop with no lead-time data must show no
 * lead time rather than a plausible-looking guess.
 */
export function availabilityPresentation(product: {
  availability_status?: string | null;
  lead_time_text?: string | null;
  inventory_policy?: string | null;
  inventory_quantity?: number | null;
  continue_selling_when_out_of_stock?: boolean | null;
}): { label: string; tone: "ready" | "made" | "blocked"; detail: string | null } | null {
  const status = product.availability_status;
  if (!status) return null;

  const detail = product.lead_time_text?.trim() || null;
  const reachable = isAvailable(product);

  if (!reachable) return { label: "Currently unavailable", tone: "blocked", detail: null };

  switch (status) {
    case "available":
      return { label: "In stock", tone: "ready", detail };
    case "limited":
      return { label: "Limited availability", tone: "made", detail };
    case "made_to_order":
      return { label: "Made to order", tone: "made", detail };
    default:
      return { label: "Currently unavailable", tone: "blocked", detail: null };
  }
}

/** Re-exported so callers need one import for a card's whole decision set. */
export type { PurchaseMode };
