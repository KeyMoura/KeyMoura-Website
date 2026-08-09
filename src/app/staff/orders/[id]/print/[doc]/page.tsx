import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/AccessDenied";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getServerActorAccess } from "@/lib/staff/serverAccess";
import { formatPickupLocationLines, formatStoredAddressLines } from "@/lib/commerce/commerceSettings";
import { FULFILLMENT_STAFF_LABELS, lifecycleLabel } from "@/lib/commerce/orderLifecycle";
import {
  ORDER_DOCUMENT_META,
  formatCents,
  invoiceLines,
  isOrderDocument,
  type OrderDocument,
} from "@/lib/staff/orderDocuments";

/**
 * Printable order documents: packing slip, pickup slip, invoice, refund record.
 *
 * Server-rendered, like the production traveller and for the same reason —
 * Ctrl+P on a half-hydrated page is a blank sheet. The global print stylesheet
 * from pass 5 already drops the header, footer, nav and staff sidebar, and this
 * page uses none of those elements itself.
 *
 * **Three of the four sheets physically reach a customer.** `reachesCustomer`
 * in `orderDocuments.ts` is what decides whether internal notes, staff notes
 * and cost detail may appear, and the renderer below reads that flag rather
 * than relying on each template remembering. A packing slip carrying the
 * internal note "customer disputed the last one, watch this" is a real way to
 * lose a customer, and it should not depend on a template author's care.
 *
 * Gated on `fulfillment.view`, plus `orders.view` for the money sheets — an
 * invoice is order data, not delivery data.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string; doc: string }> };

type OrderRow = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  quantity: number;
  status: string;
  order_kind: string | null;
  payment_status: string;
  fulfillment_status: string | null;
  fulfillment_method: string | null;
  specifications: Record<string, unknown> | null;
  customer_notes: string | null;
  staff_notes: string | null;
  fulfillment_notes: string | null;
  customer_shipment_note: string | null;
  shipping_address: Record<string, unknown> | null;
  shipping_origin_snapshot: Record<string, unknown> | null;
  pickup_location_snapshot: Record<string, unknown> | null;
  shipping_method_snapshot: Record<string, unknown> | null;
  package_snapshot: Record<string, unknown> | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  subtotal_cents: number | null;
  discount_cents: number | null;
  discount_code: string | null;
  shipping_cents: number | null;
  tax_cents: number | null;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
  created_at: string;
  paid_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  picked_up_at: string | null;
};

type ItemRow = {
  id: string;
  product_name: string;
  quantity: number;
  unit_price_cents: number;
  selected_options: Record<string, unknown> | null;
};

type RefundRow = {
  id: string;
  amount_cents: number;
  reason: string | null;
  status: string | null;
  stripe_refund_id: string | null;
  created_at: string;
};

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9pt] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-[11pt]">{value || "—"}</div>
    </div>
  );
}

function InternalStamp() {
  return (
    <div className="mb-3 border-2 border-black px-2 py-1 text-[10pt] font-bold uppercase tracking-widest">
      Internal document — not for the customer
    </div>
  );
}

function WriteIn({ label }: { label: string }) {
  return (
    <div className="mt-6">
      <div className="text-[9pt] uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-6 border-b border-black" />
    </div>
  );
}

/**
 * `kind` because these documents render two genuinely different stored shapes.
 * A pickup snapshot is a location name plus pre-formatted lines and shares no
 * field names with an address; reading one as the other produced nothing at
 * best and threw at worst.
 */
function AddressBlock({
  heading,
  address,
  kind = "address",
}: {
  heading: string;
  address: Record<string, unknown> | null;
  kind?: "address" | "pickup";
}) {
  const lines = kind === "pickup" ? formatPickupLocationLines(address) : formatStoredAddressLines(address);
  return (
    <div>
      <div className="text-[9pt] uppercase tracking-wide opacity-70">{heading}</div>
      {lines.length ? (
        lines.map((line, index) => (
          <div key={line} className={index === 0 ? "text-[11pt] font-semibold" : "text-[11pt]"}>
            {line}
          </div>
        ))
      ) : (
        <div className="text-[11pt]">Not recorded on this order</div>
      )}
    </div>
  );
}

/** Option choices, flattened for a sheet that has no room for a table. */
function describeOptions(selected: Record<string, unknown> | null): string {
  if (!selected || typeof selected !== "object") return "";
  return Object.entries(selected)
    .map(([key, raw]) => {
      const value =
        raw && typeof raw === "object"
          ? String((raw as { label?: unknown; value?: unknown }).label ?? (raw as { value?: unknown }).value ?? "")
          : String(raw ?? "");
      return value ? `${key.replaceAll("_", " ")}: ${value}` : "";
    })
    .filter(Boolean)
    .join(" · ");
}

export default async function PrintableOrderDocument({ params }: Params) {
  const { id, doc } = await params;
  if (!isOrderDocument(doc)) notFound();
  const meta = ORDER_DOCUMENT_META[doc as OrderDocument];

  const actor = await getServerActorAccess();
  const canFulfill = Boolean(
    actor && (actor.permissions.has("fulfillment.view") || actor.permissions.has("fulfillment.manage"))
  );
  const canSeeOrders = Boolean(
    actor && (actor.permissions.has("orders.view") || actor.permissions.has("orders.manage"))
  );
  const needsOrderAccess = doc === "invoice" || doc === "refund-record";
  const allowed = needsOrderAccess ? canSeeOrders : canFulfill;

  if (!allowed) {
    return (
      <div className="page-container">
        <AccessDenied
          title="This document is restricted"
          description={
            needsOrderAccess
              ? "Printing an order’s money documents needs the order access permission."
              : "Printing a delivery document needs the fulfillment access permission."
          }
          backHref="/staff"
          backLabel="Back to Staff"
        />
      </div>
    );
  }

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select(
      "id,order_number,customer_id,product_name,quantity,status,order_kind,payment_status,fulfillment_status," +
        "fulfillment_method,specifications,customer_notes,staff_notes,fulfillment_notes,customer_shipment_note," +
        "shipping_address,shipping_origin_snapshot,pickup_location_snapshot,shipping_method_snapshot," +
        "package_snapshot,shipping_carrier,tracking_number,subtotal_cents,discount_cents,discount_code," +
        "shipping_cents,tax_cents,agreed_price_cents,amount_paid_cents,amount_refunded_cents,created_at," +
        "paid_at,shipped_at,delivered_at,picked_up_at"
    )
    .eq("id", id)
    .maybeSingle<OrderRow>();

  if (!order) notFound();

  const [{ data: items }, { data: customer }, { data: refunds }] = await Promise.all([
    supabaseAdmin
      .from("order_items")
      .select("id,product_name,quantity,unit_price_cents,selected_options")
      .eq("order_id", id)
      .returns<ItemRow[]>(),
    supabaseAdmin.from("profiles").select("display_name,username").eq("id", order.customer_id).maybeSingle<{
      display_name: string | null;
      username: string | null;
    }>(),
    doc === "refund-record"
      ? supabaseAdmin
          .from("order_refunds")
          .select("id,amount_cents,reason,status,stripe_refund_id,created_at")
          .eq("order_id", id)
          .order("created_at", { ascending: false })
          .returns<RefundRow[]>()
      : Promise.resolve({ data: [] as RefundRow[] }),
  ]);

  const customerName = customer?.display_name || (customer?.username ? `@${customer.username}` : "Customer");
  const reference = order.order_number || order.id.slice(0, 8).toUpperCase();
  const isPickup = String(order.fulfillment_method || "shipping") === "pickup";

  /*
   * A custom request never writes `order_items`, so the order row itself is the
   * single line. Falling back like this keeps one renderer for both order kinds
   * instead of a branch per sheet.
   */
  const lines: ItemRow[] = items?.length
    ? items
    : [
        {
          id: order.id,
          product_name: order.product_name,
          quantity: order.quantity,
          unit_price_cents:
            order.agreed_price_cents != null && order.quantity > 0
              ? Math.round(order.agreed_price_cents / order.quantity)
              : 0,
          selected_options: order.specifications,
        },
      ];

  const shipFrom = order.shipping_origin_snapshot ?? null;

  return (
    <div className="print-document page-container space-y-6 py-6">
      <div className="print-hidden flex flex-wrap items-center justify-between gap-3">
        <Link href={`/staff/orders/${id}`} className="text-sm underline">
          ← Back to the order
        </Link>
        <p className="text-sm opacity-70">
          Use your browser’s print command. Navigation, footer and the staff sidebar are dropped on paper.
        </p>
      </div>

      <section className="print-block space-y-4 p-4">
        {!meta.reachesCustomer ? <InternalStamp /> : null}

        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-black pb-2">
          <div>
            <div className="text-[9pt] uppercase tracking-widest">{meta.title}</div>
            <div className="text-[20pt] font-bold leading-tight">{reference}</div>
          </div>
          <div className="text-right">
            <div className="text-[14pt] font-semibold">KeyMoura</div>
            <div className="text-[10pt]">{new Date().toLocaleDateString()}</div>
          </div>
        </div>
        <p className="text-[10pt] opacity-70">{meta.purpose}</p>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Order placed" value={new Date(order.created_at).toLocaleDateString()} />
          <Field label="Customer" value={customerName} />
          <Field
            label="Delivery"
            value={`${isPickup ? "Local pickup" : "Shipping"} · ${lifecycleLabel(
              FULFILLMENT_STAFF_LABELS,
              String(order.fulfillment_status || "unfulfilled")
            )}`}
          />
          <Field label="Payment" value={order.payment_status.replaceAll("_", " ")} />
        </div>

        {/* ----------------------------------------------------------------- */}
        {/* Packing slip                                                       */}
        {/* ----------------------------------------------------------------- */}
        {doc === "packing-slip" ? (
          <>
            <div className="grid gap-4 border-t border-black pt-3 sm:grid-cols-2">
              <AddressBlock heading="Ship to" address={order.shipping_address} />
              <AddressBlock heading="Ship from" address={shipFrom} />
            </div>
            <ItemTable lines={lines} showPrices={false} />
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Carrier" value={order.shipping_carrier} />
              <Field label="Tracking" value={order.tracking_number} />
              <Field
                label="Package"
                value={
                  order.package_snapshot
                    ? String(order.package_snapshot.label ?? order.package_snapshot.name ?? "Default")
                    : null
                }
              />
              <Field label="Items" value={String(lines.reduce((sum, line) => sum + line.quantity, 0))} />
            </div>
            {order.customer_shipment_note ? (
              <div className="border border-black p-2">
                <div className="text-[9pt] uppercase tracking-wide opacity-70">Note to the customer</div>
                <p className="text-[11pt] whitespace-pre-wrap">{order.customer_shipment_note}</p>
              </div>
            ) : null}
            <WriteIn label="Packed by / date" />
          </>
        ) : null}

        {/* ----------------------------------------------------------------- */}
        {/* Pickup slip                                                        */}
        {/* ----------------------------------------------------------------- */}
        {doc === "pickup-slip" ? (
          <>
            <div className="grid gap-4 border-t border-black pt-3 sm:grid-cols-2">
              <AddressBlock heading="Collect from" address={order.pickup_location_snapshot} kind="pickup" />
              <div>
                <div className="text-[9pt] uppercase tracking-wide opacity-70">Collected by</div>
                <div className="text-[11pt] font-semibold">{customerName}</div>
                {order.pickup_location_snapshot?.instructions ? (
                  <p className="mt-1 text-[10pt]">{String(order.pickup_location_snapshot.instructions)}</p>
                ) : null}
              </div>
            </div>
            <ItemTable lines={lines} showPrices={false} />
            {order.customer_shipment_note ? (
              <div className="border border-black p-2">
                <div className="text-[9pt] uppercase tracking-wide opacity-70">Note to the customer</div>
                <p className="text-[11pt] whitespace-pre-wrap">{order.customer_shipment_note}</p>
              </div>
            ) : null}
            <div className="grid gap-6 sm:grid-cols-2">
              <WriteIn label="Customer signature" />
              <WriteIn label="Handed over by / date" />
            </div>
          </>
        ) : null}

        {/* ----------------------------------------------------------------- */}
        {/* Invoice                                                            */}
        {/* ----------------------------------------------------------------- */}
        {doc === "invoice" ? (
          <>
            <div className="grid gap-4 border-t border-black pt-3 sm:grid-cols-2">
              <AddressBlock
                heading={isPickup ? "Collect from" : "Ship to"}
                address={isPickup ? order.pickup_location_snapshot : order.shipping_address}
                kind={isPickup ? "pickup" : "address"}
              />
              <div>
                <div className="text-[9pt] uppercase tracking-wide opacity-70">Billed to</div>
                <div className="text-[11pt] font-semibold">{customerName}</div>
                {order.discount_code ? <div className="text-[10pt]">Code applied: {order.discount_code}</div> : null}
                {order.paid_at ? (
                  <div className="text-[10pt]">Paid {new Date(order.paid_at).toLocaleDateString()}</div>
                ) : null}
              </div>
            </div>
            <ItemTable lines={lines} showPrices />
            <table className="w-full text-[11pt]">
              <tbody>
                {invoiceLines(order).map((line) => (
                  <tr key={line.label} className={line.emphasis ? "border-t border-black font-semibold" : ""}>
                    <td className="py-1">{line.label}</td>
                    <td className="py-1 text-right tabular-nums">{formatCents(line.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[9pt] opacity-70">
              The order total is the amount the customer agreed to and was charged. The lines above break it down
              where a breakdown was recorded; a quoted custom order records one figure.
            </p>
          </>
        ) : null}

        {/* ----------------------------------------------------------------- */}
        {/* Refund record — internal                                           */}
        {/* ----------------------------------------------------------------- */}
        {doc === "refund-record" ? (
          <>
            <div className="grid grid-cols-2 gap-3 border-t border-black pt-3 sm:grid-cols-4">
              <Field label="Order total" value={formatCents(order.agreed_price_cents ?? 0)} />
              <Field label="Collected" value={formatCents(order.amount_paid_cents)} />
              <Field label="Refunded" value={formatCents(order.amount_refunded_cents ?? 0)} />
              <Field
                label="Net"
                value={formatCents((order.amount_paid_cents || 0) - (order.amount_refunded_cents || 0))}
              />
            </div>
            <table className="w-full text-[10pt]">
              <thead>
                <tr className="border-b border-black text-left">
                  <th className="py-1">Date</th>
                  <th className="py-1">Amount</th>
                  <th className="py-1">State</th>
                  <th className="py-1">Reason</th>
                  <th className="py-1">Stripe reference</th>
                </tr>
              </thead>
              <tbody>
                {(refunds ?? []).map((refund) => (
                  <tr key={refund.id} className="border-b border-black/30 align-top">
                    <td className="py-1">{new Date(refund.created_at).toLocaleDateString()}</td>
                    <td className="py-1 tabular-nums">{formatCents(refund.amount_cents)}</td>
                    <td className="py-1">{refund.status ?? "—"}</td>
                    <td className="py-1">{refund.reason ?? "—"}</td>
                    <td className="py-1 break-all">{refund.stripe_refund_id ?? "—"}</td>
                  </tr>
                ))}
                {!refunds?.length ? (
                  <tr>
                    <td colSpan={5} className="py-3">
                      No refunds have been issued on this order.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
            {order.staff_notes || order.fulfillment_notes ? (
              <div className="border border-black p-2">
                <div className="text-[9pt] uppercase tracking-wide opacity-70">Internal notes</div>
                {order.staff_notes ? <p className="text-[10pt] whitespace-pre-wrap">{order.staff_notes}</p> : null}
                {order.fulfillment_notes ? (
                  <p className="mt-1 text-[10pt] whitespace-pre-wrap">{order.fulfillment_notes}</p>
                ) : null}
              </div>
            ) : null}
            <WriteIn label="Reconciled by / date" />
          </>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The item table.
 *
 * `showPrices` is off on the delivery sheets. A packing slip with prices on it
 * is a receipt in the box, which is exactly what a gift order must not contain.
 */
function ItemTable({ lines, showPrices }: { lines: ItemRow[]; showPrices: boolean }) {
  return (
    <table className="w-full border-t border-black text-[11pt]">
      <thead>
        <tr className="text-left">
          <th className="py-1">Item</th>
          <th className="w-16 py-1 text-right">Qty</th>
          {showPrices ? <th className="w-28 py-1 text-right">Each</th> : null}
          {showPrices ? <th className="w-28 py-1 text-right">Total</th> : null}
        </tr>
      </thead>
      <tbody>
        {lines.map((line) => {
          const options = describeOptions(line.selected_options);
          return (
            <tr key={line.id} className="border-t border-black/30 align-top">
              <td className="py-1">
                <div className="font-medium">{line.product_name}</div>
                {options ? <div className="text-[9pt] opacity-70">{options}</div> : null}
              </td>
              <td className="py-1 text-right tabular-nums">{line.quantity}</td>
              {showPrices ? (
                <td className="py-1 text-right tabular-nums">{formatCents(line.unit_price_cents)}</td>
              ) : null}
              {showPrices ? (
                <td className="py-1 text-right tabular-nums">
                  {formatCents(line.unit_price_cents * line.quantity)}
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
