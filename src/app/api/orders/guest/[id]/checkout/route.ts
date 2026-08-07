import { NextRequest, NextResponse } from "next/server";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { checkoutAmountCents, netCollectedCents, remainingBalanceCents } from "@/lib/paymentMath";
import { captureCommerceException } from "@/lib/monitoring";
import { authorizeGuestOrderWrite, guestOrderTokenFromRequest } from "@/lib/commerce/guestOrderAccess";
import { consumeRateLimit, rateLimitMessage, RATE_LIMITS } from "@/lib/commerce/rateLimit";

/**
 * A guest paying an approved quote on their own custom request.
 *
 * Deliberately a mirror of `/api/orders/[id]/checkout` rather than a branch
 * inside it: that route's ownership check is `.eq("customer_id", user.id)`,
 * which is exactly the guarantee that must not be loosened. Adding an
 * "or a guest token" clause to it would put the account path one editing
 * mistake away from being reachable without an account.
 *
 * **Every amount is computed here from the order row.** The request body is
 * read for nothing at all — there is no field in it that this route consults —
 * so there is no shape of payload that can change what is charged. The same
 * `paymentMath` helpers the account route uses produce the number, and the
 * same idempotency key stops a double click creating two sessions.
 */

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const token = guestOrderTokenFromRequest(req);

  const access = await authorizeGuestOrderWrite(token, id);
  if (!access.ok) {
    return NextResponse.json({ error: "That order is not available on this device." }, { status: 403 });
  }

  const verdict = await consumeRateLimit(RATE_LIMITS.guestCheckout, `${id}|${token}`);
  if (!verdict.allowed) return NextResponse.json({ error: rateLimitMessage(verdict) }, { status: 429 });

  const { data: order, error } = await routeServiceClient
    .from("orders")
    .select(
      "id,order_number,product_name,customer_id,guest_email,status,agreed_price_cents,deposit_amount_cents,amount_paid_cents,amount_refunded_cents,payment_status,stripe_checkout_session_id,quote_expires_at"
    )
    .eq("id", id)
    .is("customer_id", null)
    .maybeSingle();

  if (error || !order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  // The same three gates the account route applies, in the same order.
  if (
    !["accepted", "awaiting_payment", "in_progress"].includes(order.status) ||
    !order.agreed_price_cents ||
    order.agreed_price_cents < 50
  ) {
    return NextResponse.json({ error: "This order is not ready for payment." }, { status: 409 });
  }
  if (order.quote_expires_at && new Date(order.quote_expires_at).getTime() <= Date.now()) {
    return NextResponse.json(
      { error: "This quote has expired. Reply to your confirmation email to request an updated quote." },
      { status: 409 }
    );
  }

  const remaining = remainingBalanceCents(order);
  const amountDue = checkoutAmountCents(order);
  if (amountDue < 50) return NextResponse.json({ error: "No payable balance remains." }, { status: 409 });

  const stripe = stripeClient();

  // Reuse an open session for the same amount rather than minting a second
  // one. Two live sessions for one balance is how an order gets paid twice.
  if (order.stripe_checkout_session_id) {
    try {
      const existing = await stripe.checkout.sessions.retrieve(order.stripe_checkout_session_id);
      if (existing.status === "open" && existing.amount_total === amountDue && existing.url) {
        return NextResponse.json({ url: existing.url });
      }
    } catch {
      // A removed or expired session must not block a fresh checkout.
    }
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || "https://keymoura.com").replace(/\/$/, "");
  const collectedBeforeCheckout = netCollectedCents(order);
  const kind = collectedBeforeCheckout > 0 ? "balance" : amountDue < remaining ? "deposit" : "full";

  const session = await stripe.checkout.sessions.create(
    {
      mode: "payment",
      customer_email: order.guest_email ?? undefined,
      client_reference_id: order.id,
      // `guest: "1"` is what the webhook requires in place of a customer id,
      // together with this session being the one the order records.
      metadata: { order_id: order.id, guest: "1", payment_kind: kind },
      payment_intent_data: { metadata: { order_id: order.id, guest: "1" } },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountDue,
            product_data: {
              name: `${order.order_number || "KeyMoura order"} · ${order.product_name} · ${
                kind === "balance" ? "remaining balance" : kind === "deposit" ? "deposit" : "payment"
              }`,
            },
          },
        },
      ],
      success_url: `${siteUrl}/orders/guest/${order.id}?payment=success`,
      cancel_url: `${siteUrl}/orders/guest/${order.id}?payment=cancelled`,
    },
    { idempotencyKey: `guest-checkout-${order.id}-${amountDue}-${collectedBeforeCheckout}` }
  );

  const update = await routeServiceClient
    .from("orders")
    .update({ stripe_checkout_session_id: session.id, payment_status: "unpaid", status: "awaiting_payment" })
    .eq("id", order.id)
    .is("customer_id", null);

  if (update.error) {
    captureCommerceException(update.error, { operation: "save_guest_checkout_session", orderId: order.id });
    return NextResponse.json({ error: "Could not prepare checkout. Please try again." }, { status: 500 });
  }

  return NextResponse.json({ url: session.url });
}
