import type { PricedCart, PricedLine } from "@/lib/commerce/pricing";

/**
 * Discount eligibility and amount.
 *
 * KeyMoura owns these rules, not Stripe: the application decides whether a code
 * applies and exactly how many cents it is worth, and Stripe only ever receives
 * an already-validated final amount. A customer submits a code string; they
 * never submit a discount total.
 *
 * Pure so every rule can be tested directly.
 */

export type DiscountType = "fixed" | "percent";

export type DiscountTarget = {
  target_type: "product" | "category";
  target_id: string;
  is_exclusion: boolean;
};

export type DiscountCode = {
  id: string;
  code: string;
  description: string | null;
  discount_type: DiscountType;
  discount_value: number;
  max_discount_cents: number | null;
  minimum_subtotal_cents: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  archived_at: string | null;
  max_total_uses: number | null;
  max_uses_per_customer: number | null;
  first_order_only: boolean;
  is_stackable: boolean;
  total_uses: number;
  targets?: DiscountTarget[];
};

export type DiscountContext = {
  /** Redemptions this customer has already made of this code. */
  customerUses: number;
  /** Paid orders this customer already has, for first-order-only codes. */
  customerOrderCount: number;
  /** Category of each product in the cart, for category targeting. */
  categoryByProduct: Map<string, string | null>;
  now?: Date;
};

export type DiscountFailure =
  | "unknown_code"
  | "inactive"
  | "not_started"
  | "expired"
  | "exhausted"
  | "customer_limit"
  | "first_order_only"
  | "minimum_subtotal"
  | "no_eligible_items";

export type DiscountResult =
  | { ok: true; code: DiscountCode; amountCents: number; eligibleSubtotalCents: number }
  | { ok: false; reason: DiscountFailure; message: string };

export const DISCOUNT_FAILURE_MESSAGES: Record<DiscountFailure, string> = {
  unknown_code: "That code was not recognized.",
  inactive: "That code is no longer active.",
  not_started: "That code is not available yet.",
  expired: "That code has expired.",
  exhausted: "That code has been fully redeemed.",
  customer_limit: "You have already used that code the maximum number of times.",
  first_order_only: "That code is for first orders only.",
  minimum_subtotal: "Your order does not meet the minimum for that code.",
  no_eligible_items: "That code does not apply to anything in your cart.",
};

function fail(reason: DiscountFailure, message?: string): DiscountResult {
  return { ok: false, reason, message: message ?? DISCOUNT_FAILURE_MESSAGES[reason] };
}

/**
 * Whether a line is inside a code's targeting.
 *
 * With no targets a code covers the whole cart. Exclusions always win over
 * inclusions, so an "everything except clearance" code behaves as expected.
 */
export function lineIsEligible(line: PricedLine, targets: readonly DiscountTarget[], categoryId: string | null): boolean {
  const inclusions = targets.filter((target) => !target.is_exclusion);
  const exclusions = targets.filter((target) => target.is_exclusion);

  const matches = (target: DiscountTarget) =>
    target.target_type === "product"
      ? target.target_id === line.productId
      : categoryId != null && target.target_id === categoryId;

  if (exclusions.some(matches)) return false;
  if (inclusions.length === 0) return true;
  return inclusions.some(matches);
}

/**
 * Evaluates a code against a priced cart.
 *
 * The percentage is applied only to the eligible subtotal, and the minimum is
 * measured against the whole cart subtotal — the two are deliberately
 * different, so a targeted code cannot be unlocked by unrelated items but is
 * also not inflated by them.
 */
export function evaluateDiscount(
  code: DiscountCode | null,
  cart: PricedCart,
  context: DiscountContext
): DiscountResult {
  if (!code) return fail("unknown_code");

  const now = context.now ?? new Date();

  if (!code.is_active || code.archived_at) return fail("inactive");
  if (code.starts_at && new Date(code.starts_at) > now) return fail("not_started");
  if (code.ends_at && new Date(code.ends_at) <= now) return fail("expired");
  if (code.max_total_uses != null && code.total_uses >= code.max_total_uses) return fail("exhausted");
  if (code.max_uses_per_customer != null && context.customerUses >= code.max_uses_per_customer) {
    return fail("customer_limit");
  }
  if (code.first_order_only && context.customerOrderCount > 0) return fail("first_order_only");
  if (cart.subtotalCents < code.minimum_subtotal_cents) {
    return fail(
      "minimum_subtotal",
      `That code needs a subtotal of at least $${(code.minimum_subtotal_cents / 100).toFixed(2)}.`
    );
  }

  const targets = code.targets ?? [];
  const eligibleSubtotalCents = cart.lines
    .filter((line) => lineIsEligible(line, targets, context.categoryByProduct.get(line.productId) ?? null))
    .reduce((total, line) => total + line.lineSubtotalCents, 0);

  if (eligibleSubtotalCents <= 0) return fail("no_eligible_items");

  let amountCents =
    code.discount_type === "fixed"
      ? code.discount_value
      : Math.round((eligibleSubtotalCents * code.discount_value) / 100);

  if (code.max_discount_cents != null) amountCents = Math.min(amountCents, code.max_discount_cents);

  // A discount can never exceed what it applies to, and never turns into credit.
  amountCents = Math.max(0, Math.min(amountCents, eligibleSubtotalCents));

  if (amountCents <= 0) return fail("no_eligible_items");

  return { ok: true, code, amountCents, eligibleSubtotalCents };
}

export function normalizeDiscountCodeInput(value: unknown): string {
  return typeof value === "string" ? value.trim().toUpperCase().slice(0, 40) : "";
}

/** Stripe rejects charges under 50 cents, so a cart cannot be discounted below it. */
export const MINIMUM_CHARGE_CENTS = 50;

export type CartTotals = {
  subtotalCents: number;
  discountCents: number;
  totalCents: number;
  chargeable: boolean;
};

export function cartTotals(subtotalCents: number, discountCents: number): CartTotals {
  const discount = Math.max(0, Math.min(discountCents, subtotalCents));
  const total = Math.max(0, subtotalCents - discount);
  return {
    subtotalCents,
    discountCents: discount,
    totalCents: total,
    chargeable: total >= MINIMUM_CHARGE_CENTS,
  };
}
