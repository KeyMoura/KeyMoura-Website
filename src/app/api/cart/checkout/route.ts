import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { captureCommerceException } from "@/lib/monitoring";
import { resolveCart } from "@/lib/commerce/cartService";
import { readGuestToken } from "@/lib/commerce/cartSession";
import { mergeGuestCart } from "@/lib/commerce/cartService";

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

  const totalCents = cart.totals.totalCents;
  if (!cart.totals.chargeable || totalCents < STRIPE_MINIMUM_CENTS) {
    return NextResponse.json({ error: "This cart cannot be checked out." }, { status: 409 });
  }

  const lines = cart.priced.lines;
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
      subtotal_cents: cart.totals.subtotalCents,
      discount_cents: cart.totals.discountCents,
      discount_code: cart.discount?.ok ? cart.discount.code.code : null,
      discount_code_id: cart.discount?.ok ? cart.discount.code.id : null,
      agreed_price_cents: totalCents,
    })
    .select("id")
    .single();

  if (orderError || !order) {
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

    // The cart is marked converted only after a session exists. It is not
    // emptied: payment has not happened yet, and a customer who abandons
    // Stripe must come back to a cart that still holds their items.
    await routeServiceClient
      .from("carts")
      .update({ converted_order_id: order.id, updated_at: new Date().toISOString() })
      .eq("id", cart.cartId ?? "");

    return NextResponse.json({ url: session.url, orderId: order.id });
  } catch (error) {
    await routeServiceClient.from("orders").delete().eq("id", order.id);
    captureCommerceException(error, { operation: "create_direct_checkout_session", orderId: order.id });
    return NextResponse.json({ error: "Could not start checkout. Please try again." }, { status: 500 });
  }
}
