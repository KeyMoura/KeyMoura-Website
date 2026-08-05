import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { logLifecycleFailure } from "./orderLifecycleServer";
import {
  availableFulfillmentMethods,
  checkDestination,
  computeOrderTotals,
  formatAddressLines,
  isDeliverableAddress,
  parseAddress,
  quoteShipping,
  type Address,
  type CommerceSettings,
  type FulfillmentMethod,
  type OrderTotals,
  type QuotableLine,
} from "./commerceSettings";

/**
 * Turning a cart plus a customer's fulfillment choice into an order's
 * immutable shipping facts.
 *
 * Kept out of `pricing.ts` deliberately. The cart's `PricedProduct` is the
 * shape every display surface reads, and widening it to carry package
 * dimensions would push shipping concerns into the catalog card. Checkout
 * loads the three fulfillment flags it needs in one extra batched query
 * instead, which costs one round trip on the only path that cares.
 */

export type ProductFulfillment = {
  id: string;
  name: string;
  requires_shipping: boolean;
  pickup_eligible: boolean;
  fulfillment_required: boolean;
  made_to_order: boolean;
  package_weight_grams: number | null;
  package_length_mm: number | null;
  package_width_mm: number | null;
  package_height_mm: number | null;
  weight_grams: number | null;
};

const FULFILLMENT_COLUMNS =
  "id,name,requires_shipping,pickup_eligible,fulfillment_required,made_to_order," +
  "package_weight_grams,package_length_mm,package_width_mm,package_height_mm,weight_grams";

/**
 * One batched query for the whole cart regardless of line count, with ids
 * de-duplicated first — a cart may hold the same product configured two ways.
 */
export async function loadProductFulfillment(productIds: string[]): Promise<Map<string, ProductFulfillment>> {
  const unique = [...new Set(productIds.filter(Boolean))];
  if (!unique.length) return new Map();

  const { data, error } = await routeServiceClient.from("products").select(FULFILLMENT_COLUMNS).in("id", unique);
  if (error) {
    logLifecycleFailure("load_product_fulfillment", error);
    return new Map();
  }
  return new Map((data as unknown as ProductFulfillment[]).map((row) => [row.id, row]));
}

export function toQuotableLines(
  lines: { productId: string; quantity: number; product: { name: string } }[],
  fulfillment: Map<string, ProductFulfillment>
): QuotableLine[] {
  return lines.map((line) => {
    const row = fulfillment.get(line.productId);
    return {
      productId: line.productId,
      productName: row?.name ?? line.product.name,
      quantity: line.quantity,
      // Absent configuration reads as "physical and postable", which is how
      // every product behaved before these columns existed. A missing row must
      // not quietly turn a real part into a no-fulfillment-needed one.
      requiresShipping: row?.requires_shipping ?? true,
      pickupEligible: row?.pickup_eligible ?? true,
      fulfillmentRequired: row?.fulfillment_required ?? true,
    };
  });
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export type FulfillmentPlan = {
  method: FulfillmentMethod;
  totals: OrderTotals;
  shippingAddress: Address | null;
  /** Copied onto the order. A later settings change must not rewrite these. */
  shippingMethodSnapshot: Record<string, unknown> | null;
  shippingOriginSnapshot: Record<string, unknown> | null;
  pickupLocationSnapshot: Record<string, unknown> | null;
  packageSnapshot: Record<string, unknown> | null;
};

export type PlanResult = { ok: true; plan: FulfillmentPlan } | { ok: false; error: string; field?: string };

/**
 * Decide the fulfillment facts for this checkout, server-side, from live rows.
 *
 * Nothing the browser sends about price is read. The client supplies a *method
 * id* and an address; the charge is recomputed here from the configured
 * methods and the server's own subtotal. A client posting
 * `shippingCents: 0` changes nothing, because that field is never consulted.
 */
export function planFulfillment(input: {
  settings: CommerceSettings;
  lines: QuotableLine[];
  products: Map<string, ProductFulfillment>;
  requestedMethod: unknown;
  requestedShippingMethodId: unknown;
  requestedAddress: unknown;
  subtotalCents: number;
  discountCents: number;
  orderKind?: "direct_purchase" | "custom_request";
}): PlanResult {
  const method = String(input.requestedMethod || "") as FulfillmentMethod;
  if (!["shipping", "pickup", "none"].includes(method)) {
    return { ok: false, error: "Choose how you would like to receive this order.", field: "fulfillmentMethod" };
  }

  const availability = availableFulfillmentMethods(input.settings, input.lines, {
    orderKind: input.orderKind ?? "direct_purchase",
  });
  const chosen = availability.find((entry) => entry.method === method);
  if (!chosen?.available) {
    return {
      ok: false,
      error: chosen?.reason || "That delivery option is not available for this order.",
      field: "fulfillmentMethod",
    };
  }

  const packageSnapshot = buildPackageSnapshot(input.settings, input.lines, input.products);

  if (method === "none") {
    return {
      ok: true,
      plan: {
        method,
        totals: computeOrderTotals({ subtotalCents: input.subtotalCents, discountCents: input.discountCents }),
        shippingAddress: null,
        shippingMethodSnapshot: null,
        shippingOriginSnapshot: null,
        pickupLocationSnapshot: null,
        packageSnapshot: null,
      },
    };
  }

  if (method === "pickup") {
    // Re-checked here even though `availableFulfillmentMethods` already looked:
    // that function answers "should the button show", and this answers "may
    // this order be created". Hiding a control is a convenience, not a control.
    const blocked = input.lines.find((line) => line.fulfillmentRequired && !line.pickupEligible);
    if (blocked) {
      return { ok: false, error: `${blocked.productName} is not available for local pickup.`, field: "fulfillmentMethod" };
    }
    return {
      ok: true,
      plan: {
        method,
        totals: computeOrderTotals({ subtotalCents: input.subtotalCents, discountCents: input.discountCents }),
        // A pickup order needs no shipping address, and asking for one is how a
        // home address ends up stored for no reason.
        shippingAddress: null,
        shippingMethodSnapshot: null,
        shippingOriginSnapshot: null,
        pickupLocationSnapshot: {
          locationName: input.settings.pickup.locationName,
          addressLines: formatAddressLines(input.settings.pickup.address),
          instructions: input.settings.pickup.instructions,
          hoursText: input.settings.pickup.hoursText,
          requireConfirmation: input.settings.pickup.requireConfirmation,
          snapshotAt: new Date().toISOString(),
        },
        packageSnapshot,
      },
    };
  }

  const address = parseAddress(input.requestedAddress);
  if (!isDeliverableAddress(address)) {
    return { ok: false, error: "Enter a complete delivery address.", field: "shippingAddress" };
  }

  const destination = checkDestination(input.settings, address);
  if (!destination.ok) return { ok: false, error: destination.reason, field: "shippingAddress" };

  const quote = quoteShipping({
    settings: input.settings,
    methodId: String(input.requestedShippingMethodId || ""),
    subtotalCents: input.subtotalCents,
    discountCents: input.discountCents,
  });
  if (!quote.ok) return { ok: false, error: quote.reason, field: "shippingMethodId" };

  return {
    ok: true,
    plan: {
      method,
      totals: computeOrderTotals({
        subtotalCents: input.subtotalCents,
        discountCents: input.discountCents,
        shippingCents: quote.shippingCents,
      }),
      shippingAddress: address,
      shippingMethodSnapshot: {
        id: quote.method.id,
        name: quote.method.name,
        description: quote.method.description,
        // The list price *and* what was actually charged, so "why was this
        // free" is answerable from the order alone a year later.
        listPriceCents: quote.method.priceCents,
        chargedCents: quote.shippingCents,
        freeApplied: quote.freeApplied,
        freeThresholdCents: quote.freeThresholdCents,
        deliveryEstimate: quote.method.deliveryEstimate,
        snapshotAt: new Date().toISOString(),
      },
      shippingOriginSnapshot: {
        // The origin *name* and city are kept for historical accuracy; the full
        // street address is not, because an order row is read by more code than
        // the settings page and this one is the shop owner's home.
        originName: input.settings.shipping.originName,
        city: input.settings.shipping.originAddress.city,
        region: input.settings.shipping.originAddress.region,
        postalCode: input.settings.shipping.originAddress.postalCode,
        country: input.settings.shipping.originAddress.country,
        snapshotAt: new Date().toISOString(),
      },
      pickupLocationSnapshot: null,
      packageSnapshot,
    },
  };
}

/**
 * What is being posted, as configured at purchase time.
 *
 * Deliberately approximate: this is a record for the packing bench and for a
 * future carrier integration, not a rated quote. Per-product overrides win over
 * the configured defaults, and weights sum across quantity.
 */
function buildPackageSnapshot(
  settings: CommerceSettings,
  lines: QuotableLine[],
  products: Map<string, ProductFulfillment>
): Record<string, unknown> | null {
  const physical = lines.filter((line) => line.fulfillmentRequired);
  if (!physical.length) return null;

  let totalWeight = 0;
  let anyWeight = false;
  for (const line of physical) {
    const row = products.get(line.productId);
    const unit = row?.package_weight_grams ?? row?.weight_grams ?? settings.shipping.defaultPackageWeightGrams;
    if (unit > 0) anyWeight = true;
    totalWeight += Math.max(0, unit) * Math.max(0, line.quantity);
  }

  const single = physical.length === 1 ? products.get(physical[0].productId) : undefined;
  return {
    itemCount: physical.reduce((sum, line) => sum + line.quantity, 0),
    totalWeightGrams: anyWeight ? totalWeight : null,
    lengthMm: single?.package_length_mm ?? (settings.shipping.defaultPackageLengthMm || null),
    widthMm: single?.package_width_mm ?? (settings.shipping.defaultPackageWidthMm || null),
    heightMm: single?.package_height_mm ?? (settings.shipping.defaultPackageHeightMm || null),
    source: single?.package_length_mm ? "product" : "default",
    snapshotAt: new Date().toISOString(),
  };
}
