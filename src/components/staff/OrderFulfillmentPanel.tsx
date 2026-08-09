"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { Badge, EmptyState, Notice } from "@/components/ui/DesignSystem";
import {
  ConsequentialAction,
  resultFromResponse,
  type ActionResult,
} from "@/components/staff/ConsequentialAction";
import { coercePickupSnapshot, formatStoredAddressLines } from "@/lib/commerce/commerceSettings";
import { documentsForMethod } from "@/lib/staff/orderDocuments";

/**
 * The staff fulfillment control.
 *
 * Pass 8 shipped a complete, server-enforced fulfillment API and recorded "no
 * staff UI drives it yet" as the single highest-value next step. This is that
 * UI, and it drives the real endpoint rather than the legacy `shipment_action`
 * on `PATCH /api/staff/orders/[id]` — which set `shipped_at` and moved
 * `orders.status` but never touched `fulfillment_status`, so the column the
 * cancellation and return rules read stayed at "unfulfilled" forever and a
 * shipped order still looked cancellable.
 *
 * Three properties are worth stating, because each is load-bearing:
 *
 * 1. **The consequence is shown before it is chosen.** `GET` returns the legal
 *    transitions *and the email each would send*, so "Mark shipped" says which
 *    message the customer gets. The preview and the send come from one table
 *    server-side; they cannot disagree.
 * 2. **The staleness guard is honoured.** The state the page loaded with is
 *    sent back as `expectedStatus`; the route refuses a mismatch with 409 and a
 *    sentence, rather than overwriting somebody else's work.
 * 3. **Nothing here decides what is legal.** The buttons are what the server
 *    said were possible. Hiding a control is a convenience; the route is the
 *    control.
 */

type Transition = {
  to: string;
  staffLabel: string;
  customerLabel: string;
  emailTemplate: string | null;
  requiresTracking: boolean;
  blockedReason: string | null;
};

type FulfillmentPayload = {
  order: {
    id: string;
    orderNumber: string | null;
    orderStatus: string;
    outstandingBalanceCents: number;
    fulfillmentStatus: string;
    fulfillmentMethod: string;
    staffLabel: string;
    customerLabel: string;
    shippingCarrier: string | null;
    trackingNumber: string | null;
    customerTrackingUrl: string | null;
    shippedAt: string | null;
    deliveredAt: string | null;
    readyAt: string | null;
    pickedUpAt: string | null;
    fulfillmentNotes: string | null;
    customerShipmentNote: string | null;
    shippingAddress: Record<string, unknown> | null;
    shippingMethodSnapshot: Record<string, unknown> | null;
    pickupLocationSnapshot: Record<string, unknown> | null;
    shippingCents: number;
    updatedAt: string | null;
  };
  transitions: Transition[];
  carriers: { carrier: string; label: string }[];
  history: {
    id: number;
    from_status: string | null;
    to_status: string;
    actor_role: string | null;
    note: string | null;
    metadata: Record<string, unknown> | null;
    created_at: string;
  }[];
};

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What each customer email actually says, in one line, for the confirmation. */
const EMAIL_SUMMARY: Readonly<Record<string, string>> = {
  fulfillment_processing: "“We are getting your order ready.”",
  order_ready_for_pickup: "“Your order is ready to collect.”",
  order_picked_up: "“Your order was collected. Thank you.”",
  order_shipped: "“Your order has shipped”, with the tracking link.",
  order_delivered: "“Your order was marked delivered.”",
};

export function OrderFulfillmentPanel({
  orderId,
  canManage,
  onChanged,
}: {
  orderId: string;
  canManage: boolean;
  onChanged?: () => void;
}) {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [data, setData] = useState<FulfillmentPayload | null>(null);
  const [denied, setDenied] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [customerNote, setCustomerNote] = useState("");
  const [internalNote, setInternalNote] = useState("");

  const authHeaders = useCallback(async () => {
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  }, [supabase]);

  const load = useCallback(async () => {
    setLoading(true);
    const response = await fetch(`/api/staff/orders/${orderId}/fulfillment`, { headers: await authHeaders() });
    if (response.status === 403) {
      setDenied(true);
      setLoading(false);
      return;
    }
    if (!response.ok) {
      setError("Could not load fulfillment for this order.");
      setLoading(false);
      return;
    }
    const payload = (await response.json()) as FulfillmentPayload;
    setData(payload);
    // Seeded from the server on every load, so a correction starts from what is
    // actually stored rather than from whatever was last typed.
    setCarrier(payload.order.shippingCarrier ?? "");
    setTrackingNumber(payload.order.trackingNumber ?? "");
    setTrackingUrl("");
    setInternalNote(payload.order.fulfillmentNotes ?? "");
    setError("");
    setLoading(false);
  }, [authHeaders, orderId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  if (denied) {
    return (
      <section id="fulfillment" className="ui-card scroll-mt-5 lg:col-span-2">
        <p className="ui-eyebrow">Fulfillment</p>
        <h2 className="mt-1 text-xl font-semibold">Delivery is not visible to your account</h2>
        <p className="mt-2 text-sm text-brand-textMuted">
          Seeing shipping, pickup and tracking on an order needs the <code>fulfillment.view</code> permission.
        </p>
      </section>
    );
  }

  if (loading && !data) {
    return (
      <section id="fulfillment" className="ui-card scroll-mt-5 lg:col-span-2">
        <EmptyState>Loading fulfillment…</EmptyState>
      </section>
    );
  }

  if (!data) {
    return (
      <section id="fulfillment" className="ui-card scroll-mt-5 lg:col-span-2">
        <Notice tone="danger" role="alert">
          {error || "Could not load fulfillment for this order."}
        </Notice>
      </section>
    );
  }

  const order = data.order;
  const isPickup = order.fulfillmentMethod === "pickup";
  const hasShipped = Boolean(order.shippedAt);
  const addressLines = formatStoredAddressLines(order.shippingAddress);
  const pickup = coercePickupSnapshot(order.pickupLocationSnapshot);

  async function post(body: Record<string, unknown>): Promise<ActionResult> {
    setError("");
    setNotice("");
    const response = await fetch(`/api/staff/orders/${orderId}/fulfillment`, {
      method: "POST",
      headers: await authHeaders(),
      // The state the page was rendered from. A change that landed in between
      // is refused rather than overwritten.
      body: JSON.stringify({ expectedStatus: order.fulfillmentStatus, ...body }),
    });
    const payload = (await response.clone().json().catch(() => ({}))) as { already?: boolean };
    const result = await resultFromResponse(response, "Could not update fulfillment.");
    if (!result.ok) return result;
    setNotice(payload.already ? "That was already done — nothing was sent twice." : "Fulfillment updated.");
    setCustomerNote("");
    await load();
    onChanged?.();
    return result;
  }

  const transition = (option: Transition) =>
    post({
      action: "transition",
      to: option.to,
      carrier: carrier.trim() || undefined,
      trackingNumber: trackingNumber.trim() || undefined,
      trackingUrl: trackingUrl.trim() || undefined,
      customerNote: customerNote.trim() || undefined,
      internalNote,
    });

  const saveTracking = () =>
    post({
      action: "update_tracking",
      carrier: carrier.trim(),
      trackingNumber: trackingNumber.trim(),
      trackingUrl: trackingUrl.trim() || undefined,
    });

  return (
    <section id="fulfillment" className="ui-card scroll-mt-5 lg:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="ui-eyebrow">Fulfillment</p>
          <h2 className="mt-1 text-xl font-semibold">{order.staffLabel}</h2>
          <p className="mt-1 text-sm text-brand-textMuted">
            The customer sees <span className="text-brand-text">{order.customerLabel}</span>
            {order.updatedAt ? ` · updated ${new Date(order.updatedAt).toLocaleString()}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={isPickup ? "accent" : "neutral"}>{isPickup ? "Local pickup" : "Shipping"}</Badge>
          {order.shippingCents > 0 ? <Badge>{money(order.shippingCents)} delivery</Badge> : null}
          {order.outstandingBalanceCents > 0 ? (
            <Badge tone="warning">{money(order.outstandingBalanceCents)} outstanding</Badge>
          ) : null}
        </div>
      </div>

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      ) : null}
      {notice ? (
        <Notice tone="success" role="status" className="mt-4">
          {notice}
        </Notice>
      ) : null}

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-black/25 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">
            {isPickup ? "Collection" : "Destination"}
          </p>
          {isPickup ? (
            <div className="mt-2 text-sm">
              {order.pickupLocationSnapshot ? (
                <>
                  {/* `locationName`, which is the key the snapshot is actually
                      written with. Reading `name` here meant every pickup order
                      ever placed showed the literal words "Pickup location". */}
                  <p className="font-medium">{pickup?.locationName || "Pickup location"}</p>
                  {(pickup?.addressLines ?? formatStoredAddressLines(order.pickupLocationSnapshot)).map((line) => (
                    <p key={line} className="text-brand-textMuted">
                      {line}
                    </p>
                  ))}
                </>
              ) : (
                <p className="text-brand-textMuted">
                  No pickup location was snapshotted on this order. It predates local-pickup configuration.
                </p>
              )}
            </div>
          ) : addressLines.length ? (
            <div className="mt-2 text-sm">
              {addressLines.map((line) => (
                <p key={line} className={line === addressLines[0] ? "font-medium" : "text-brand-textMuted"}>
                  {line}
                </p>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-sm text-brand-textMuted">
              This order carries no shipping address. Custom-request orders collected an address at quoting; direct
              purchases before pass 8 did not.
            </p>
          )}
          {order.shippingMethodSnapshot ? (
            <p className="mt-3 text-xs text-brand-textMuted">
              Charged as {String(order.shippingMethodSnapshot.label ?? order.shippingMethodSnapshot.id ?? "a delivery method")}
              {order.shippingMethodSnapshot.freeApplied ? " (free shipping applied)" : ""}
            </p>
          ) : null}
        </div>

        <div className="rounded-xl border border-zinc-800 bg-black/25 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">Timeline</p>
          <dl className="mt-2 grid gap-2 text-sm">
            {[
              ["Ready", order.readyAt],
              ["Shipped", order.shippedAt],
              ["Collected", order.pickedUpAt],
              ["Delivered", order.deliveredAt],
            ]
              .filter(([, value]) => Boolean(value))
              .map(([label, value]) => (
                <div key={String(label)} className="flex items-center justify-between gap-3">
                  <dt className="text-brand-textMuted">{label}</dt>
                  <dd>{new Date(String(value)).toLocaleString()}</dd>
                </div>
              ))}
            {!order.readyAt && !order.shippedAt && !order.deliveredAt && !order.pickedUpAt ? (
              <p className="text-brand-textMuted">Nothing has happened yet.</p>
            ) : null}
          </dl>
          {order.customerTrackingUrl ? (
            <a
              href={order.customerTrackingUrl}
              target="_blank"
              rel="noreferrer"
              className="ui-btn ui-btn-ghost mt-3 text-sm"
            >
              Open tracking ↗
            </a>
          ) : null}
        </div>
      </div>

      {!isPickup && canManage ? (
        <div className="mt-4 rounded-xl border border-zinc-800 bg-black/25 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">Tracking</p>
          <p className="mt-1 text-xs text-brand-textMuted">
            A link is generated from the carrier’s configured template. Give a link only when the carrier is not
            configured; it must be https with no embedded credentials.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-sm">
              Carrier
              <input
                list="fulfillment-carriers"
                className="ui-input mt-1 w-full"
                value={carrier}
                onChange={(event) => setCarrier(event.target.value)}
                placeholder="USPS, UPS, FedEx…"
              />
              <datalist id="fulfillment-carriers">
                {data.carriers.map((option) => (
                  <option key={option.carrier} value={option.carrier}>
                    {option.label}
                  </option>
                ))}
              </datalist>
            </label>
            <label className="text-sm">
              Tracking number
              <input
                className="ui-input mt-1 w-full"
                value={trackingNumber}
                onChange={(event) => setTrackingNumber(event.target.value)}
              />
            </label>
            <label className="text-sm">
              Tracking link (optional)
              <input
                type="url"
                className="ui-input mt-1 w-full"
                value={trackingUrl}
                onChange={(event) => setTrackingUrl(event.target.value)}
                placeholder="https://…"
              />
            </label>
          </div>
          {hasShipped ? (
            <ConsequentialAction
              className="mt-3"
              label="Correct the tracking"
              title="Correct the tracking on this order?"
              summary="The parcel stays shipped. Changing a number the customer already has emails them the correction, so only do this when the old one was wrong."
              currentState={`${order.shippingCarrier ?? "—"} ${order.trackingNumber ?? ""}`.trim()}
              nextState={`${carrier.trim()} ${trackingNumber.trim()}`.trim()}
              confirmLabel="Save the correction"
              buttonClassName="!ui-btn-secondary"
              disabled={!carrier.trim() || !trackingNumber.trim()}
              disabledReason={
                !carrier.trim() || !trackingNumber.trim() ? "A carrier and a number are both required." : null
              }
              effects={{
                customer: "Their order page shows the new tracking link.",
                financial: null,
                inventory: null,
                notification: "“Tracking updated”, naming the new number — only if it actually changed.",
              }}
              onConfirm={() => saveTracking()}
            />
          ) : (
            <p className="mt-3 text-xs text-brand-textMuted">
              These are saved with the order when you mark it shipped.
            </p>
          )}
        </div>
      ) : null}

      {canManage ? (
        <div className="mt-4 rounded-xl border border-brand-primary/30 bg-brand-primary/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-brand-primary">Move this order on</p>
          {data.transitions.length ? (
            <>
              <div className="mt-3 grid gap-3">
                <label className="text-sm">
                  Note to the customer (optional)
                  <textarea
                    className="ui-input mt-1 min-h-16 w-full"
                    maxLength={1000}
                    value={customerNote}
                    onChange={(event) => setCustomerNote(event.target.value)}
                    placeholder="Anything they should know — collection hours, a substitution, a delay…"
                  />
                  <span className="mt-1 block text-xs text-brand-textMuted">
                    Included in the email for this step. Internal notes below are never sent.
                  </span>
                </label>
                <label className="text-sm">
                  Internal fulfillment notes
                  <textarea
                    className="ui-input mt-1 min-h-16 w-full"
                    maxLength={2000}
                    value={internalNote}
                    onChange={(event) => setInternalNote(event.target.value)}
                    placeholder="Packaging, box size, who packed it…"
                  />
                </label>
              </div>
              {/*
                One dialog per legal transition, built from what the server said
                is legal. The email line is read from the same table the route
                sends from, so the preview and the send cannot disagree.
              */}
              <div className="ui-action-row mt-4">
                {data.transitions.map((option) => {
                  const missingTracking =
                    option.requiresTracking && (!carrier.trim() || !trackingNumber.trim());
                  const email = option.emailTemplate
                    ? EMAIL_SUMMARY[option.emailTemplate] ?? "a customer email"
                    : null;
                  return (
                    <ConsequentialAction
                      key={option.to}
                      label={option.staffLabel}
                      title={`Move this order to “${option.staffLabel}”?`}
                      summary={
                        option.requiresTracking
                          ? "The parcel is handed over. The customer gets the tracking number below, so check it is the right one."
                          : "This moves the order on and is recorded in the fulfillment history."
                      }
                      currentState={order.staffLabel}
                      nextState={option.staffLabel}
                      tone={option.to === "canceled" ? "danger" : "default"}
                      confirmLabel={option.staffLabel}
                      disabled={Boolean(option.blockedReason) || missingTracking}
                      disabledReason={
                        option.blockedReason
                          ? option.blockedReason
                          : missingTracking
                            ? "Add a carrier and tracking number first."
                            : email
                              ? "Emails the customer"
                              : "No email"
                      }
                      effects={{
                        customer: `Their order reads “${option.customerLabel}”.`,
                        financial: null,
                        inventory: null,
                        notification: email,
                      }}
                      notificationPreview={
                        option.requiresTracking
                          ? `${carrier.trim()} ${trackingNumber.trim()}${customerNote.trim() ? `\n\n${customerNote.trim()}` : ""}`
                          : customerNote.trim() || undefined
                      }
                      onConfirm={() => transition(option)}
                    />
                  );
                })}
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-brand-textMuted">
              Fulfillment is finished for this order. Corrections are made by editing the details above, which is
              recorded, rather than by moving the state backwards.
            </p>
          )}
        </div>
      ) : null}

      <details className="mt-4">
        <summary className="cursor-pointer text-sm font-semibold">Fulfillment history ({data.history.length})</summary>
        <div className="mt-3 space-y-2">
          {data.history.map((event) => (
            <div key={event.id} className="border-l-2 border-brand-accent/50 pl-4">
              <p className="text-sm font-medium">
                {event.from_status === event.to_status
                  ? event.note || "Details updated"
                  : `${event.from_status ?? "—"} → ${event.to_status}`}
              </p>
              <p className="text-[11px] text-brand-textMuted">
                {new Date(event.created_at).toLocaleString()}
                {event.actor_role ? ` · ${event.actor_role}` : ""}
              </p>
              {event.note && event.from_status !== event.to_status ? (
                <p className="mt-1 text-xs text-brand-textMuted">{event.note}</p>
              ) : null}
            </div>
          ))}
          {!data.history.length ? <EmptyState>No fulfillment events recorded yet.</EmptyState> : null}
        </div>
      </details>

      {/* Which documents exist and which apply to this delivery method come from
          `orderDocuments.ts`, the same module the print route validates against,
          so this cannot offer a sheet the route would 404. */}
      <div className="ui-action-row mt-4">
        {documentsForMethod(order.fulfillmentMethod).map((document) => (
          <a
            key={document.slug}
            href={`/staff/orders/${orderId}/print/${document.slug}`}
            target="_blank"
            rel="noreferrer"
            className="ui-btn ui-btn-ghost text-sm"
            title={document.purpose}
          >
            {document.title} ↗
          </a>
        ))}
      </div>
    </section>
  );
}
