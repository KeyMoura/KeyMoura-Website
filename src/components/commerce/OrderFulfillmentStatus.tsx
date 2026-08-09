"use client";

import {
  coercePickupSnapshot,
  formatPickupLocationLines,
  formatStoredAddressLines,
} from "@/lib/commerce/commerceSettings";
import { FULFILLMENT_LABELS, lifecycleLabel, type FulfillmentState } from "@/lib/commerce/orderLifecycle";
import { cx } from "@/components/ui/DesignSystem";

/**
 * What the customer sees about getting their order.
 *
 * The old block appeared only when `fulfillment_method === "pickup"` or a
 * tracking number existed, and described the state by inspecting timestamps —
 * so a shipping order that was being packed showed nothing at all, and every
 * direct purchase (which never sets those timestamps until it ships) had no
 * delivery section whatever.
 *
 * This reads `fulfillment_status`, the field staff actually move, and renders
 * from `FULFILLMENT_LABELS` — the same table the fulfillment emails are titled
 * from, so the page and the email cannot describe the same state differently.
 *
 * Deliberately **not** a second progress stepper. The page already has one for
 * the order as a whole; two steppers disagreeing about which step you are on is
 * worse than one. This is a state, a timeline of what has happened, and the one
 * action a customer can take — following the parcel.
 */

type FulfillmentOrder = {
  fulfillment_status: string | null;
  fulfillment_method: string | null;
  shipping_address: Record<string, unknown> | null;
  pickup_location_snapshot: Record<string, unknown> | null;
  shipping_method_snapshot: Record<string, unknown> | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  customer_shipment_note: string | null;
  shipping_cents: number | null;
  ready_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  picked_up_at: string | null;
};

/** The sentence under the heading, per state and method. */
function explain(state: string, isPickup: boolean): string {
  switch (state) {
    case "not_required":
      return "Nothing needs to be delivered for this order.";
    case "unfulfilled":
      return isPickup
        ? "We will let you know as soon as it is ready to collect."
        : "We will let you know as soon as it is on its way.";
    case "processing":
      return "We are getting your order ready now.";
    case "ready_to_fulfill":
      return "Your order is packed and waiting to go out.";
    case "ready_for_pickup":
      return "Your order is ready to collect. Bring your order number.";
    case "picked_up":
      return "You collected this order. Thank you.";
    case "shipped":
      return "Your order is on its way.";
    case "delivered":
      return "Your order was marked delivered.";
    case "returned":
      return "This order was returned.";
    case "partially_returned":
      return "Part of this order was returned.";
    case "canceled":
      return "Delivery was cancelled with the order.";
    default:
      return "";
  }
}

const TIMELINE: readonly { state: FulfillmentState; label: string; field: keyof FulfillmentOrder }[] = [
  { state: "ready_for_pickup", label: "Ready", field: "ready_at" },
  { state: "shipped", label: "Shipped", field: "shipped_at" },
  { state: "picked_up", label: "Collected", field: "picked_up_at" },
  { state: "delivered", label: "Delivered", field: "delivered_at" },
];

export function OrderFulfillmentStatus({ order }: { order: FulfillmentOrder }) {
  const state = String(order.fulfillment_status || "unfulfilled");
  // Nothing to say about an order whose delivery was cancelled along with it —
  // the cancellation notice above already covers that, and repeating it here
  // reads as a second, separate problem.
  if (state === "canceled" || state === "not_required") return null;

  const isPickup = String(order.fulfillment_method || "shipping") === "pickup";
  const heading = lifecycleLabel(FULFILLMENT_LABELS, state);
  const detail = explain(state, isPickup);
  const events = TIMELINE.filter((entry) => Boolean(order[entry.field]));
  // Two different stored shapes, read by two different readers. A pickup
  // snapshot is a location name plus formatted lines; a shipping address is an
  // address, in whichever key naming the order was written with.
  const pickup = coercePickupSnapshot(order.pickup_location_snapshot);
  const addressLines = isPickup
    ? formatPickupLocationLines(order.pickup_location_snapshot)
    : formatStoredAddressLines(order.shipping_address);
  const trackingUrl = order.tracking_url;

  return (
    <section className="ui-card" aria-labelledby="order-fulfillment-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="ui-eyebrow">{isPickup ? "Collection" : "Delivery"}</p>
          <h2 id="order-fulfillment-heading" className="mt-1 text-xl font-semibold">
            {heading}
          </h2>
          {detail ? <p className="mt-1 text-sm text-brand-textMuted">{detail}</p> : null}
        </div>
        {trackingUrl ? (
          <a className="ui-btn ui-btn-primary" href={trackingUrl} target="_blank" rel="noreferrer">
            Track your parcel ↗
          </a>
        ) : null}
      </div>

      {order.customer_shipment_note ? (
        <p className="mt-4 rounded-xl border border-brand-primary/30 bg-brand-primary/5 p-3 text-sm whitespace-pre-wrap">
          {order.customer_shipment_note}
        </p>
      ) : null}

      <div className="mt-5 grid gap-5 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">
            {isPickup ? "Collect from" : "Delivering to"}
          </h3>
          {addressLines.length ? (
            <div className="mt-2 text-sm">
              {addressLines.map((line, index) => (
                <p key={line} className={index === 0 ? "font-medium" : "text-brand-textMuted"}>
                  {line}
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-brand-textMuted">
              {isPickup
                ? "We will confirm the collection address with you."
                : "We will confirm the delivery address with you."}
            </p>
          )}
          {isPickup && pickup?.instructions ? (
            <p className="mt-2 text-sm text-brand-textMuted">{pickup.instructions}</p>
          ) : null}
          {isPickup && pickup?.hoursText ? (
            <p className="mt-1 text-sm text-brand-textMuted">Hours: {pickup.hoursText}</p>
          ) : null}
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">Progress</h3>
          {events.length ? (
            <ol className="mt-2 space-y-2">
              {events.map((event) => (
                <li key={event.state} className="border-l-2 border-brand-primary/60 pl-3">
                  <p className="text-sm font-medium">{event.label}</p>
                  <time className="text-xs text-brand-textMuted">
                    {new Date(String(order[event.field])).toLocaleString()}
                  </time>
                </li>
              ))}
            </ol>
          ) : (
            <p className="mt-2 text-sm text-brand-textMuted">Nothing has left the workshop yet.</p>
          )}

          {order.tracking_number ? (
            <dl className="mt-4 grid gap-1 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-brand-textMuted">Carrier</dt>
                <dd>{order.shipping_carrier || "Carrier"}</dd>
              </div>
              <div className="flex flex-wrap justify-between gap-2">
                <dt className="text-brand-textMuted">Tracking number</dt>
                <dd className="break-all">{order.tracking_number}</dd>
              </div>
            </dl>
          ) : null}

          {order.shipping_method_snapshot ? (
            <p className={cx("mt-3 text-xs text-brand-textMuted")}>
              {/* `name` is the key `planFulfillment` actually writes. Reading
                  only `label` meant every shipped order described its delivery
                  method as the literal word "Delivery". */}
              {String(order.shipping_method_snapshot.label ?? order.shipping_method_snapshot.name ?? "Delivery")}
              {Number(order.shipping_cents ?? 0) > 0
                ? ` · $${(Number(order.shipping_cents) / 100).toFixed(2)}`
                : " · free"}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
