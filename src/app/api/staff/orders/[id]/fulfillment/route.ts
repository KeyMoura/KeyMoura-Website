import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  loadCommerceSettings,
  loadFulfillmentHistory,
  transitionFulfillment,
} from "@/lib/commerce/commerceSettingsServer";
import {
  logLifecycleAudit,
  logLifecycleFailure,
  sendLifecycleNotification,
  type OrderLifecycleRow,
} from "@/lib/commerce/orderLifecycleServer";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import {
  FULFILLMENT_CUSTOMER_EMAIL,
  FULFILLMENT_LABELS,
  FULFILLMENT_STAFF_LABELS,
  canTransitionFulfillmentForMethod,
  fulfillmentTransitionsFor,
  lifecycleLabel,
  type FulfillmentState,
} from "@/lib/commerce/orderLifecycle";
import {
  buildTrackingUrl,
  customerTrackingUrl,
  isSafeTrackingUrl,
  isValidTrackingNumber,
  normalizeTrackingNumber,
} from "@/lib/commerce/commerceSettings";
import type { CommerceEmailTemplateKey } from "@/lib/commerceEmail";

/**
 * Staff fulfillment control.
 *
 * `GET` answers what is possible right now — the legal transitions for *this*
 * order's method, and what the customer would be told by each — so the page
 * shows exactly what will happen before anything is confirmed.
 *
 * `POST` performs one explicit action. Selecting a status in a dropdown does
 * not reach this route; only pressing the button does.
 */

export const runtime = "nodejs";

const ORDER_COLUMNS =
  "id,order_number,customer_id,guest_email,guest_name,product_name,status,payment_status,fulfillment_status,fulfillment_method," +
  "shipping_address,shipping_carrier,tracking_number,tracking_url,shipped_at,delivered_at,ready_at," +
  "picked_up_at,ready_to_fulfill_at,pickup_confirmed_at,fulfillment_notes,customer_shipment_note," +
  "pickup_location_snapshot,shipping_method_snapshot,shipping_cents,fulfillment_updated_at,amount_paid_cents," +
  "amount_refunded_cents,agreed_price_cents";

type OrderRow = {
  id: string;
  /** Null on a guest order. */
  customer_id: string | null;
  guest_email: string | null;
  guest_name: string | null;
  product_name: string;
  order_number: string | null;
  status: string;
  payment_status: string;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
  fulfillment_status: string;
  fulfillment_method: string;
  shipping_address: unknown;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  ready_to_fulfill_at: string | null;
  pickup_confirmed_at: string | null;
  fulfillment_notes: string | null;
  customer_shipment_note: string | null;
  pickup_location_snapshot: Record<string, unknown> | null;
  shipping_method_snapshot: Record<string, unknown> | null;
  shipping_cents: number | null;
  fulfillment_updated_at: string | null;
};

/**
 * Transitions that hand the goods over — posted, or across the counter.
 *
 * These are gated on the balance being settled. The rule is not new: the legacy
 * `shipment_action` on `PATCH /api/staff/orders/[id]` refused to ship an order
 * with money outstanding, and moving fulfillment onto its own state machine
 * must not quietly drop a guard that stops stock leaving unpaid. `processing`
 * is deliberately *not* in this list — packing an order early is normal, and
 * only the handover is consequential.
 */
const RELEASES_GOODS: readonly FulfillmentState[] = ["shipped", "ready_for_pickup", "picked_up", "delivered"];

/**
 * Fulfillment states that mean the customer has the goods.
 *
 * Reaching one closes out a custom-request order, which is what the legacy
 * `mark_delivered` action did. Without this, an order could be delivered and
 * still read "Ready" to its customer forever, because `orders.status` and
 * `orders.fulfillment_status` are separate fields and only one of them moved.
 */
const COMPLETES_ORDER: readonly FulfillmentState[] = ["delivered", "picked_up"];

function outstandingBalanceCents(order: {
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
}): number {
  const net = Math.max(0, (order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0));
  return Math.max(0, (order.agreed_price_cents || 0) - net);
}

async function loadOrder(id: string): Promise<OrderRow | null> {
  const { data, error } = await routeServiceClient.from("orders").select(ORDER_COLUMNS).eq("id", id).maybeSingle();
  if (error) {
    logLifecycleFailure("load_order_fulfillment", error, { orderId: id });
    return null;
  }
  return (data as unknown as OrderRow) ?? null;
}

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "fulfillment.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;

  const order = await loadOrder(id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const settings = await loadCommerceSettings();
  const method = String(order.fulfillment_method || "shipping");
  const from = String(order.fulfillment_status || "unfulfilled");

  const balance = outstandingBalanceCents(order);

  const transitions = fulfillmentTransitionsFor(from, method).map((to) => ({
    to,
    staffLabel: FULFILLMENT_STAFF_LABELS[to],
    customerLabel: FULFILLMENT_LABELS[to],
    // Exactly what the customer will be sent, surfaced before confirming.
    emailTemplate: FULFILLMENT_CUSTOMER_EMAIL[to] ?? null,
    requiresTracking: to === "shipped" && method === "shipping",
    // Answered here rather than recomputed in the browser, so the button the
    // page disables and the transition the route refuses are the same set.
    blockedReason: RELEASES_GOODS.includes(to) && balance > 0
      ? `$${(balance / 100).toFixed(2)} is still owed on this order.`
      : null,
  }));

  return NextResponse.json({
    order: {
      id: order.id,
      orderNumber: order.order_number,
      orderStatus: order.status,
      outstandingBalanceCents: balance,
      fulfillmentStatus: from,
      fulfillmentMethod: method,
      staffLabel: lifecycleLabel(FULFILLMENT_STAFF_LABELS, from),
      customerLabel: lifecycleLabel(FULFILLMENT_LABELS, from),
      shippingCarrier: order.shipping_carrier ?? null,
      trackingNumber: order.tracking_number ?? null,
      customerTrackingUrl: customerTrackingUrl(settings, order),
      shippedAt: order.shipped_at ?? null,
      deliveredAt: order.delivered_at ?? null,
      readyAt: order.ready_at ?? null,
      pickedUpAt: order.picked_up_at ?? null,
      fulfillmentNotes: order.fulfillment_notes ?? null,
      customerShipmentNote: order.customer_shipment_note ?? null,
      shippingAddress: order.shipping_address ?? null,
      shippingMethodSnapshot: order.shipping_method_snapshot ?? null,
      pickupLocationSnapshot: order.pickup_location_snapshot ?? null,
      shippingCents: Number(order.shipping_cents ?? 0),
      updatedAt: order.fulfillment_updated_at ?? null,
    },
    transitions,
    carriers: settings.shipping.trackingTemplates.map((t) => ({ carrier: t.carrier, label: t.label })),
    history: await loadFulfillmentHistory(id),
  });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "fulfillment.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await context.params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const order = await loadOrder(id);
  if (!order) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const settings = await loadCommerceSettings();
  const method = String(order.fulfillment_method || "shipping");
  const current = String(order.fulfillment_status || "unfulfilled");
  const action = String(body.action || "");

  // The browser sends what it believed the state was. A change that landed in
  // between is refused rather than overwritten, and the message tells staff to
  // reload rather than leaving them guessing why nothing happened.
  const expected = typeof body.expectedStatus === "string" ? body.expectedStatus : null;
  if (expected && expected !== current) {
    return NextResponse.json(
      { error: "This order moved on since the page loaded. Reload to see where it is now.", status: current },
      { status: 409 }
    );
  }

  if (action === "update_tracking") {
    return updateTracking({ order, body, settings, actorUserId: actor.userId, method, current });
  }

  if (action !== "transition") {
    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  }

  const to = String(body.to || "") as FulfillmentState;
  if (!canTransitionFulfillmentForMethod(current, to, method)) {
    return NextResponse.json(
      {
        error: `A ${lifecycleLabel(FULFILLMENT_STAFF_LABELS, current).toLowerCase()} ${method === "pickup" ? "pickup" : "order"} cannot move to ${lifecycleLabel(FULFILLMENT_STAFF_LABELS, to).toLowerCase()}.`,
        allowed: fulfillmentTransitionsFor(current, method),
      },
      { status: 409 }
    );
  }

  // Stock does not leave the building against an unpaid balance. Checked
  // server-side rather than only by disabling the button, because the button is
  // a convenience and this is the control.
  if (RELEASES_GOODS.includes(to)) {
    const balance = outstandingBalanceCents(order);
    if (balance > 0) {
      return NextResponse.json(
        {
          error: `$${(balance / 100).toFixed(2)} is still owed on this order. Collect the balance before releasing the goods.`,
        },
        { status: 409 }
      );
    }
  }

  // A parcel is not shipped without a way to find it. Refused before the state
  // moves, so the order does not end up "shipped" with nothing to tell the
  // customer.
  if (to === "shipped" && method === "shipping") {
    const carrier = String(body.carrier ?? order.shipping_carrier ?? "").trim();
    const number = normalizeTrackingNumber(body.trackingNumber ?? order.tracking_number);
    if (!carrier || !number) {
      return NextResponse.json({ error: "Add a carrier and tracking number before marking this shipped." }, { status: 400 });
    }
    const applied = await applyTracking({ orderId: order.id, carrier, number, manualUrl: body.trackingUrl, settings });
    if (!applied.ok) return NextResponse.json({ error: applied.reason }, { status: 400 });
  }

  const result = await transitionFulfillment({
    orderId: order.id,
    from: current,
    to,
    actorUserId: actor.userId,
    note: typeof body.note === "string" ? body.note.slice(0, 1000) : null,
    metadata: { method, via: "staff" },
  });

  if (!result.ok) {
    if (result.error === "stale") {
      return NextResponse.json(
        { error: "This order moved on since the page loaded. Reload to see where it is now.", status: result.status },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Could not update fulfillment." }, { status: 500 });
  }

  // A repeated submission lands here and stops: no second email, no second
  // audit event, no error for the operator to interpret.
  if (result.already) return NextResponse.json({ ok: true, already: true, status: to });

  const internalNote = typeof body.internalNote === "string" ? body.internalNote.slice(0, 2000) : null;
  const customerNote = typeof body.customerNote === "string" ? body.customerNote.slice(0, 1000) : null;
  if (internalNote !== null || customerNote !== null) {
    await routeServiceClient
      .from("orders")
      .update({
        ...(internalNote !== null ? { fulfillment_notes: internalNote || null } : {}),
        ...(customerNote !== null ? { customer_shipment_note: customerNote || null } : {}),
      })
      .eq("id", order.id);
  }

  if (to === "picked_up") {
    await routeServiceClient
      .from("orders")
      .update({ pickup_confirmed_at: new Date().toISOString() })
      .eq("id", order.id)
      .is("pickup_confirmed_at", null);
  }

  /*
   * Close out the order when the customer has the goods.
   *
   * `orders.status` and `orders.fulfillment_status` are independent fields, and
   * `transition_order_fulfillment` deliberately only writes the latter. The
   * legacy `shipment_action` moved a `ready` custom-request order to
   * `completed`; that is the one status movement fulfillment genuinely owns, so
   * it is carried here rather than left behind with the control that replaced
   * it. It is conditional on the order still being `ready`, so a cancelled or
   * already-completed order is not resurrected, and the `.eq("status","ready")`
   * makes a concurrent change match zero rows rather than overwrite it.
   */
  if (COMPLETES_ORDER.includes(to) && order.status === "ready") {
    const stamp = new Date().toISOString();
    await routeServiceClient
      .from("orders")
      .update({ status: "completed", completed_at: stamp })
      .eq("id", order.id)
      .eq("status", "ready");
  }

  await notifyCustomer({ order, to, method, settings, actorUserId: actor.userId, customerNote });

  await logLifecycleAudit({
    eventType: "staff.order.fulfillment_changed",
    actorUserId: actor.userId,
    orderId: order.id,
    // The note bodies are deliberately not copied in: the audit log is read
    // more widely than the order page.
    metadata: { from: current, to, method, had_customer_note: Boolean(customerNote) },
  });

  return NextResponse.json({ ok: true, already: false, status: to });
}

/**
 * Write carrier, number and link together.
 *
 * The link is generated from a configured template wherever possible, so it
 * cannot be attacker-supplied text. A manual URL is accepted only when it
 * passes the https/no-credentials check — a URL saved before that validation
 * existed does not become trusted by age, because this runs on every write.
 */
async function applyTracking(input: {
  orderId: string;
  carrier: string;
  number: string;
  manualUrl: unknown;
  settings: Awaited<ReturnType<typeof loadCommerceSettings>>;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isValidTrackingNumber(input.number)) {
    return { ok: false, reason: "That does not look like a tracking number." };
  }

  const generated = buildTrackingUrl(input.settings, input.carrier, input.number);
  let url: string | null = generated.ok ? generated.url : null;

  if (!url && typeof input.manualUrl === "string" && input.manualUrl.trim()) {
    if (!isSafeTrackingUrl(input.manualUrl)) {
      return { ok: false, reason: "A tracking link must be an https:// address with no embedded credentials." };
    }
    url = input.manualUrl.trim();
  }

  const { error } = await routeServiceClient
    .from("orders")
    .update({
      shipping_carrier: input.carrier.slice(0, 80),
      tracking_number: input.number,
      tracking_url: url,
    })
    .eq("id", input.orderId);

  if (error) {
    logLifecycleFailure("apply_tracking", error, { orderId: input.orderId });
    return { ok: false, reason: "Could not save the tracking details." };
  }
  return { ok: true };
}

/**
 * Correcting tracking on an order that has already shipped.
 *
 * The state does not rewind — a shipped order stays shipped — and the previous
 * values are written into the fulfillment history before being replaced, so a
 * correction is visible rather than silent.
 */
async function updateTracking(input: {
  order: OrderRow;
  body: Record<string, unknown>;
  settings: Awaited<ReturnType<typeof loadCommerceSettings>>;
  actorUserId: string;
  method: string;
  current: string;
}) {
  if (input.method !== "shipping") {
    return NextResponse.json({ error: "This order is not being shipped, so it has no tracking." }, { status: 409 });
  }

  const carrier = String(input.body.carrier ?? "").trim();
  const number = normalizeTrackingNumber(input.body.trackingNumber);
  if (!carrier || !number) {
    return NextResponse.json({ error: "A carrier and a tracking number are both required." }, { status: 400 });
  }

  const previousNumber = String(input.order.tracking_number || "");
  const previousCarrier = String(input.order.shipping_carrier || "");
  const isCorrection = Boolean(previousNumber) && (previousNumber !== number || previousCarrier !== carrier);

  const applied = await applyTracking({
    orderId: input.order.id,
    carrier,
    number,
    manualUrl: input.body.trackingUrl,
    settings: input.settings,
  });
  if (!applied.ok) return NextResponse.json({ error: applied.reason }, { status: 400 });

  await routeServiceClient.from("order_fulfillment_events").insert({
    order_id: input.order.id,
    from_status: input.current,
    to_status: input.current,
    actor_user_id: input.actorUserId,
    actor_role: "staff",
    note: isCorrection ? "Tracking corrected" : "Tracking added",
    // The previous values are kept so a correction can be explained later.
    metadata: {
      previous_carrier: previousCarrier || null,
      previous_tracking: previousNumber || null,
      carrier,
      tracking: number,
    },
  });

  await logLifecycleAudit({
    eventType: isCorrection ? "staff.order.tracking_corrected" : "staff.order.tracking_added",
    actorUserId: input.actorUserId,
    orderId: input.order.id,
    metadata: { carrier, corrected: isCorrection },
  });

  // Only a correction is worth an email. Adding tracking for the first time is
  // announced by the "shipped" message that carries it.
  if (isCorrection) {
    await sendLifecycleNotification({
      orderId: input.order.id,
      order: input.order as unknown as Pick<OrderLifecycleRow, "customer_id" | "guest_email" | "guest_name" | "product_name" | "order_number">,
      actorUserId: input.actorUserId,
      templateKey: "tracking_corrected",
      eventKey: `tracking-corrected-${input.order.id}-${number}`,
      title: "Tracking updated",
      message: `The tracking details for your order have been corrected. The new number is ${number}.`,
      detail: "",
      price: "",
      // The `tracking_corrected` template interpolates both of these. Without
      // them it reads "the new tracking number is  with ."
      extraVariables: { carrier, tracking_number: number },
    });
  }

  return NextResponse.json({ ok: true, corrected: isCorrection });
}

/**
 * The collection address, as one readable block.
 *
 * Only ever built for a pickup order and only for the ready-to-collect and
 * collected messages — which is the point at which the customer needs to know
 * where to come. The commerce settings keep `revealAddressBeforeReady` off by
 * default for exactly this reason: until an order is ready, a customer has no
 * reason to be given the address of the building the stock is in.
 */
function pickupLocationText(settings: Awaited<ReturnType<typeof loadCommerceSettings>>): string {
  const address = settings.pickup.address;
  return [
    settings.pickup.locationName,
    address.line1,
    address.line2,
    [address.city, address.region, address.postalCode].filter(Boolean).join(", "),
  ]
    .map((line) => String(line ?? "").trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * The customer message for a transition.
 *
 * Driven by `FULFILLMENT_CUSTOMER_EMAIL`, the same table `GET` shows staff, so
 * the preview and the send cannot disagree. Transitions with no entry — packed,
 * cancelled — send nothing, because the customer has no action to take.
 */
async function notifyCustomer(input: {
  order: OrderRow;
  to: FulfillmentState;
  method: string;
  settings: Awaited<ReturnType<typeof loadCommerceSettings>>;
  actorUserId: string;
  customerNote: string | null;
}) {
  const templateKey = FULFILLMENT_CUSTOMER_EMAIL[input.to] as CommerceEmailTemplateKey | undefined;
  if (!templateKey) return;
  if (!input.settings.email.categories.fulfillment) return;
  if (input.to === "ready_for_pickup" && !input.settings.pickup.notifyWhenReady) return;

  const tracking = customerTrackingUrl(input.settings, input.order);

  const messages: Partial<Record<FulfillmentState, string>> = {
    processing: "We are getting your order ready. We will let you know as soon as it is on its way.",
    ready_for_pickup: "Your order is ready to collect.",
    picked_up: "Your order was collected. Thank you.",
    shipped: tracking ? "Your order has shipped. The tracking link is on your order page." : "Your order has shipped.",
    delivered: "Your order was marked delivered.",
  };

  await sendLifecycleNotification({
    orderId: input.order.id,
    order: input.order as unknown as Pick<OrderLifecycleRow, "customer_id" | "guest_email" | "guest_name" | "product_name" | "order_number">,
    actorUserId: input.actorUserId,
    templateKey,
    // Keyed on the order and the state, so a retried request or a double-click
    // that somehow reaches here twice still sends one message.
    eventKey: `fulfillment-${input.order.id}-${input.to}`,
    title: lifecycleLabel(FULFILLMENT_LABELS, input.to),
    message: messages[input.to] || lifecycleLabel(FULFILLMENT_LABELS, input.to),
    // The only free text that reaches the customer is the note staff wrote
    // *for* them. `fulfillment_notes` is never routed here.
    detail: input.customerNote || "",
    price: "",
    href: input.to === "shipped" && tracking ? tracking : undefined,
    /**
     * The delivery facts the seeded templates actually interpolate.
     *
     * Pass 8 seeded `order_shipped` as "has shipped with {{carrier}}. Tracking
     * number: {{tracking_number}}." and `order_ready_for_pickup` with
     * `{{pickup_location}}` and `{{pickup_instructions}}` — and nothing ever
     * supplied any of them, so those interpolated to empty strings and the
     * customer received "has shipped with . Tracking number: ." and a pickup
     * notice with two blank paragraphs where the address belongs.
     *
     * The pickup *location* here is the address the customer is being told to
     * come to, which is a different value from the shipping origin. The origin
     * is deliberately never sent anywhere.
     */
    extraVariables: {
      carrier: String(input.order.shipping_carrier || ""),
      tracking_number: String(input.order.tracking_number || ""),
      fulfillment_method: input.method === "pickup" ? "collection" : "delivery",
      pickup_location: input.method === "pickup" ? pickupLocationText(input.settings) : "",
      pickup_instructions: input.method === "pickup" ? String(input.settings.pickup.instructions || "") : "",
      date: new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }),
    },
  });

  /**
   * Two states are also a cue for somebody else in the shop.
   *
   * `ready_to_fulfill` is the packing bench's signal and `ready_for_pickup` is
   * the counter's; both are routed to `fulfillment.view` rather than to
   * whoever moved the state, and both are keyed on the order and the state so a
   * repeat is silent. Nothing else in the graph earns an alert — announcing
   * "processing" to the people who just pressed Processing is noise.
   */
  if (input.to === "ready_to_fulfill" || input.to === "ready_for_pickup") {
    await raiseOperationalAlert({
      kind: input.to === "ready_to_fulfill" ? "order.ready_to_fulfill" : "order.ready_for_pickup",
      subjectId: input.order.id,
      actorUserId: input.actorUserId,
      message:
        input.to === "ready_to_fulfill"
          ? `${input.order.order_number || "An order"} is ready to pack.`
          : `${input.order.order_number || "An order"} is ready for the customer to collect.`,
    });
  }
}
