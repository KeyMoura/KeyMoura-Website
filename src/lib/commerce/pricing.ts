import {
  allowsDirectPurchase,
  normalizePurchaseMode,
  type DirectPurchaseBlocker,
  type PurchaseMode,
} from "@/lib/commerce/purchaseModes";

/**
 * The single pricing authority for direct purchases.
 *
 * Every price, option surcharge, line subtotal, discount, and total the site
 * shows or charges comes from here, computed from live product rows. Nothing in
 * this module reads a price from client input — the cart stores only product
 * ids, quantities, and option selections, so a tampered payload can change
 * *what* is being priced but never *what it costs*.
 *
 * Pure and dependency-free so the rules can be tested directly.
 */

export type PricedOptionValue = {
  id: string;
  label: string;
  value: string;
  price_adjustment_cents: number;
  is_active: boolean;
  requires_request: boolean;
};

export type PricedOptionGroup = {
  id: string;
  option_key: string;
  name: string;
  is_required: boolean;
  input_type: string;
  values: PricedOptionValue[];
};

export type PricedProduct = {
  id: string;
  name: string;
  slug: string;
  is_published: boolean;
  archived_at: string | null;
  purchase_mode: PurchaseMode;
  starting_price_cents: number | null;
  availability_status: "available" | "limited" | "made_to_order" | "unavailable";
  inventory_policy: "unlimited" | "track";
  inventory_quantity: number;
  continue_selling_when_out_of_stock: boolean;
  option_groups?: PricedOptionGroup[];
};

export type RequestedLine = {
  productId: string;
  quantity: number;
  selectedOptions: Record<string, string>;
  /**
   * Opaque identifier for the row this line came from, carried straight
   * through to the priced result. The same product can sit in a cart twice
   * with different options, so lines cannot be identified by product id.
   */
  lineId?: string | null;
};

export type PricedLine = {
  productId: string;
  lineId: string | null;
  product: PricedProduct;
  quantity: number;
  /** Only the options that resolved to a real, active value. */
  selectedOptions: Record<string, string>;
  optionLabels: Array<{
    groupId: string;
    groupKey: string;
    group: string;
    valueId: string;
    value: string;
    label: string;
    adjustmentCents: number;
  }>;
  unitPriceCents: number;
  lineSubtotalCents: number;
};

export type RejectedLine = {
  productId: string;
  lineId: string | null;
  quantity: number;
  productName: string | null;
  blocker: DirectPurchaseBlocker;
};

export type PricedCart = {
  lines: PricedLine[];
  rejected: RejectedLine[];
  subtotalCents: number;
  itemCount: number;
};

export const MAX_LINE_QUANTITY = 99;

/**
 * Stable identity for a cart line: the product plus the exact options chosen.
 *
 * The same product can sit in a cart twice configured two different ways, and
 * those are two distinct lines. Merging and de-duplication key on this instead
 * of on the product id alone, so combining carts never silently collapses two
 * configurations into one.
 */
export function lineSignature(productId: string, selectedOptions: Record<string, string>): string {
  const options = Object.keys(selectedOptions)
    .sort()
    .map((key) => `${key}=${selectedOptions[key]}`)
    .join("&");
  return `${productId}|${options}`;
}

export function clampQuantity(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.min(Math.max(Math.trunc(parsed), 1), MAX_LINE_QUANTITY);
}

/** How many units of this product a customer may currently buy outright. */
export function purchasableQuantity(product: PricedProduct): number {
  if (product.availability_status === "unavailable") return 0;
  if (product.inventory_policy === "unlimited") return MAX_LINE_QUANTITY;
  if (product.inventory_quantity > 0) return Math.min(product.inventory_quantity, MAX_LINE_QUANTITY);
  return product.continue_selling_when_out_of_stock ? MAX_LINE_QUANTITY : 0;
}

/**
 * The ceiling a quantity field should show, or `null` when stock is not what
 * limits it.
 *
 * Distinct from `purchasableQuantity`, which always answers with a number
 * because the checkout path needs one. A *field* needs to know the difference
 * between "5 available" and "as many as you like, up to the per-line cap":
 * rendering "99 available" for an unlimited product states a stock level the
 * shop never claimed to have.
 */
export function displayableLineCeiling(product: PricedProduct): number | null {
  if (product.availability_status === "unavailable") return 0;
  if (product.inventory_policy === "unlimited") return null;
  if (product.continue_selling_when_out_of_stock) return null;
  return Math.min(Math.max(product.inventory_quantity, 0), MAX_LINE_QUANTITY);
}

/**
 * Resolves one requested line against the live product.
 *
 * Returns either a priced line or the specific reason it cannot be bought
 * directly, so the cart can explain itself instead of silently dropping items.
 */
export function priceLine(product: PricedProduct, line: RequestedLine): PricedLine | RejectedLine {
  const mode = normalizePurchaseMode(product.purchase_mode);
  const reject = (blocker: DirectPurchaseBlocker): RejectedLine => ({
    productId: product.id,
    lineId: line.lineId ?? null,
    quantity: line.quantity,
    productName: product.name,
    blocker,
  });

  if (!product.is_published || product.archived_at) {
    return reject({ reason: "unavailable", message: `${product.name} is no longer available.` });
  }

  if (!allowsDirectPurchase(mode)) {
    return reject({
      reason: "mode",
      message: `${product.name} is made to order and is priced through a request.`,
    });
  }

  const available = purchasableQuantity(product);
  if (available <= 0) {
    return reject({ reason: "unavailable", message: `${product.name} is out of stock.` });
  }

  if (product.starting_price_cents == null) {
    return reject({
      reason: "no_price",
      message: `${product.name} does not have a fixed price yet, so it has to go through a request.`,
    });
  }

  const groups = product.option_groups ?? [];
  const resolved: Record<string, string> = {};
  const optionLabels: PricedLine["optionLabels"] = [];
  let optionAdjustmentCents = 0;

  for (const group of groups) {
    const requested = line.selectedOptions[group.option_key];
    const chosen = requested == null ? undefined : group.values.find((value) => value.value === requested && value.is_active);

    if (!chosen) {
      // A required option with no valid selection cannot be priced. An optional
      // one simply contributes nothing.
      if (group.is_required && group.values.length > 0) {
        return reject({
          reason: "option_requires_request",
          message: `Choose a ${group.name.toLowerCase()} for ${product.name}.`,
          optionLabel: group.name,
        });
      }
      continue;
    }

    if (chosen.requires_request) {
      return reject({
        reason: "option_requires_request",
        message: `“${chosen.label}” on ${product.name} needs a quote, so this configuration goes through a request.`,
        optionLabel: group.name,
      });
    }

    resolved[group.option_key] = chosen.value;
    optionAdjustmentCents += chosen.price_adjustment_cents;
    optionLabels.push({
      groupId: group.id,
      groupKey: group.option_key,
      group: group.name,
      valueId: chosen.id,
      value: chosen.value,
      label: chosen.label,
      adjustmentCents: chosen.price_adjustment_cents,
    });
  }

  const quantity = Math.min(clampQuantity(line.quantity), available);
  const unitPriceCents = Math.max(0, product.starting_price_cents + optionAdjustmentCents);

  return {
    productId: product.id,
    lineId: line.lineId ?? null,
    product,
    quantity,
    selectedOptions: resolved,
    optionLabels,
    unitPriceCents,
    lineSubtotalCents: unitPriceCents * quantity,
  };
}

export function isRejected(value: PricedLine | RejectedLine): value is RejectedLine {
  return "blocker" in value;
}

/** Prices a whole cart, keeping usable lines and explaining the rest. */
export function priceCart(products: Map<string, PricedProduct>, lines: readonly RequestedLine[]): PricedCart {
  const priced: PricedLine[] = [];
  const rejected: RejectedLine[] = [];

  for (const line of lines) {
    const product = products.get(line.productId);
    if (!product) {
      rejected.push({
        productId: line.productId,
        lineId: line.lineId ?? null,
        quantity: line.quantity,
        productName: null,
        blocker: { reason: "unavailable", message: "This product is no longer available." },
      });
      continue;
    }

    const result = priceLine(product, line);
    if (isRejected(result)) rejected.push(result);
    else priced.push(result);
  }

  return {
    lines: priced,
    rejected,
    subtotalCents: priced.reduce((total, entry) => total + entry.lineSubtotalCents, 0),
    itemCount: priced.reduce((total, entry) => total + entry.quantity, 0),
  };
}

export function formatCents(cents: number): string {
  return `$${(Math.max(0, Math.round(cents)) / 100).toFixed(2)}`;
}
