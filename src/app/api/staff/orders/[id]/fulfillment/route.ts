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
} from "@/lib/commerce/orderLifecycleServer";
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
  formatAddressLines,
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
  "id,order_number,customer_id,product_name,status,payment_status,fulfillment_status,fulfillment_method," +
  "shipping_address,shipping_carrier,tracking_number,tracking_url,shipped_at,delivered_at,ready_at," +
  "picked_up_at,ready_to_fulfill_at,pickup_confirmed_at,fulfillment_notes,customer_shipment_note," +
  "pickup_location_snapshot,shipping_method_snapshot,shipping_cents,fulfillment_updated_at,amount_paid_cents," +
  "amount_refunded_cents,agreed_price_cents";

type OrderRow = {
  id: string;
  customer_id: string;
  product_name: string;
  order_number: string | null;
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

  const transitions = fulfillmentTransitionsFor(from, method).map((to) => ({
    to,
    staffLabel: FULFILLMENT_STAFF_LABELS[to],
    customerLabel: FULFILLMENT_LABELS[to],
    // Exactly what the customer will be sent, surfaced before confirming.
    emailTemplate: FULFILLMENT_CUSTOMER_EMAIL[to] ?? null,
    requiresTracking: to === "shipped" && method === "shipping",
  }));

  return NextResponse.json({
    order: {
      id: order.id,
      orderNumber: order.order_number,
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
      order: input.order as unknown as { customer_id: string; product_name: string; order_number: string | null },
      actorUserId: input.actorUserId,
      templateKey: "tracking_corrected",
      eventKey: `tracking-corrected-${input.order.id}-${number}`,
      title: "Tracking updated",
      message: `The tracking details for your order have been corrected. The new number is ${number}.`,
      detail: "",
      price: "",
    });
  }

  return NextResponse.json({ ok: true, corrected: isCorrection });
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
  const pickup = input.order.pickup_location_snapshot as Record<string, unknown> | null;

  const messages: Partial<Record<FulfillmentState, string>> = {
    processing: "We are getting your order ready. We will let you know as soon as it is on its way.",
    ready_for_pickup: "Your order is ready to collect.",
    picked_up: "Your order was collected. Thank you.",
    shipped: tracking ? "Your order has shipped. The tracking link is on your order page." : "Your order has shipped.",
    delivered: "Your order was marked delivered.",
  };

  await sendLifecycleNotification({
    orderId: input.order.id,
    order: input.order as unknown as { customer_id: string; product_name: string; order_number: string | null },
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
  });
}
