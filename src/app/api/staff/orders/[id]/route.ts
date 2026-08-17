import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordOrderAudit } from "@/lib/audit/orders";
import { getCommerceEmailConfig, sendCommerceEmail, type CommerceEmailTemplateKey } from "@/lib/commerceEmail";
import { notifyOrderUser } from "@/lib/orderNotifications";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { netCollectedCents, remainingBalanceCents } from "@/lib/paymentMath";

const allowedStatuses = new Set(["requested","needs_information","accepted","awaiting_payment","in_progress","customer_review","final_review","ready","completed","declined","cancelled"]);
const allowedFulfillmentMethods = new Set(["shipping", "pickup"]);
const optionalText = (value: unknown, max: number) => value === null ? null : typeof value === "string" ? value.trim().slice(0, max) || null : undefined;

function customerStatusNotification(status: string, productName: string) {
  const notifications: Record<string, { title: string; message: string }> = {
    needs_information: { title: "More information needed", message: `KeyMoura needs more information before work can continue on ${productName}. Open the order and reply in chat.` },
    accepted: { title: "Order request accepted", message: `KeyMoura accepted your ${productName} request. The quote and payment details will appear on your order page when ready.` },
    awaiting_payment: { title: "Payment ready", message: `Payment is ready for ${productName}. Open the order to review the amount and pay securely.` },
    in_progress: { title: "Production started", message: `Work has started on ${productName}. KeyMoura will notify you when it is ready for review.` },
    customer_review: { title: "Quote ready for review", message: `A quote for ${productName} is ready. Open the order to review and approve it.` },
    final_review: { title: "Finished product ready for review", message: `Your ${productName} is ready to review. View the photos and note, then approve it or request revisions.` },
    ready: { title: "Order ready for fulfillment", message: `${productName} is approved and moving to fulfillment.` },
    completed: { title: "Order completed", message: `${productName} has been marked complete.` },
    declined: { title: "Order request declined", message: `KeyMoura declined the ${productName} request. Open the order for details or to send a message.` },
    cancelled: { title: "Order cancelled", message: `${productName} was cancelled. Open the order for the cancellation details and refund status.` },
  };
  return notifications[status] ?? { title: "Order status updated", message: `Your order status changed to ${status.replaceAll("_", " ")}.` };
}

/**
 * The state the browser rendered from, compared with the state on the row.
 *
 * Both halves matter. This early check produces a readable 409 naming the
 * current status; the `.eq()` on the write below closes the remaining gap
 * between this read and that write, where a colleague's request can land.
 *
 * `quote_revision` is checked as well as `status`, because two staff editing a
 * price never change the status — they both sit on `accepted` — and a status
 * comparison alone would let the second one's price silently win.
 */
function staleConflict(
  body: Record<string, unknown>,
  existing: { status: string; quote_revision: number | null }
): NextResponse | null {
  const expectedStatus = body.expected_status;
  if (typeof expectedStatus === "string" && expectedStatus && expectedStatus !== existing.status) {
    return NextResponse.json(
      {
        error: `This order is now “${String(existing.status).replaceAll("_", " ")}”, not “${expectedStatus.replaceAll("_", " ")}”. Reload the order before changing it.`,
        conflict: true,
        currentStatus: existing.status,
      },
      { status: 409 }
    );
  }
  const expectedRevision = body.expected_quote_revision;
  if (
    Number.isInteger(expectedRevision) &&
    Number(expectedRevision) !== Number(existing.quote_revision || 0)
  ) {
    return NextResponse.json(
      {
        error: `A newer quote (revision ${existing.quote_revision}) was sent while this page was open. Reload the order before quoting again.`,
        conflict: true,
        currentStatus: existing.status,
      },
      { status: 409 }
    );
  }
  return null;
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "orders.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  const { data: existing } = await routeServiceClient.from("orders").select("*").eq("id", id).maybeSingle();
  if (!existing) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const conflict = staleConflict(body, existing);
  if (conflict) return conflict;

  const update: Record<string, unknown> = {};
  if (typeof body.status === "string") {
    if (!allowedStatuses.has(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 });
    update.status = body.status;
  }
  if (body.agreed_price_cents === null || Number.isInteger(body.agreed_price_cents)) {
    if (remainingBalanceCents(existing) === 0 && (existing.amount_paid_cents || 0) > (existing.amount_refunded_cents || 0) && body.agreed_price_cents !== existing.agreed_price_cents) return NextResponse.json({ error: "A paid order's price cannot be changed." }, { status: 409 });
    if (typeof body.agreed_price_cents === "number" && body.agreed_price_cents < 0) return NextResponse.json({ error: "Price cannot be negative." }, { status: 400 });
    update.agreed_price_cents = body.agreed_price_cents;
  }
  if (body.deposit_amount_cents === null || Number.isInteger(body.deposit_amount_cents)) {
    const total = typeof body.agreed_price_cents === "number" ? body.agreed_price_cents : existing.agreed_price_cents;
    if (typeof body.deposit_amount_cents === "number" && (body.deposit_amount_cents < 50 || !total || body.deposit_amount_cents > total)) return NextResponse.json({ error: "Deposit must be at least $0.50 and no more than the quote total." }, { status: 400 });
    update.deposit_amount_cents = body.deposit_amount_cents;
  }
  if (typeof body.target_date === "string" || body.target_date === null) update.target_date = body.target_date;
  if (typeof body.quote_expires_at === "string" || body.quote_expires_at === null) {
    if (body.quote_expires_at && Number.isNaN(new Date(body.quote_expires_at).getTime())) return NextResponse.json({ error: "Invalid quote expiration date." }, { status: 400 });
    update.quote_expires_at = body.quote_expires_at;
  }
  if (typeof body.staff_notes === "string" || body.staff_notes === null) update.staff_notes = body.staff_notes;
  if (typeof body.final_review_note === "string") {
    const note = body.final_review_note.trim().slice(0, 3000);
    if (body.status === "final_review" && note.length < 3) return NextResponse.json({ error: "Add a note for the customer before sending this review." }, { status: 400 });
    update.final_review_note = note || null;
  }
  if (Array.isArray(body.final_review_asset_paths)) {
    const paths = body.final_review_asset_paths.filter((path): path is string => typeof path === "string" && path.length <= 1000).slice(0, 6);
    if (body.status === "final_review" && paths.length < 1) return NextResponse.json({ error: "Add at least one finished-product photo before sending this review." }, { status: 400 });
    update.final_review_asset_paths = paths;
  }
  if (typeof body.fulfillment_method === "string") {
    if (!allowedFulfillmentMethods.has(body.fulfillment_method)) return NextResponse.json({ error: "Invalid fulfillment method" }, { status: 400 });
    update.fulfillment_method = body.fulfillment_method;
  }
  if (body.shipping_address === null || (typeof body.shipping_address === "object" && !Array.isArray(body.shipping_address))) update.shipping_address = body.shipping_address;
  for (const [key, max] of [["shipping_carrier",80],["tracking_number",160],["tracking_url",1000]] as const) {
    const value = optionalText(body[key], max);
    if (value !== undefined) update[key] = value;
  }
  if (update.tracking_url && !/^https:\/\//i.test(String(update.tracking_url))) return NextResponse.json({ error: "Tracking link must use https://" }, { status: 400 });
  /*
   * `shipment_action` is gone.
   *
   * It was the pass-1 fulfillment path: `mark_shipped` / `mark_delivered` set
   * `shipped_at`, moved `orders.status` and emailed the customer. Pass 8
   * replaced it with `POST /api/staff/orders/[id]/fulfillment` and pass 9 built
   * the UI, but the branch was left here, unreferenced by any caller, and it
   * was worse than dead code on two counts:
   *
   * 1. **It bypassed the permission that guards shipping.** Handing goods over
   *    needs `fulfillment.manage`; this route only asks for `orders.manage`. A
   *    shop hand who may edit an order could post one JSON body and ship it.
   * 2. **It never wrote `fulfillment_status`** — the column the cancellation and
   *    return eligibility rules actually read — so an order shipped this way
   *    stayed "unfulfilled" to every rule that asked, and still looked
   *    cancellable.
   *
   * Fulfillment now has exactly one write path, and it is the guarded one.
   */
  if (typeof body.shipment_action === "string") {
    return NextResponse.json(
      { error: "Fulfillment is changed from the fulfillment panel, which records the transition and notifies the customer once." },
      { status: 410 }
    );
  }
  if (update.status === "final_review" && (existing.status !== "in_progress" || remainingBalanceCents(existing) > 0)) return NextResponse.json({ error: "Only a fully paid order in production can be sent for final review." }, { status: 409 });
  if (update.status === "final_review" && (!update.final_review_note || !Array.isArray(update.final_review_asset_paths) || update.final_review_asset_paths.length < 1)) return NextResponse.json({ error: "Add a customer note and at least one photo before sending this review." }, { status: 400 });
  if (typeof update.agreed_price_cents === "number" && update.agreed_price_cents > 0 && (remainingBalanceCents(existing) > 0 || netCollectedCents(existing) === 0)) {
    update.payment_status = "unpaid";
    if (update.agreed_price_cents !== existing.agreed_price_cents || (update.deposit_amount_cents !== undefined && update.deposit_amount_cents !== existing.deposit_amount_cents)) {
      update.quote_revision = (existing.quote_revision || 0) + 1;
      update.quote_accepted_at = null;
      update.stripe_checkout_session_id = null;
      if (!body.status) update.status = "customer_review";
    }
  }
  if (update.status === "cancelled" && existing.status !== "cancelled") {
    const reason = optionalText(body.cancellation_reason, 1000);
    if (!reason) return NextResponse.json({ error: "A cancellation reason is required." }, { status: 400 });
    update.cancelled_at = new Date().toISOString();
    update.cancellation_reason = reason;
    update.stripe_checkout_session_id = null;
  }
  /*
   * Production finishing is what hands an order to fulfillment.
   *
   * `ready` is the point at which the goods exist and the fulfillment queue
   * starts offering the order as work. Stamping `ready_to_fulfill_at` here is
   * what gives that queue an age to sort by — before this, an order's "waiting
   * since" fell back to `updated_at`, so editing a note sent it to the back of
   * the line.
   *
   * The *fulfillment* status is deliberately not touched. It stays wherever it
   * is — `unfulfilled` on a fresh order — because handing over is a fulfillment
   * decision with its own guards and its own customer email, and writing both
   * fields from here is how an order ends up claiming to be packed by a route
   * that never looked at a shelf. Production complete is not order complete.
   */
  const handsOffToFulfillment = update.status === "ready" && existing.status !== "ready";
  if (handsOffToFulfillment && !existing.ready_to_fulfill_at) {
    update.ready_to_fulfill_at = new Date().toISOString();
  }
  /*
   * The guarded write.
   *
   * Re-asserting the status — and the quote revision whenever this request
   * creates a new one — closes the window between the `select` above and this
   * `update`. Two staff members pressing "Accept & continue" a moment apart used
   * to both succeed: each read `requested`, each wrote, and because each
   * inserted its own `order_status_history` row the derived `eventKey` differed,
   * so the customer received **two** emails. Now the second matches zero rows.
   *
   * `.select("id")` is what makes that visible. Without it Supabase reports
   * success for an update that changed nothing, which is precisely the silent
   * overwrite this pass exists to remove.
   */
  const base = routeServiceClient.from("orders").update(update).eq("id", id).eq("status", existing.status);
  const guarded = typeof update.quote_revision === "number" ? base.eq("quote_revision", existing.quote_revision || 0) : base;
  const { data: written, error } = await guarded.select("id").maybeSingle();
  if (error) return NextResponse.json({ error: "Could not update order" }, { status: 500 });
  if (!written) {
    // Re-read so the message names where the order actually is, rather than
    // telling staff "something changed" and leaving them to find out.
    const { data: current } = await routeServiceClient.from("orders").select("status,quote_revision").eq("id", id).maybeSingle();
    return NextResponse.json(
      {
        error: current
          ? `Somebody changed this order a moment ago — it is now “${String(current.status).replaceAll("_", " ")}”. Nothing was applied. Reload before trying again.`
          : "This order changed a moment ago. Nothing was applied. Reload before trying again.",
        conflict: true,
        currentStatus: current?.status ?? null,
      },
      { status: 409 }
    );
  }
  /*
   * The audit event, written at the earliest point the mutation is known to
   * have committed — immediately after the guarded update reported an affected
   * row, and before the emails and notifications that follow.
   *
   * Ordering matters in both directions. Writing it earlier would record a
   * change that the `.eq(status)` guard may have refused, which is the false
   * success this whole route is built to avoid. Writing it after the email
   * would leave a window where the customer has been told and nobody knows who
   * decided it.
   *
   * `auditRecorded` is carried into the response rather than dropped: the order
   * has already changed by now, so a failed audit write cannot roll anything
   * back — but reporting a clean success for an unrecorded change is exactly
   * how a log quietly stops being trustworthy.
   */
  const auditRecorded = await recordOrderAudit({
    orderId: id,
    before: existing,
    after: update,
    actorUserId: actor.userId,
    actorRole: actor.role,
    orderNumber: existing.order_number,
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  /*
   * Tell the fulfillment desk, now that the write is known to have committed.
   *
   * A different reader from the person who just approved the work: the customer
   * hears "moving to fulfillment" through the notification below, and this is
   * the internal cue that there is something to pack. Keyed on the order and
   * the kind, so re-saving a `ready` order does not raise it twice, and routed
   * to `fulfillment.view` rather than to whoever pressed the button.
   */
  if (handsOffToFulfillment) {
    await raiseOperationalAlert({
      kind: "order.ready_to_fulfill",
      subjectId: id,
      actorUserId: actor.userId,
      message: `${existing.order_number || "An order"} has finished production and is ready to prepare.`,
    });
  }

  if (typeof update.quote_revision === "number" && typeof update.agreed_price_cents === "number") {
    await routeServiceClient.from("order_quotes").insert({ order_id:id, revision:update.quote_revision, total_cents:update.agreed_price_cents, deposit_cents:update.deposit_amount_cents ?? existing.deposit_amount_cents, note:optionalText(body.quote_note,2000), created_by:actor.userId });
  }
  let historyId: number|string = Date.now();
  if (update.status && update.status !== existing.status) {
    const { data: history } = await routeServiceClient.from("order_status_history").insert({ order_id: id, from_status: existing.status, to_status: update.status, changed_by: actor.userId }).select("id").single();
    historyId = history?.id ?? historyId;
  }

  const { data: customer } = await routeServiceClient.auth.admin.getUserById(existing.customer_id);
  const priceBecamePayable = typeof update.quote_revision === "number" && typeof update.agreed_price_cents === "number" && update.agreed_price_cents > 0;
  const statusChanged = typeof update.status === "string" && update.status !== existing.status;
  if (priceBecamePayable || statusChanged) {
    const finalStatus = String(update.status || existing.status).replaceAll("_", " ");
    const statusNotification = customerStatusNotification(String(update.status || existing.status), existing.product_name);
    const message = priceBecamePayable ? `Quote revision ${update.quote_revision} is ready: $${(Number(update.agreed_price_cents) / 100).toFixed(2)}. Review and approve it from your order page.` : statusNotification.message;
    const config = await getCommerceEmailConfig();
    /**
     * A first quote and a revised quote are different news.
     *
     * "Your quote is ready" arriving for the third time, each with a different
     * number, reads as a system that cannot make up its mind. `quote_updated`
     * says plainly that this replaces what was sent before. The revision number
     * is what distinguishes them, and it is also what keys the send — so a
     * repeat of the same revision is suppressed while a genuinely new revision
     * is a new event.
     */
    const isQuoteRevision = priceBecamePayable && Number(existing.quote_revision ?? 0) > 0;
    const templateKey: CommerceEmailTemplateKey = priceBecamePayable
      ? (isQuoteRevision ? "quote_updated" : "quote_ready")
      : update.status === "needs_information" ? "needs_information" : "status_update";
    const eventKey = priceBecamePayable
      ? `order-quote-${id}-rev${update.quote_revision}`
      : `order-update-${id}-${historyId}-${templateKey}`;
    if ((priceBecamePayable || update.status === "awaiting_payment") ? config.sendPaymentUpdates : config.sendStatusUpdates) await sendCommerceEmail({ to:customer.user?.email, orderId:id, templateKey, eventKey, variables:{ customer_name:customer.user?.user_metadata?.display_name || customer.user?.email?.split("@")[0] || "Customer", product_name:existing.product_name, order_label:existing.order_number || "your request", status:finalStatus, price:typeof update.agreed_price_cents === "number" ? `$${(update.agreed_price_cents/100).toFixed(2)}` : "Price pending" } });
    await notifyOrderUser({
      orderId: id,
      actorUserId: actor.userId,
      recipientUserId: existing.customer_id,
      title: priceBecamePayable ? "Quote ready for review" : statusNotification.title,
      message,
    });
  }
  /*
   * The shipped/delivered emails that used to live here went with
   * `shipment_action`. `POST /api/staff/orders/[id]/fulfillment` sends them
   * from `FULFILLMENT_CUSTOMER_EMAIL` — the same table it shows staff in the
   * confirmation — so the preview and the send cannot disagree, and the event
   * key is derived from the state rather than from a row id that changes on
   * every click.
   */
  return NextResponse.json({
    ok: true,
    status: update.status ?? existing.status,
    quote_revision: update.quote_revision ?? existing.quote_revision,
    // `null` means there was nothing to record. `false` means there was and it
    // could not be written — the change stands but the trail has a hole in it.
    ...(auditRecorded === false ? { auditFailed: true } : {}),
  });
}
