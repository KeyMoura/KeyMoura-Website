import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/api/routeAuth";
import { resolveCart } from "@/lib/commerce/cartService";
import { readGuestToken } from "@/lib/commerce/cartSession";
import { loadCommerceSettings } from "@/lib/commerce/commerceSettingsServer";
import { loadProductFulfillment, planFulfillment, toQuotableLines } from "@/lib/commerce/checkoutFulfillment";
import {
  amountToFreeShipping,
  availableFulfillmentMethods,
  publicCommerceSettings,
} from "@/lib/commerce/commerceSettings";

/**
 * Delivery options for the current cart, and a quote for a chosen one.
 *
 * Both are **read-only**. `POST` computes a total so the customer can see the
 * shipping charge before committing, and writes nothing — the number that ends
 * up on the order is recomputed by the checkout route from the same function,
 * so a stale or tampered quote cannot become a charge.
 *
 * Only the public projection of the settings is ever returned: the shop's
 * origin address, return address, staff recipients, inventory thresholds and
 * reservation timings are absent by construction rather than by remembering to
 * omit them here.
 */

export const runtime = "nodejs";

async function currentCart(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (user) return { cart: await resolveCart({ customerId: user.id }), userId: user.id };
  const guestToken = readGuestToken(req);
  if (!guestToken) return { cart: null, userId: null };
  return { cart: await resolveCart({ guestToken }), userId: null };
}

export async function GET(req: NextRequest) {
  const { cart } = await currentCart(req);
  const settings = await loadCommerceSettings();
  const publicView = publicCommerceSettings(settings);

  const lines = cart?.priced.lines ?? [];
  const fulfillment = await loadProductFulfillment(lines.map((line) => line.productId));
  const quotable = toQuotableLines(lines, fulfillment);

  const methods = availableFulfillmentMethods(settings, quotable, { orderKind: "direct_purchase" });
  const qualifying = Math.max(0, (cart?.totals.subtotalCents ?? 0) - (cart?.totals.discountCents ?? 0));

  return NextResponse.json({
    methods: methods.map((entry) => ({
      method: entry.method,
      available: entry.available,
      // The sentence explaining why an option is unavailable, so the customer
      // is told rather than shown a control that silently does nothing.
      reason: entry.reason,
    })),
    shippingMethods: publicView.shipping.methods.map((method) => ({
      id: method.id,
      name: method.name,
      description: method.description,
      priceCents: method.priceCents,
      deliveryEstimate: method.deliveryEstimate,
      freeThresholdCents: method.freeThresholdCents,
    })),
    destinationCountries: publicView.shipping.destinationCountries,
    destinationRegions: publicView.shipping.destinationRegions,
    handlingNote: publicView.shipping.handlingNote,
    amountToFreeShippingCents: amountToFreeShipping(settings, qualifying),
    pickup: publicView.pickup,
    supportEmail: publicView.supportEmail,
  });
}

export async function POST(req: NextRequest) {
  const { cart } = await currentCart(req);
  if (!cart?.priced.lines.length) {
    return NextResponse.json({ error: "Your cart is empty." }, { status: 409 });
  }

  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const settings = await loadCommerceSettings();
  const fulfillment = await loadProductFulfillment(cart.priced.lines.map((line) => line.productId));
  const quotable = toQuotableLines(cart.priced.lines, fulfillment);

  const planned = planFulfillment({
    settings,
    lines: quotable,
    products: fulfillment,
    requestedMethod: body.fulfillmentMethod,
    requestedShippingMethodId: body.shippingMethodId,
    requestedAddress: body.shippingAddress,
    subtotalCents: cart.totals.subtotalCents,
    discountCents: cart.totals.discountCents,
    orderKind: "direct_purchase",
  });

  if (!planned.ok) {
    return NextResponse.json({ error: planned.error, field: planned.field }, { status: 400 });
  }

  const { totals, shippingMethodSnapshot } = planned.plan;
  return NextResponse.json({
    // Every component shown separately: a single "total" leaves the customer
    // guessing which part the delivery charge was.
    totals: {
      subtotalCents: totals.subtotalCents,
      discountCents: totals.discountCents,
      shippingCents: totals.shippingCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
    },
    shippingMethod: shippingMethodSnapshot
      ? {
          name: shippingMethodSnapshot.name,
          deliveryEstimate: shippingMethodSnapshot.deliveryEstimate,
          freeApplied: shippingMethodSnapshot.freeApplied,
        }
      : null,
  });
}
