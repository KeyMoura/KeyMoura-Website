import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { chargeableAmountCents, netCollectedCents, remainingBalanceCents } from "@/lib/paymentMath";
import { captureCommerceException } from "@/lib/monitoring";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const { data: order, error } = await routeServiceClient.from("orders")
    .select("id,order_number,product_name,customer_id,status,agreed_price_cents,deposit_amount_cents,amount_paid_cents,amount_refunded_cents,payment_status,stripe_checkout_session_id,quote_expires_at")
    .eq("id", id).eq("customer_id", user.id).maybeSingle();
  if (error || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });
  if (!["accepted", "awaiting_payment", "in_progress"].includes(order.status) || !order.agreed_price_cents || order.agreed_price_cents < 50) {
    return NextResponse.json({ error: "This order is not ready for payment." }, { status: 409 });
  }
  if (order.quote_expires_at && new Date(order.quote_expires_at).getTime() <= Date.now()) {
    return NextResponse.json({ error: "This quote has expired. Message KeyMoura to request an updated quote." }, { status: 409 });
  }
  const remaining = remainingBalanceCents(order);
  // Capped by what `record_stripe_order_payment` will actually bank. Asking for
  // more than the row can absorb produces a card charge the webhook can only
  // refuse — money taken and never recorded — so it is refused here instead.
  const amountDue = chargeableAmountCents(order);
  if (amountDue < 50) return NextResponse.json({ error: "No payable balance remains." }, { status: 409 });

  const stripe = stripeClient();
  if (order.stripe_checkout_session_id) {
    try {
      const existingSession = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
      if (existingSession.status === "open" && existingSession.amount_total === amountDue && existingSession.url) {
        return NextResponse.json({ url: existingSession.url });
      }
    } catch {
      // A removed/expired test session should not prevent creating a fresh checkout.
    }
  }
  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, "");
  const collectedBeforeCheckout = netCollectedCents(order);
  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    customer_email: user.email,
    client_reference_id: order.id,
    metadata: { order_id: order.id, customer_id: user.id, payment_kind: collectedBeforeCheckout > 0 ? "balance" : amountDue < remaining ? "deposit" : "full" },
    payment_intent_data: { metadata: { order_id: order.id, customer_id: user.id } },
    line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: amountDue, product_data: { name: `${order.order_number || "KeyMoura order"} · ${order.product_name} · ${collectedBeforeCheckout > 0 ? "remaining balance" : amountDue < remaining ? "deposit" : "payment"}` } } }],
    success_url: `${siteUrl}/orders/${order.id}?payment=success`,
    cancel_url: `${siteUrl}/orders/${order.id}?payment=cancelled`,
  }, { idempotencyKey: `checkout-${order.id}-${amountDue}-${collectedBeforeCheckout}` });
  /*
   * The session id is always recorded. The payment state is only reset on an
   * order that has collected nothing.
   *
   * Writing `unpaid` over a deposit-paid order erased that deposit from every
   * read that goes through `netCollectedCents` — which returns 0 for an
   * `unpaid` row whatever `amount_paid_cents` says — so the order page offered
   * the deposit a second time. `chargeableAmountCents` above now stops that
   * becoming a charge, and this stops the state being manufactured at all.
   */
  const update = await routeServiceClient
    .from("orders")
    .update({
      stripe_checkout_session_id: session.id,
      ...(collectedBeforeCheckout > 0 ? {} : { payment_status: "unpaid", status: "awaiting_payment" }),
    })
    .eq("id", order.id)
    .eq("customer_id", user.id);
  if (update.error) {
    captureCommerceException(update.error, { operation: "save_checkout_session", orderId: order.id });
    return NextResponse.json({ error: "Could not prepare checkout. Please try again." }, { status: 500 });
  }
  return NextResponse.json({ url: session.url });
}
