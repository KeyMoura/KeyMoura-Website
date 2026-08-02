import "server-only";

import { randomBytes } from "node:crypto";
import { routeServiceClient } from "@/lib/api/routeAuth";
import {
  priceCart,
  type PricedCart,
  type PricedOptionGroup,
  type PricedOptionValue,
  type PricedProduct,
  type RequestedLine,
} from "@/lib/commerce/pricing";
import { normalizePurchaseMode } from "@/lib/commerce/purchaseModes";
import {
  cartTotals,
  evaluateDiscount,
  normalizeDiscountCodeInput,
  type CartTotals,
  type DiscountCode,
  type DiscountResult,
} from "@/lib/commerce/discounts";

/**
 * The canonical cart.
 *
 * Everything that shows or charges a cart total goes through `resolveCart`,
 * including the drawer, the cart page, the shared-cart page, and checkout. The
 * stored cart holds only product ids, quantities, and option selections; every
 * price is looked up live here, so the drawer and checkout can never disagree
 * and a client can never influence an amount.
 */

export const GUEST_CART_COOKIE = "km_cart";
export const GUEST_WISHLIST_COOKIE = "km_wishlist";

/** 32 bytes of CSPRNG entropy, url-safe. Used for guest and share tokens. */
export function createToken(): string {
  return randomBytes(32).toString("base64url");
}

export type CartOwner = { customerId: string } | { guestToken: string };

export type CartRecord = {
  id: string;
  customer_id: string | null;
  guest_token: string | null;
  status: string;
  discount_code: string | null;
};

export type StoredCartItem = {
  id: string;
  product_id: string;
  quantity: number;
  selected_options: Record<string, string>;
};

export type ResolvedCart = {
  cartId: string | null;
  priced: PricedCart;
  totals: CartTotals;
  discount: DiscountResult | null;
  /** Items in storage that map to a priced line, keyed by cart_item id. */
  itemIds: Map<string, string>;
};

const PRODUCT_COLUMNS =
  "id,name,slug,is_published,archived_at,purchase_mode,starting_price_cents,availability_status,inventory_policy,inventory_quantity,continue_selling_when_out_of_stock,category_id";

type ProductRow = {
  id: string;
  name: string;
  slug: string;
  is_published: boolean;
  archived_at: string | null;
  purchase_mode: string;
  starting_price_cents: number | null;
  availability_status: PricedProduct["availability_status"];
  inventory_policy: PricedProduct["inventory_policy"];
  inventory_quantity: number;
  continue_selling_when_out_of_stock: boolean;
  category_id: string | null;
};

function sanitizeOptions(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  // Bounded and string-only. A cart row is operator-visible data, so a hostile
  // payload must not be able to store arbitrary structures or grow unbounded.
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
    if (typeof entry !== "string") continue;
    const cleanKey = key.trim().slice(0, 60);
    if (!cleanKey) continue;
    result[cleanKey] = entry.trim().slice(0, 120);
  }
  return result;
}

/** Loads live products plus their active option groups, ready for pricing. */
export async function loadPricedProducts(productIds: readonly string[]): Promise<Map<string, PricedProduct>> {
  const unique = Array.from(new Set(productIds)).filter(Boolean);
  if (!unique.length) return new Map();

  const [{ data: products }, { data: groups }, { data: values }] = await Promise.all([
    routeServiceClient.from("products").select(PRODUCT_COLUMNS).in("id", unique),
    routeServiceClient
      .from("product_option_groups")
      .select("id,product_id,name,option_key,input_type,is_required,sort_order")
      .in("product_id", unique)
      .order("sort_order"),
    routeServiceClient
      .from("product_option_values")
      .select("id,option_group_id,label,value,price_adjustment_cents,is_active,requires_request,sort_order")
      .order("sort_order"),
  ]);

  const valuesByGroup = new Map<string, PricedOptionValue[]>();
  for (const value of values ?? []) {
    const list: PricedOptionValue[] = valuesByGroup.get(value.option_group_id as string) ?? [];
    list.push({
      id: value.id as string,
      label: value.label as string,
      value: value.value as string,
      price_adjustment_cents: Number(value.price_adjustment_cents ?? 0),
      is_active: Boolean(value.is_active),
      requires_request: Boolean(value.requires_request),
    });
    valuesByGroup.set(value.option_group_id as string, list);
  }

  const groupsByProduct = new Map<string, PricedOptionGroup[]>();
  for (const group of groups ?? []) {
    const list: PricedOptionGroup[] = groupsByProduct.get(group.product_id as string) ?? [];
    list.push({
      id: group.id as string,
      option_key: group.option_key as string,
      name: group.name as string,
      is_required: Boolean(group.is_required),
      input_type: group.input_type as string,
      values: valuesByGroup.get(group.id as string) ?? [],
    });
    groupsByProduct.set(group.product_id as string, list);
  }

  const map = new Map<string, PricedProduct>();
  for (const row of (products ?? []) as ProductRow[]) {
    map.set(row.id, {
      id: row.id,
      name: row.name,
      slug: row.slug,
      is_published: row.is_published,
      archived_at: row.archived_at,
      purchase_mode: normalizePurchaseMode(row.purchase_mode),
      starting_price_cents: row.starting_price_cents,
      availability_status: row.availability_status,
      inventory_policy: row.inventory_policy,
      inventory_quantity: row.inventory_quantity,
      continue_selling_when_out_of_stock: row.continue_selling_when_out_of_stock,
      option_groups: groupsByProduct.get(row.id) ?? [],
    });
  }
  return map;
}

async function categoryByProduct(productIds: readonly string[]): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(productIds)).filter(Boolean);
  if (!unique.length) return new Map();
  const { data } = await routeServiceClient.from("products").select("id,category_id").in("id", unique);
  return new Map((data ?? []).map((row) => [row.id as string, (row.category_id as string | null) ?? null]));
}

async function loadDiscountCode(code: string): Promise<DiscountCode | null> {
  if (!code) return null;
  const { data } = await routeServiceClient
    .from("discount_codes")
    .select("*")
    .ilike("code", code)
    .maybeSingle();
  if (!data) return null;

  const { data: targets } = await routeServiceClient
    .from("discount_code_targets")
    .select("target_type,target_id,is_exclusion")
    .eq("discount_code_id", data.id);

  return { ...(data as DiscountCode), targets: (targets ?? []) as DiscountCode["targets"] };
}

/** Redemptions and paid-order history, for per-customer and first-order rules. */
async function discountContextFor(customerId: string | null, codeId: string | null) {
  if (!customerId || !codeId) return { customerUses: 0, customerOrderCount: 0 };

  const [{ count: uses }, { count: orders }] = await Promise.all([
    routeServiceClient
      .from("discount_redemptions")
      .select("id", { count: "exact", head: true })
      .eq("discount_code_id", codeId)
      .eq("customer_id", customerId),
    routeServiceClient
      .from("orders")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId)
      .eq("payment_status", "paid"),
  ]);

  return { customerUses: uses ?? 0, customerOrderCount: orders ?? 0 };
}

export async function findCart(owner: CartOwner): Promise<CartRecord | null> {
  const query = routeServiceClient
    .from("carts")
    .select("id,customer_id,guest_token,status,discount_code")
    .eq("status", "active");

  const { data } = await ("customerId" in owner
    ? query.eq("customer_id", owner.customerId)
    : query.eq("guest_token", owner.guestToken)
  ).maybeSingle();

  return (data as CartRecord | null) ?? null;
}

export async function findOrCreateCart(owner: CartOwner): Promise<CartRecord> {
  const existing = await findCart(owner);
  if (existing) return existing;

  const insert = "customerId" in owner ? { customer_id: owner.customerId } : { guest_token: owner.guestToken };
  const { data, error } = await routeServiceClient
    .from("carts")
    .insert(insert)
    .select("id,customer_id,guest_token,status,discount_code")
    .single();

  // A concurrent request may have created it first; the partial unique index
  // makes that a conflict rather than a duplicate cart.
  if (error) {
    const retry = await findCart(owner);
    if (retry) return retry;
    throw new Error("Could not open a cart.");
  }
  return data as CartRecord;
}

export async function loadCartItems(cartId: string): Promise<StoredCartItem[]> {
  const { data } = await routeServiceClient
    .from("cart_items")
    .select("id,product_id,quantity,selected_options")
    .eq("cart_id", cartId)
    .order("created_at");

  return (data ?? []).map((row) => ({
    id: row.id as string,
    product_id: row.product_id as string,
    quantity: Number(row.quantity ?? 1),
    selected_options: sanitizeOptions(row.selected_options),
  }));
}

/**
 * Prices a set of lines and applies a discount code, entirely from live data.
 *
 * Shared by the cart, the shared-cart page, and checkout so all three produce
 * identical numbers from identical inputs.
 */
export async function resolveLines(
  lines: readonly RequestedLine[],
  options: { discountCode?: string | null; customerId?: string | null; itemIds?: Map<string, string> } = {}
): Promise<ResolvedCart> {
  const products = await loadPricedProducts(lines.map((line) => line.productId));
  const priced = priceCart(products, lines);

  const requestedCode = normalizeDiscountCodeInput(options.discountCode ?? "");
  let discount: DiscountResult | null = null;
  let discountCents = 0;

  if (requestedCode && priced.lines.length > 0) {
    const code = await loadDiscountCode(requestedCode);
    const [categories, usage] = await Promise.all([
      categoryByProduct(priced.lines.map((line) => line.productId)),
      discountContextFor(options.customerId ?? null, code?.id ?? null),
    ]);

    discount = evaluateDiscount(code, priced, {
      customerUses: usage.customerUses,
      customerOrderCount: usage.customerOrderCount,
      categoryByProduct: categories,
    });
    if (discount.ok) discountCents = discount.amountCents;
  }

  return {
    cartId: null,
    priced,
    totals: cartTotals(priced.subtotalCents, discountCents),
    discount,
    itemIds: options.itemIds ?? new Map(),
  };
}

/** Resolves a stored cart. Returns an empty result when there is no cart yet. */
export async function resolveCart(owner: CartOwner | null): Promise<ResolvedCart> {
  const empty: ResolvedCart = {
    cartId: null,
    priced: { lines: [], rejected: [], subtotalCents: 0, itemCount: 0 },
    totals: cartTotals(0, 0),
    discount: null,
    itemIds: new Map(),
  };

  if (!owner) return empty;
  const cart = await findCart(owner);
  if (!cart) return empty;

  const items = await loadCartItems(cart.id);
  if (!items.length) return { ...empty, cartId: cart.id };

  const itemIds = new Map(items.map((item) => [item.product_id, item.id]));
  const resolved = await resolveLines(
    items.map((item) => ({
      productId: item.product_id,
      quantity: item.quantity,
      selectedOptions: item.selected_options,
    })),
    {
      discountCode: cart.discount_code,
      customerId: cart.customer_id,
      itemIds,
    }
  );

  return { ...resolved, cartId: cart.id };
}

/**
 * Merges a guest cart into the signed-in customer's cart after login.
 *
 * Quantities are summed and clamped by the same pricing rules; the guest cart
 * is then marked abandoned rather than deleted so the merge stays auditable.
 */
export async function mergeGuestCart(guestToken: string, customerId: string): Promise<void> {
  const guestCart = await findCart({ guestToken });
  if (!guestCart) return;

  const guestItems = await loadCartItems(guestCart.id);
  if (guestItems.length) {
    const target = await findOrCreateCart({ customerId });
    const existing = await loadCartItems(target.id);
    const byProduct = new Map(existing.map((item) => [item.product_id, item]));

    for (const item of guestItems) {
      const match = byProduct.get(item.product_id);
      if (match) {
        await routeServiceClient
          .from("cart_items")
          .update({ quantity: Math.min(match.quantity + item.quantity, 99), updated_at: new Date().toISOString() })
          .eq("id", match.id);
      } else {
        await routeServiceClient.from("cart_items").insert({
          cart_id: target.id,
          product_id: item.product_id,
          quantity: item.quantity,
          selected_options: item.selected_options,
        });
      }
    }

    if (!target.discount_code && guestCart.discount_code) {
      await routeServiceClient.from("carts").update({ discount_code: guestCart.discount_code }).eq("id", target.id);
    }
  }

  await routeServiceClient
    .from("carts")
    .update({ status: "abandoned", updated_at: new Date().toISOString() })
    .eq("id", guestCart.id);
}

/** The wire shape sent to the browser. Deliberately carries no owner identity. */
export function serializeCart(resolved: ResolvedCart) {
  return {
    itemCount: resolved.priced.itemCount,
    subtotalCents: resolved.totals.subtotalCents,
    discountCents: resolved.totals.discountCents,
    totalCents: resolved.totals.totalCents,
    chargeable: resolved.totals.chargeable,
    discount: resolved.discount
      ? resolved.discount.ok
        ? { ok: true as const, code: resolved.discount.code.code, amountCents: resolved.discount.amountCents }
        : { ok: false as const, reason: resolved.discount.reason, message: resolved.discount.message }
      : null,
    items: resolved.priced.lines.map((line) => ({
      itemId: resolved.itemIds.get(line.productId) ?? null,
      productId: line.productId,
      name: line.product.name,
      slug: line.product.slug,
      quantity: line.quantity,
      unitPriceCents: line.unitPriceCents,
      lineSubtotalCents: line.lineSubtotalCents,
      selectedOptions: line.selectedOptions,
      optionLabels: line.optionLabels,
    })),
    unavailable: resolved.priced.rejected.map((entry) => ({
      productId: entry.productId,
      name: entry.productName,
      reason: entry.blocker.reason,
      message: entry.blocker.message,
    })),
  };
}

export type SerializedCart = ReturnType<typeof serializeCart>;
