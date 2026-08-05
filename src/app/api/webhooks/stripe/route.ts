import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderStaff, notifyOrderUser } from "@/lib/orderNotifications";
import { captureCommerceException } from "@/lib/monitoring";
import {
  logLifecycleAudit,
  logLifecycleFailure,
  moneyText,
  sendLifecycleNotification,
} from "@/lib/commerce/orderLifecycleServer";
import {
  commitOrderReservations,
  evaluateAndAnnounceStock,
  loadCommerceSettings,
  releaseReservations,
} from "@/lib/commerce/commerceSettingsServer";

export const runtime = "nodejs";

const REFUND_STATUS_MAP: Record<string, "succeeded" | "pending" | "failed" | "canceled"> = {
  succeeded: "succeeded",
  pending: "pending",
  requires_action: "pending",
  failed: "failed",
  canceled: "canceled",
};

/**
 * What happens once a refund is genuinely settled: finish any cancellation or
 * return waiting on it, and tell the customer.
 *
 * Keyed on the refund id, so Stripe redelivering the same event cannot send a
 * second email or reopen a closed cancellation.
 */
async function settleRefundSideEffects(stripeRefundId: string, status: "succeeded" | "failed", eventId: string) {
  const { data: refund } = await routeServiceClient
    .from("order_refunds")
    .select("id,order_id,amount_cents,confirmed_amount_cents,cancellation_request_id,return_id,customer_note")
    .eq("stripe_refund_id", stripeRefundId)
    .maybeSingle();
  if (!refund) return;

  const { data: order } = await routeServiceClient
    .from("orders")
    .select("id,customer_id,product_name,order_number,cancellation_status,return_status")
    .eq("id", refund.order_id)
    .maybeSingle();
  if (!order) return;

  const amount = Number(refund.confirmed_amount_cents ?? refund.amount_cents ?? 0);
  const succeeded = status === "succeeded";

  if (refund.cancellation_request_id) {
    await routeServiceClient
      .from("order_cancellation_requests")
      .update({
        status: succeeded ? "completed" : "failed",
        completed_at: succeeded ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", refund.cancellation_request_id)
      .in("status", ["approved", "failed"]);
    await routeServiceClient
      .from("orders")
      .update({ cancellation_status: succeeded ? "completed" : "refund_failed", updated_at: new Date().toISOString() })
      .eq("id", refund.order_id)
      .in("cancellation_status", ["approved", "refund_pending", "refund_failed"]);
  }

  if (refund.return_id) {
    await routeServiceClient
      .from("order_returns")
      .update({
        status: succeeded ? "completed" : "refund_pending",
        closed_at: succeeded ? new Date().toISOString() : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", refund.return_id)
      .in("status", ["refund_pending", "inspected"]);
    await routeServiceClient
      .from("orders")
      .update({ return_status: succeeded ? "completed" : "refund_pending", updated_at: new Date().toISOString() })
      .eq("id", refund.order_id)
      .in("return_status", ["refund_pending", "inspected"]);
  }

  await sendLifecycleNotification({
    orderId: refund.order_id,
    order: order as { customer_id: string; product_name: string; order_number: string | null },
    actorUserId: null,
    templateKey: succeeded ? "refund_completed" : "refund_failed",
    eventKey: `refund-webhook-${stripeRefundId}-${status}`,
    title: succeeded ? "Refund complete" : "Refund needs attention",
    message: succeeded
      ? `Your ${moneyText(amount)} refund has completed. Your bank may take a few more days to show it.`
      : "A refund on this order did not complete. The team has been notified and will be in touch.",
    detail: succeeded ? String(refund.customer_note || "") : "",
    price: moneyText(amount),
    notifyStaff: !succeeded,
    staffTitle: "Refund failed at Stripe",
    staffMessage: `A ${moneyText(amount)} refund on ${order.product_name} failed. Open the order to retry.`,
  });

  await logLifecycleAudit({
    eventType: succeeded ? "staff.order.refund_confirmed" : "staff.order.refund_failed",
    actorUserId: null,
    actorRole: "system",
    orderId: refund.order_id,
    metadata: { refund_id: refund.id, amount_cents: amount, stripe_event_id: eventId },
  });
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
  let event: Stripe.Event;
  try { event = stripeClient().webhooks.constructEvent(await req.text(), signature, secret); }
  catch { return NextResponse.json({ error: "Invalid signature" }, { status: 400 }); }
  /**
   * Refund events.
   *
   * Two jobs, both essential. First, a refund this application started is only
   * *confirmed* here — the API call that created it may have come back
   * "pending", and Stripe deciding later is what makes the money real. Second,
   * a refund issued from the **Stripe Dashboard** never touched this
   * application at all; without adopting it here, `amount_refunded_cents`
   * stays behind and the staff refund form would happily send the same money a
   * second time.
   *
   * Both `refund.*` and the older `charge.refund.updated` are handled, because
   * which one an account receives depends on its API version.
   */
  if (event.type.startsWith("refund.") || event.type === "charge.refund.updated") {
    const refundEvent = await routeServiceClient
      .from("stripe_webhook_events")
      .insert({ stripe_event_id: event.id, event_type: event.type });
    if (refundEvent.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    if (refundEvent.error) {
      captureCommerceException(refundEvent.error, { operation: "record_refund_event", stripeEventId: event.id });
      return NextResponse.json({ error: "Could not record event" }, { status: 500 });
    }

    const refund = event.data.object as Stripe.Refund;
    const paymentIntentId =
      typeof refund.payment_intent === "string" ? refund.payment_intent : refund.payment_intent?.id || "";

    const { data: reconciled, error: reconcileError } = await routeServiceClient.rpc("reconcile_stripe_refund", {
      p_stripe_refund_id: refund.id,
      p_payment_intent_id: paymentIntentId,
      p_amount_cents: Number(refund.amount || 0),
      p_status: REFUND_STATUS_MAP[String(refund.status)] ?? "pending",
      p_reason: "Recorded from Stripe",
      p_failure_message: refund.failure_reason ? String(refund.failure_reason).slice(0, 500) : null,
    });

    if (reconcileError) {
      // Leave the event unmarked so a Stripe retry gets another attempt.
      await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
      captureCommerceException(reconcileError, { operation: "reconcile_refund", stripeEventId: event.id });
      return NextResponse.json({ error: "Could not reconcile refund" }, { status: 500 });
    }

    const outcome = reconciled as { applied?: boolean; unmatched?: boolean; status?: string } | null;

    if (outcome?.applied && (outcome.status === "succeeded" || outcome.status === "failed")) {
      await settleRefundSideEffects(refund.id, outcome.status, event.id);
    }

    await routeServiceClient
      .from("stripe_webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, unmatched: Boolean(outcome?.unmatched) });
  }

  /**
   * A Checkout Session that lapsed without payment.
   *
   * Releasing here is what stops an abandoned checkout holding the last unit
   * until its own expiry sweeps it. The release is keyed on the session id and
   * only touches `active` rows, so a redelivered event releases nothing the
   * second time.
   *
   * This event has to be *subscribed* on the Stripe endpoint to arrive at all.
   * If it never does, the hold still lapses on its own expiry and availability
   * already ignores a lapsed hold — so the failure mode is a unit held for the
   * remainder of its window, not a unit held forever.
   */
  if (event.type === "checkout.session.expired") {
    const expiredEvent = await routeServiceClient
      .from("stripe_webhook_events")
      .insert({ stripe_event_id: event.id, event_type: event.type });
    if (expiredEvent.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    if (expiredEvent.error) {
      captureCommerceException(expiredEvent.error, { operation: "record_expired_event", stripeEventId: event.id });
      return NextResponse.json({ error: "Could not record event" }, { status: 500 });
    }

    const expiredSession = event.data.object as Stripe.Checkout.Session;
    const released = await releaseReservations({
      reason: "checkout_session_expired",
      checkoutSessionId: expiredSession.id,
    });

    // The order stays. It is a real record of an attempt, it is what the
    // customer sees in their history, and deleting it would strand the
    // order_items rows that explain what they tried to buy.
    await routeServiceClient
      .from("orders")
      .update({ stripe_checkout_session_id: null })
      .eq("stripe_checkout_session_id", expiredSession.id)
      .eq("payment_status", "unpaid");

    await routeServiceClient
      .from("stripe_webhook_events")
      .update({ processed_at: new Date().toISOString() })
      .eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, released });
  }

  if (event.type === "checkout.session.async_payment_failed") {
    const failedEvent = await routeServiceClient.from("stripe_webhook_events").insert({ stripe_event_id: event.id, event_type: event.type });
    if (failedEvent.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
    if (failedEvent.error) {
      captureCommerceException(failedEvent.error, { operation: "record_failed_payment_event", stripeEventId: event.id });
      return NextResponse.json({ error: "Could not record event" }, { status: 500 });
    }
    const failedSession = event.data.object as Stripe.Checkout.Session;
    const failedOrderId = failedSession.metadata?.order_id || failedSession.client_reference_id;
    const failedCustomerId = failedSession.metadata?.customer_id;
    if (failedOrderId && failedCustomerId) {
      // `payment_failed` rather than leaving it `unpaid`: the column previously
      // could not tell "never tried" from "tried and was declined", which is
      // the difference between a nudge and an apology.
      await routeServiceClient.from("orders").update({ stripe_checkout_session_id: null, payment_status: "payment_failed" }).eq("id", failedOrderId).eq("stripe_checkout_session_id", failedSession.id);
      /**
       * The documented retry policy: a declined payment **releases** the hold.
       *
       * The alternative — holding stock through an indefinite retry — lets one
       * failed card keep the last unit away from a customer who can actually
       * pay for it. Retrying starts a new checkout, which takes a fresh hold if
       * the stock is still there, and says so plainly if it is not.
       */
      const settings = await loadCommerceSettings();
      if (settings.inventory.releaseOnPaymentFailure) {
        await releaseReservations({ reason: "payment_failed", orderId: failedOrderId });
      }
      await Promise.all([
        notifyOrderUser({ orderId:failedOrderId, actorUserId:null, recipientUserId:failedCustomerId, title:"Payment failed", message:"Your payment did not complete. No successful payment was recorded; open the order to try again." }),
        notifyOrderStaff({ orderId:failedOrderId, actorUserId:null, title:"Customer payment failed", message:"A delayed payment failed. The order remains unpaid and the customer can try again." }),
      ]);
    }
    await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true });
  }
  if (event.type !== "checkout.session.completed" && event.type !== "checkout.session.async_payment_succeeded") return NextResponse.json({ received: true });

  const session = event.data.object as Stripe.Checkout.Session;
  if (session.payment_status !== "paid") return NextResponse.json({ received: true });
  const orderId = session.metadata?.order_id || session.client_reference_id;
  if (!orderId || !session.amount_total || session.currency !== "usd") return NextResponse.json({ error: "Missing order metadata" }, { status: 400 });

  const inserted = await routeServiceClient.from("stripe_webhook_events").insert({ stripe_event_id: event.id, event_type: event.type });
  if (inserted.error?.code === "23505") return NextResponse.json({ received: true, duplicate: true });
  if (inserted.error) return NextResponse.json({ error: "Could not record event" }, { status: 500 });

  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id,agreed_price_cents,order_kind").eq("id", orderId).maybeSingle();
  if (!order || !order.agreed_price_cents || session.metadata?.customer_id !== order.customer_id) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Order amount mismatch" }, { status: 409 });
  }
  const paymentIntentId = String(session.payment_intent || "");
  if (!paymentIntentId) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    return NextResponse.json({ error: "Missing payment intent" }, { status: 409 });
  }
  const { data: accounting, error: accountingError } = await routeServiceClient.rpc("record_stripe_order_payment", {
    p_order_id: orderId,
    p_payment_intent_id: paymentIntentId,
    p_amount_cents: session.amount_total,
  });
  if (accountingError) {
    await routeServiceClient.from("stripe_webhook_events").delete().eq("stripe_event_id", event.id);
    captureCommerceException(accountingError, { operation: "record_payment", orderId, stripeEventId: event.id });
    return NextResponse.json({ error: "Could not fulfill payment" }, { status: 500 });
  }
  const result = accounting as { applied?: boolean; duplicate?: boolean; fully_paid?: boolean; amount_paid_cents?: number } | null;
  if (!result?.applied) {
    await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
    return NextResponse.json({ received: true, duplicate: Boolean(result?.duplicate) });
  }
  const fullyPaid = Boolean(result.fully_paid);
  const newNetCollected = Number(result.amount_paid_cents || 0);

  // A direct purchase empties its cart only now, once payment is confirmed.
  // Clearing it at session creation would lose the customer's items if they
  // abandoned Stripe; clearing it on the success redirect would trust a URL.
  // Stock is committed here, at confirmed payment, and nowhere else.
  //
  // The direct-purchase path previously never touched inventory at all: a
  // tracked product could be bought any number of times without its count
  // moving. Committing at checkout instead would hold stock for every
  // abandoned Stripe session; committing here means it moves exactly when the
  // money does. `commit_order_inventory` keys each movement on the order item,
  // so a webhook delivered five times decrements once.
  const { error: inventoryError } = await routeServiceClient.rpc("commit_order_inventory", { p_order_id: orderId });
  if (inventoryError) {
    // Never fail the payment over this: the money is taken and the order is
    // settled. A stock count that needs a nudge is a smaller problem than a
    // customer charged for an order the system then disowns.
    logLifecycleFailure("commit_order_inventory", inventoryError, { orderId, stripeEventId: event.id });
  }

  /**
   * Retire the hold at the same moment the on-hand figure drops.
   *
   * This does not move stock — `commit_order_inventory` above is still the only
   * writer of `products.inventory_quantity` on this path. Committing the
   * reservation stops it counting against availability, and because both happen
   * together, availability is unchanged across the commit. That is the point:
   * the unit was already spoken for, and now it is simply gone rather than
   * held.
   *
   * Only `active` rows move, so a webhook delivered five times commits on the
   * first and is a no-op on the rest.
   */
  const committedReservations = await commitOrderReservations(orderId);

  // Stock actually moved, so re-evaluate the alert. Deduplication is a partial
  // unique index in the database, so calling this on every payment cannot
  // produce a second alert for a product that is already flagged.
  const { data: paidItems } = await routeServiceClient
    .from("order_items")
    .select("product_id")
    .eq("order_id", orderId);
  for (const productId of [...new Set((paidItems ?? []).map((row) => row.product_id).filter(Boolean))]) {
    await evaluateAndAnnounceStock(String(productId));
  }
  void committedReservations;

  if (order.order_kind === "direct_purchase") {
    const { data: convertedCart } = await routeServiceClient
      .from("carts")
      .select("id")
      .eq("converted_order_id", orderId)
      .maybeSingle();

    if (convertedCart) {
      await routeServiceClient.from("cart_items").delete().eq("cart_id", convertedCart.id);
      await routeServiceClient
        .from("carts")
        .update({ status: "converted", discount_code: null, updated_at: new Date().toISOString() })
        .eq("id", convertedCart.id);
    }

    // The redemption is recorded against the paid order, so per-customer and
    // total-use limits count real purchases rather than attempts. The RPC locks
    // the code row and is a no-op on repeat, so a replayed webhook cannot
    // double-count a use or race another checkout past the limit.
    const { data: paidOrder } = await routeServiceClient
      .from("orders")
      .select("discount_code_id,discount_cents")
      .eq("id", orderId)
      .maybeSingle();

    if (paidOrder?.discount_code_id && Number(paidOrder.discount_cents) > 0) {
      const { error: redeemError } = await routeServiceClient.rpc("redeem_discount_code", {
        p_code_id: paidOrder.discount_code_id,
        p_order_id: orderId,
        p_customer_id: order.customer_id,
        p_amount_cents: Number(paidOrder.discount_cents),
      });
      // A failed redemption must not fail the payment: the money is already
      // taken and the order is settled. Surface it instead of throwing.
      if (redeemError) {
        captureCommerceException(redeemError, { operation: "redeem_discount", orderId, stripeEventId: event.id });
      }
    }
  }
  const { data: authUser } = await routeServiceClient.auth.admin.getUserById(order.customer_id);
  const config = await getCommerceEmailConfig();
  if (config.sendPaymentUpdates) await sendCommerceEmail({ to:authUser.user?.email, orderId, templateKey:"payment_received", eventKey:`stripe-paid-${event.id}`, variables:{ customer_name:authUser.user?.user_metadata?.display_name || authUser.user?.email?.split("@")[0] || "Customer", product_name:order.product_name, order_label:order.order_number || "your KeyMoura order", status:fullyPaid ? "paid in full" : "deposit received", price:`$${(session.amount_total/100).toFixed(2)}` } });
  await Promise.all([
    notifyOrderUser({
      orderId,
      actorUserId: null,
      recipientUserId: order.customer_id,
      title: "Payment received",
      message: `Your $${(session.amount_total / 100).toFixed(2)} payment was received.${fullyPaid ? " Your order is paid in full." : ` $${((order.agreed_price_cents-newNetCollected)/100).toFixed(2)} remains.`}`,
    }),
    notifyOrderStaff({ orderId, actorUserId:null, title:fullyPaid ? "Order paid in full" : "Deposit received", message:`$${(session.amount_total/100).toFixed(2)} was received for ${order.product_name}. Production is ready to continue.` }),
  ]);
  await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
  return NextResponse.json({ received: true });
}
