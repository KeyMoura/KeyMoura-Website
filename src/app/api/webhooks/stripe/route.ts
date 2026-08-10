import { NextRequest, NextResponse } from "next/server";
import type Stripe from "stripe";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { getCommerceEmailConfig, sendCommerceEmail } from "@/lib/commerceEmail";
import { notifyOrderStaff, notifyOrderUser } from "@/lib/orderNotifications";
import { guestDisplayName } from "@/lib/commerce/guestOrders";
import { raiseOperationalAlert, recordIntegrationObservation } from "@/lib/comms/operationalAlerts";
import { captureCommerceException } from "@/lib/monitoring";
import {
  logLifecycleAudit,
  logLifecycleFailure,
  moneyText,
  sendLifecycleNotification,
  type OrderLifecycleRow,
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
    .select("id,customer_id,guest_email,guest_name,product_name,order_number,cancellation_status,return_status,amount_paid_cents,amount_refunded_cents")
    .eq("id", refund.order_id)
    .maybeSingle();
  if (!order) return;

  const amount = Number(refund.confirmed_amount_cents ?? refund.amount_cents ?? 0);
  const succeeded = status === "succeeded";
  /**
   * Partial and full refunds are different news and get different templates.
   *
   * A customer told "your refund is complete" about a $20 refund on a $300
   * order will reasonably conclude the order is cancelled. The comparison is
   * made against what the order has actually collected and returned, read after
   * settlement, rather than against the refund amount alone — a second partial
   * refund that happens to clear the balance is a full refund from the
   * customer's point of view even though its own amount is not the total.
   */
  const paidCents = Number(order.amount_paid_cents ?? 0);
  const refundedCents = Number(order.amount_refunded_cents ?? 0);
  const fullyRefunded = paidCents > 0 && refundedCents >= paidCents;

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
    order: order as unknown as Pick<OrderLifecycleRow, "customer_id" | "guest_email" | "guest_name" | "product_name" | "order_number">,
    actorUserId: null,
    templateKey: succeeded ? (fullyRefunded ? "refund_completed" : "refund_partial_completed") : "refund_failed",
    eventKey: `refund-webhook-${stripeRefundId}-${status}`,
    title: succeeded ? (fullyRefunded ? "Refund complete" : "Partial refund complete") : "Refund needs attention",
    message: succeeded
      ? fullyRefunded
        ? `Your ${moneyText(amount)} refund has completed. Your bank may take a few more days to show it.`
        : `A partial refund of ${moneyText(amount)} has completed. The rest of the order is unaffected.`
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
    // Stripe settled this, not "the system". Naming the provider is the point
    // of the actor model: it is the difference between "a refund completed" and
    // "the card network told us a refund completed".
    provider: "Stripe",
    orderId: refund.order_id,
    orderNumber: order.order_number,
    metadata: { refund_id: refund.id, amount_cents: amount, stripe_event_id: eventId },
  });
}

/**
 * A webhook that arrived but could not be processed.
 *
 * This is the failure that is invisible without an alert: Stripe records a
 * non-2xx and retries for a while, and if nobody is watching, an order settles
 * in Stripe and never settles here. The alert is keyed on the Stripe event id,
 * so Stripe's own retries of the same event produce one entry rather than one
 * per attempt.
 *
 * The summary carries the operation and the event type and nothing else — no
 * Postgres `details`, which is the field that echoes row values back, and on
 * this schema a row value can be an address or a private note.
 */
async function webhookFailed(event: Stripe.Event, operation: string): Promise<NextResponse> {
  await Promise.all([
    recordIntegrationObservation({
      integrationKey: "stripe_webhook",
      outcome: "failure",
      summary: `${operation} failed for ${event.type}`,
    }),
    raiseOperationalAlert({
      kind: "ops.webhook_failure",
      subjectId: event.id,
      message: `A Stripe ${event.type} webhook could not be processed (${operation}). Stripe will retry; if it keeps failing the order will not settle here.`,
    }),
  ]);
  return NextResponse.json({ error: "Could not record event" }, { status: 500 });
}

export async function POST(req: NextRequest) {
  const signature = req.headers.get("stripe-signature");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!signature || !secret) return NextResponse.json({ error: "Webhook not configured" }, { status: 400 });
  let event: Stripe.Event;
  try { event = stripeClient().webhooks.constructEvent(await req.text(), signature, secret); }
  // A bad signature is deliberately *not* recorded or alerted on. Anybody can
  // POST to this URL, so counting those would be counting the internet — and
  // an alert anybody can trigger is an alert staff learn to dismiss.
  catch { return NextResponse.json({ error: "Invalid signature" }, { status: 400 }); }

  // A verified signature is the strongest available proof that the endpoint is
  // reachable, subscribed and holding the right secret. This is what lets the
  // health page say Stripe webhooks are *verified* working rather than merely
  // configured — an environment variable being present proves neither.
  await recordIntegrationObservation({
    integrationKey: "stripe_webhook",
    outcome: "success",
    summary: event.type,
  });
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
      return webhookFailed(event, "record_refund_event");
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
      return webhookFailed(event, "record_expired_event");
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
      return webhookFailed(event, "record_failed_payment_event");
    }
    const failedSession = event.data.object as Stripe.Checkout.Session;
    const failedOrderId = failedSession.metadata?.order_id || failedSession.client_reference_id;
    const failedCustomerId = failedSession.metadata?.customer_id;
    /**
     * A guest session carries no `customer_id`, so the old
     * `if (failedOrderId && failedCustomerId)` would have skipped the whole
     * branch for a guest: the order would have stayed `unpaid` rather than
     * `payment_failed`, **the inventory hold would never have been released**,
     * and nobody would have been told. Marked as a guest instead, which the
     * checkout route sets on every guest session.
     */
    const failedIsGuest = failedSession.metadata?.guest === "1";
    if (failedOrderId && (failedCustomerId || failedIsGuest)) {
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
      const failedOrder = await routeServiceClient
        .from("orders")
        .select("product_name,order_number,customer_id,guest_email,guest_name")
        .eq("id", failedOrderId)
        .maybeSingle();
      const failedProduct = String(failedOrder.data?.product_name || "your order");
      const failedLabel = String(failedOrder.data?.order_number || "your KeyMoura order");
      // The order row, not the session metadata, decides who this is: the
      // metadata says which kind of checkout it was, the row says who owns it.
      const failedOwnerId = (failedOrder.data?.customer_id as string | null) ?? null;
      const failedGuestEmail = (failedOrder.data?.guest_email as string | null) ?? null;
      const { data: failedAuthUser } = failedOwnerId
        ? await routeServiceClient.auth.admin.getUserById(failedOwnerId)
        : { data: null };
      const failedRecipient = failedOwnerId ? failedAuthUser?.user?.email : failedGuestEmail ?? undefined;
      const failedName = failedOwnerId
        ? failedAuthUser?.user?.user_metadata?.display_name || failedAuthUser?.user?.email?.split("@")[0] || "Customer"
        : guestDisplayName({ email: failedGuestEmail ?? "", name: failedOrder.data?.guest_name as string | null });
      const failedConfig = await getCommerceEmailConfig();

      await Promise.all([
        // A guest has no bell for an in-app notification to land in; the email
        // below is how they hear about it.
        failedOwnerId
          ? notifyOrderUser({ orderId:failedOrderId, actorUserId:null, recipientUserId:failedOwnerId, title:"Payment failed", message:"Your payment did not complete. No successful payment was recorded; open the order to try again." })
          : Promise.resolve(),
        // Deduplicated on the order rather than the Stripe event, so a customer
        // who fails twice does not fill the staff bell with the same line.
        raiseOperationalAlert({
          kind: "order.payment_failed",
          subjectId: failedOrderId,
          discriminator: event.id,
          message: `A delayed payment for ${failedLabel} failed. The order is unpaid and the customer can try again.`,
        }),
        // The customer is told once, keyed on the Stripe event so a redelivery
        // of the same failure is silent.
        failedConfig.sendPaymentUpdates
          ? sendCommerceEmail({
              to: failedRecipient,
              orderId: failedOrderId,
              templateKey: "payment_failed",
              eventKey: `stripe-payment-failed-${event.id}`,
              variables: {
                customer_name: failedName,
                product_name: failedProduct,
                order_label: failedLabel,
                status: "payment failed",
                price: "",
                detail: "Nothing has been charged.",
              },
            })
          : Promise.resolve(),
        failedConfig.staffNotificationEmail
          ? sendCommerceEmail({
              to: failedConfig.staffNotificationEmail,
              orderId: failedOrderId,
              templateKey: "staff_payment_failed",
              eventKey: `stripe-payment-failed-staff-${event.id}`,
              href: `/staff/orders/${failedOrderId}`,
              variables: {
                customer_name: "",
                product_name: failedProduct,
                order_label: failedLabel,
                status: "payment failed",
                price: "",
                detail: "The hold on any reserved stock has been released per policy.",
              },
            })
          : Promise.resolve(),
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
  if (inserted.error) return webhookFailed(event, "record_checkout_event");

  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,product_name,customer_id,guest_email,guest_name,agreed_price_cents,order_kind,stripe_checkout_session_id").eq("id", orderId).maybeSingle();
  /**
   * Binding a session to an order.
   *
   * An account order matches on `customer_id`, exactly as before. A guest
   * order has none, and `undefined !== null` would have refused every guest
   * payment — while `null === null` would have been a comparison that proves
   * nothing, which is worse. A guest session must therefore say it is one and
   * be **the session this order recorded**: that id is minted by Stripe and
   * written by the checkout route, so it is a strictly stronger binding than
   * the identity comparison it stands in for, not a relaxed one.
   */
  const guestOrder = Boolean(order && !order.customer_id);
  const identityMatches = order
    ? guestOrder
      ? session.metadata?.guest === "1" && order.stripe_checkout_session_id === session.id
      : session.metadata?.customer_id === order.customer_id
    : false;
  if (!order || !order.agreed_price_cents || !identityMatches) {
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

  /*
   * One audit event for the business transition, not one per webhook.
   *
   * `stripe_webhook_events` already keeps the full provider record, and
   * duplicating every delivery into the audit log would bury the handful of
   * events a person actually decided. This fires only once the payment was
   * genuinely applied — `result.applied` is false for a replay, and the branch
   * above has already returned — and it carries the Stripe event id so the
   * provider record is one lookup away.
   */
  await logLifecycleAudit({
    eventType: "order.payment_status_changed",
    actorUserId: null,
    provider: "Stripe",
    orderId,
    orderNumber: order.order_number,
    changes: {
      payment_status: { before: "unpaid", after: fullyPaid ? "paid" : "partial" },
    },
    metadata: {
      stripe_event_id: event.id,
      amount_cents: session.amount_total,
      amount_paid_cents: newNetCollected,
      fully_paid: fullyPaid,
    },
  });

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
  // A guest has no auth user to look up, and asking for one by a null id is a
  // request that can only fail.
  const authUser = order.customer_id
    ? (await routeServiceClient.auth.admin.getUserById(order.customer_id)).data
    : null;
  const config = await getCommerceEmailConfig();
  const paidAmount = `$${(session.amount_total / 100).toFixed(2)}`;
  const recipientEmail = order.customer_id ? authUser?.user?.email : order.guest_email ?? undefined;
  const customerName = order.customer_id
    ? authUser?.user?.user_metadata?.display_name || authUser?.user?.email?.split("@")[0] || "Customer"
    : guestDisplayName({ email: order.guest_email ?? "", name: order.guest_name });
  const orderLabel = order.order_number || "your KeyMoura order";
  const isDirectPurchase = order.order_kind === "direct_purchase";

  /**
   * A direct purchase gets `order_received`; everything else gets
   * `payment_received`.
   *
   * They are the same moment for a direct purchase — the order only becomes an
   * order when the money lands — so sending both would be two emails about one
   * event. A custom request has already had `request_received` at submission
   * and `quote_ready` at pricing, so the thing that is news here is the
   * payment, not the order.
   *
   * Before this pass a direct purchase received `payment_received` alone and
   * never a word acknowledging the order itself.
   */
  if (config.sendPaymentUpdates) {
    await sendCommerceEmail({
      to: recipientEmail,
      orderId,
      templateKey: isDirectPurchase ? "order_received" : "payment_received",
      eventKey: isDirectPurchase ? `order-received-${orderId}` : `stripe-paid-${event.id}`,
      variables: {
        customer_name: customerName,
        product_name: order.product_name,
        order_label: orderLabel,
        status: fullyPaid ? "paid in full" : "deposit received",
        price: paidAmount,
        detail: isDirectPurchase
          ? `Your payment of ${paidAmount} has been received.`
          : "",
      },
    });
  }

  // Staff hear about a new direct order by email as well as in the bell. A
  // custom request already sent `staff_new_request` at submission; sending a
  // second alert for the same order would train staff to ignore the first.
  if (isDirectPurchase && config.staffNotificationEmail) {
    await sendCommerceEmail({
      to: config.staffNotificationEmail,
      orderId,
      templateKey: "staff_new_order",
      eventKey: `order-received-staff-${orderId}`,
      href: `/staff/orders/${orderId}`,
      variables: {
        customer_name: "",
        product_name: order.product_name,
        order_label: orderLabel,
        status: fullyPaid ? "paid in full" : "deposit received",
        price: paidAmount,
        detail: "Stock has been committed and the order is ready to prepare.",
      },
    });
  }

  await Promise.all([
    raiseOperationalAlert({
      kind: isDirectPurchase ? "order.new_direct" : "order.payment_received",
      subjectId: orderId,
      message: isDirectPurchase
        ? `${orderLabel} — ${paidAmount} paid for ${order.product_name}. Ready to prepare.`
        : `${paidAmount} was received for ${orderLabel}.${fullyPaid ? " Paid in full." : ""}`,
    }),
    // An in-app notification needs an account to land in. A guest has none —
    // their receipt is the email above, and inventing a notification nobody
    // can ever open would only make the bell's counts wrong.
    order.customer_id
      ? notifyOrderUser({
          orderId,
          actorUserId: null,
          recipientUserId: order.customer_id,
          title: "Payment received",
          message: `Your $${(session.amount_total / 100).toFixed(2)} payment was received.${fullyPaid ? " Your order is paid in full." : ` $${((order.agreed_price_cents-newNetCollected)/100).toFixed(2)} remains.`}`,
        })
      : Promise.resolve(),
    notifyOrderStaff({ orderId, actorUserId:null, title:fullyPaid ? "Order paid in full" : "Deposit received", message:`$${(session.amount_total/100).toFixed(2)} was received for ${order.product_name}. Production is ready to continue.` }),
  ]);
  await routeServiceClient.from("stripe_webhook_events").update({ processed_at: new Date().toISOString() }).eq("stripe_event_id", event.id);
  return NextResponse.json({ received: true });
}
