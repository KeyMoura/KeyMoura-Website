import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { captureCommerceException } from "@/lib/monitoring";
import { resolveCart } from "@/lib/commerce/cartService";
import { readGuestToken } from "@/lib/commerce/cartSession";
import { mergeGuestCart } from "@/lib/commerce/cartService";
import {
  linkCartReservationsToOrder,
  loadCommerceSettings,
  releaseReservations,
  reserveCartInventory,
} from "@/lib/commerce/commerceSettingsServer";
import {
  loadProductFulfillment,
  planFulfillment,
  toQuotableLines,
} from "@/lib/commerce/checkoutFulfillment";

/**
 * Direct-purchase checkout.
 *
 * The order is written *before* the Stripe session exists, with a canonical
 * `agreed_price_cents` computed here from live product rows. The session then
 * points at that order using the same metadata shape the quote flow uses, so
 * the existing webhook settles it through the same idempotency table and the
 * same accounting RPC. Direct purchases inherit every payment guarantee the
 * request flow already has instead of growing a second, weaker payment path.
 *
 * Checkout requires a signed-in customer. `orders.customer_id` is NOT NULL and
 * the webhook refuses to settle a session whose `customer_id` does not match
 * the order, so a guest order is not merely unimplemented — it is
 * unrepresentable. Guests build a cart, then sign in to pay, and the guest
 * cart is merged into the account on the way through.
 */

export const runtime = "nodejs";

/** Stripe rejects amounts under 50 cents. */
const STRIPE_MINIMUM_CENTS = 50;

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) {
    return NextResponse.json(
      { error: "Sign in to finish checking out.", requiresSignIn: true },
      { status: 401 }
    );
  }

  // Fold in anything bought as a guest before this cart is priced, so the
  // customer pays for what they actually filled the cart with.
  const guestToken = readGuestToken(req);
  if (guestToken) await mergeGuestCart(guestToken, user.id);

  // Revalidation immediately before the session is created: this is the price
  // the customer is charged, recomputed from live products, not the number the
  // browser last displayed.
  const cart = await resolveCart({ customerId: user.id });

  if (!cart.priced.lines.length) {
    return NextResponse.json({ error: "Your cart is empty." }, { status: 409 });
  }
  if (cart.priced.rejected.length) {
    return NextResponse.json(
      {
        error: "Some items are no longer available. Review your cart and try again.",
        unavailable: cart.priced.rejected.map((entry) => entry.blocker.message),
      },
      { status: 409 }
    );
  }

  if (!cart.totals.chargeable) {
    return NextResponse.json({ error: "This cart cannot be checked out." }, { status: 409 });
  }

  const lines = cart.priced.lines;

  // ---------------------------------------------------------------------
  // Fulfillment, priced server-side
  // ---------------------------------------------------------------------
  // The browser sends a *method id* and an address. It never sends a shipping
  // price, and no field carrying one is read: the charge is recomputed here
  // from the configured methods and this server's own subtotal.
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const settings = await loadCommerceSettings();
  const productFulfillment = await loadProductFulfillment(lines.map((line) => line.productId));
  const quotableLines = toQuotableLines(lines, productFulfillment);

  const planned = planFulfillment({
    settings,
    lines: quotableLines,
    products: productFulfillment,
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

  const { plan } = planned;
  const totalCents = plan.totals.totalCents;
  if (totalCents < STRIPE_MINIMUM_CENTS) {
    return NextResponse.json({ error: "This cart cannot be checked out." }, { status: 409 });
  }

  // ---------------------------------------------------------------------
  // Hold the stock before taking the customer to Stripe
  // ---------------------------------------------------------------------
  // This is the window pass 7 recorded as open: without a hold, two customers
  // can both check out the last unit and both payments succeed. The hold is
  // atomic and all-or-nothing, and it lapses on its own.
  if (!cart.cartId) {
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  const reservation = await reserveCartInventory({
    cartId: cart.cartId,
    userId: user.id,
    lines: lines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
    minutes: settings.inventory.reservationMinutes,
    allowOversell: settings.inventory.allowOverselling,
  });

  if (!reservation.ok) {
    return NextResponse.json(
      {
        error:
          reservation.shortages.length === 1
            ? `${reservation.shortages[0].product_name} only has ${reservation.shortages[0].available} left.`
            : "Some items in your cart are no longer available in the quantity you asked for.",
        shortages: reservation.shortages.map((entry) => ({
          productName: entry.product_name,
          requested: entry.requested,
          available: entry.available,
        })),
      },
      { status: 409 }
    );
  }

  const summaryName =
    lines.length === 1
      ? lines[0].product.name
      : `${lines[0].product.name} and ${lines.length - 1} more item${lines.length - 1 === 1 ? "" : "s"}`;

  const { data: order, error: orderError } = await routeServiceClient
    .from("orders")
    .insert({
      customer_id: user.id,
      order_kind: "direct_purchase",
      status: "awaiting_payment",
      payment_status: "unpaid",
      product_id: lines.length === 1 ? lines[0].productId : null,
      product_name: summaryName,
      quantity: cart.priced.itemCount,
      subtotal_cents: plan.totals.subtotalCents,
      discount_cents: plan.totals.discountCents,
      shipping_cents: plan.totals.shippingCents,
      tax_cents: plan.totals.taxCents,
      discount_code: cart.discount?.ok ? cart.discount.code.code : null,
      discount_code_id: cart.discount?.ok ? cart.discount.code.id : null,
      agreed_price_cents: totalCents,
      // Snapshots. A settings change six months from now must not rewrite what
      // this customer was charged or redirect a parcel already in the post.
      fulfillment_method: plan.method,
      fulfillment_status: plan.method === "none" ? "not_required" : "unfulfilled",
      shipping_address: plan.shippingAddress,
      shipping_method_snapshot: plan.shippingMethodSnapshot,
      shipping_origin_snapshot: plan.shippingOriginSnapshot,
      pickup_location_snapshot: plan.pickupLocationSnapshot,
      package_snapshot: plan.packageSnapshot,
    })
    .select("id")
    .single();

  if (orderError || !order) {
    // Give the stock straight back. An unreleased hold on a checkout that never
    // happened is an outage that presents as an out-of-stock product.
    await releaseReservations({ reason: "checkout_order_failed", cartId: cart.cartId });
    captureCommerceException(orderError, { operation: "create_direct_order" });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  // Line snapshots: name and price are copied at purchase time so a later
  // product edit never rewrites what the customer actually bought.
  const { error: itemsError } = await routeServiceClient.from("order_items").insert(
    lines.map((line) => ({
      order_id: order.id,
      product_id: line.productId,
      product_name: line.product.name,
      product_slug: line.product.slug,
      selected_options: line.selectedOptions,
      quantity: line.quantity,
      unit_price_cents: line.unitPriceCents,
      line_subtotal_cents: line.lineSubtotalCents,
    }))
  );

  if (itemsError) {
    // No payment exists yet, so removing the shell order is safe and keeps a
    // half-written order out of the customer's history.
    await releaseReservations({ reason: "checkout_items_failed", cartId: cart.cartId });
    await routeServiceClient.from("orders").delete().eq("id", order.id);
    captureCommerceException(itemsError, { operation: "create_direct_order_items", orderId: order.id });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, "");

  try {
    const session = await stripeClient().checkout.sessions.create(
      {
        mode: "payment",
        customer_email: user.email,
        client_reference_id: order.id,
        // The webhook matches on both of these before settling any money.
        metadata: { order_id: order.id, customer_id: user.id, payment_kind: "full", order_kind: "direct_purchase" },
        payment_intent_data: { metadata: { order_id: order.id, customer_id: user.id } },
        // One line for the canonical total. Stripe is told the amount; it is
        // never asked to compute one, and the client never supplies one.
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: totalCents,
              product_data: {
                name: summaryName,
                description: `${cart.priced.itemCount} item${cart.priced.itemCount === 1 ? "" : "s"}`,
              },
            },
          },
        ],
        success_url: `${siteUrl}/orders/${order.id}?payment=success`,
        cancel_url: `${siteUrl}/cart?payment=cancelled`,
        // The session dies when the hold does. Without this the session would
        // outlive its reservation by up to 24 hours, and a customer could pay
        // for stock that had already been released to somebody else.
        expires_at: Math.floor(Date.now() / 1000) + settings.inventory.reservationMinutes * 60,
      },
      { idempotencyKey: `direct-checkout-${order.id}-${totalCents}` }
    );

    const { error: sessionError } = await routeServiceClient
      .from("orders")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", order.id);

    if (sessionError) {
      captureCommerceException(sessionError, { operation: "save_direct_checkout_session", orderId: order.id });
      return NextResponse.json({ error: "Could not prepare checkout. Please try again." }, { status: 500 });
    }

    // The hold now belongs to this order and this session, which is what lets
    // `checkout.session.expired` and the payment webhook find it later.
    await linkCartReservationsToOrder(cart.cartId, order.id, session.id);

    // The cart is marked converted only after a session exists. It is not
    // emptied: payment has not happened yet, and a customer who abandons
    // Stripe must come back to a cart that still holds their items.
    await routeServiceClient
      .from("carts")
      .update({ converted_order_id: order.id, updated_at: new Date().toISOString() })
      .eq("id", cart.cartId);

    return NextResponse.json({ url: session.url, orderId: order.id });
  } catch (error) {
    await releaseReservations({ reason: "checkout_session_failed", cartId: cart.cartId, orderId: order.id });
    await routeServiceClient.from("orders").delete().eq("id", order.id);
    captureCommerceException(error, { operation: "create_direct_checkout_session", orderId: order.id });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }
}
