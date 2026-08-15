import Link from "next/link";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { OrderFulfillmentStatus } from "@/components/commerce/OrderFulfillmentStatus";
import { customerOrderProgress, customerOrderStatus, customerPaymentSummary } from "@/lib/commerce/customerOrderView";
import { moneyFromCents, orderNeedsCustomerAction, orderNextStep } from "@/lib/orderHub";

export type CustomerOrderOverviewOrder = {
  id: string; order_number: string | null; product_name: string; status: string; payment_status: string;
  created_at: string; agreed_price_cents: number | null; subtotal_cents?: number | null; discount_cents?: number | null;
  shipping_cents?: number | null; tax_cents?: number | null; amount_paid_cents?: number | null; amount_refunded_cents?: number | null;
  fulfillment_method?: string | null; fulfillment_status?: string | null; shipping_address?: Record<string, unknown> | null;
  pickup_location_snapshot?: Record<string, unknown> | null; shipping_method_snapshot?: Record<string, unknown> | null;
  customer_shipment_note?: string | null; shipping_carrier?: string | null; tracking_number?: string | null; tracking_url?: string | null;
  ready_at?: string | null; shipped_at?: string | null; delivered_at?: string | null; picked_up_at?: string | null;
  quote_accepted_at?: string | null;
};
export type CustomerOrderOverviewItem = {
  id?: string; product_name: string; product_slug?: string | null; quantity: number; unit_price_cents?: number | null;
  line_subtotal_cents?: number | null; selected_options?: Record<string, unknown> | null;
};

const money = (value: number | null | undefined) => value == null ? "—" : moneyFromCents(value);
const date = (value: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));

export function CustomerOrderOverview({ order, items, paymentAvailable = true, action }: {
  order: CustomerOrderOverviewOrder; items: CustomerOrderOverviewItem[]; paymentAvailable?: boolean; action?: React.ReactNode;
}) {
  const progress = customerOrderProgress(order);
  const payment = customerPaymentSummary(order);
  const needsAction = orderNeedsCustomerAction(order);
  const nextStepOrder = { ...order, fulfillment_method: order.fulfillment_method === "pickup" ? "pickup" as const : "shipping" as const };
  return <>
    <header className="ui-card overflow-hidden !border-brand-primary/30 bg-gradient-to-br from-brand-primary/10 to-transparent" aria-labelledby="order-title">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0"><p className="ui-eyebrow">Order</p><h1 id="order-title" className="mt-1 break-words text-3xl font-semibold tracking-tight md:text-4xl">{order.order_number || "Order pending"}</h1><p className="mt-2 text-sm text-brand-textMuted">Placed {date(order.created_at)}</p></div>
        <div className="sm:text-right"><p className="text-xl font-semibold text-brand-primary">{customerOrderStatus(order)}</p><p className="mt-1 text-2xl font-semibold">{money(order.agreed_price_cents)}</p></div>
      </div>
      {action ? <div className="mt-5">{action}</div> : null}
    </header>

    {needsAction ? <section className="ui-card !border-brand-primary/50 !bg-brand-primary/10" aria-labelledby="attention-heading"><p className="ui-eyebrow">Needs your attention</p><h2 id="attention-heading" className="mt-2 text-xl font-semibold">{orderNextStep(nextStepOrder)}</h2><a href="#customer-action" className="ui-btn ui-btn-primary mt-4">Take action</a></section> : null}

    <section className="ui-card" aria-labelledby="progress-heading"><h2 id="progress-heading" className="text-xl font-semibold">Order progress</h2><ol className="mt-5 grid gap-0" aria-label="Order progress">
      {progress.map((stage, index) => <li key={stage.key} aria-current={stage.state === "current" ? "step" : undefined} className="relative grid min-w-0 grid-cols-[1.5rem_1fr] gap-3 pb-5 last:pb-0">
        {index < progress.length - 1 ? <span aria-hidden className="absolute left-[.7rem] top-5 h-[calc(100%-0.25rem)] w-px bg-brand-border" /> : null}
        <span aria-hidden className={`relative z-10 mt-0.5 flex h-6 w-6 items-center justify-center rounded-full border text-xs ${stage.state === "complete" ? "border-emerald-400 bg-emerald-400/15 text-emerald-300" : stage.state === "current" ? "border-brand-primary bg-brand-primary/15 text-brand-primary" : "border-brand-border text-brand-textMuted"}`}>{stage.state === "complete" ? "✓" : stage.state === "current" ? "●" : "○"}</span>
        <div className="min-w-0"><p className={stage.state === "current" ? "font-semibold" : "font-medium"}>{stage.label}{stage.state === "current" ? <span className="sr-only"> (current stage)</span> : null}</p>{stage.at ? <time className="text-xs text-brand-textMuted" dateTime={stage.at}>{date(stage.at)}</time> : null}</div>
      </li>)}</ol></section>

    <section className="ui-card" aria-labelledby="items-heading"><h2 id="items-heading" className="text-xl font-semibold">Items &amp; customization</h2><ul className="mt-4 divide-y divide-brand-border">{items.length ? items.map((item, index) => <li key={item.id || `${item.product_name}-${index}`} className="py-4 first:pt-0 last:pb-0"><div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:justify-between"><div className="min-w-0"><h3 className="break-words font-semibold">{item.product_slug ? <Link href={`/catalog/${item.product_slug}`} className="hover:text-brand-primary">{item.product_name}</Link> : item.product_name}</h3><p className="mt-1 text-sm text-brand-textMuted">Qty {item.quantity}{item.unit_price_cents != null ? ` · ${money(item.unit_price_cents)} each` : ""}</p></div>{item.line_subtotal_cents != null ? <p className="shrink-0 font-semibold">{money(item.line_subtotal_cents)}</p> : null}</div>{item.selected_options && Object.keys(item.selected_options).length ? <div className="mt-4 rounded-xl bg-black/20 p-4"><h4 className="text-xs font-semibold uppercase tracking-wide text-brand-textMuted">Configuration</h4><dl className="mt-2 grid min-w-0 gap-3 text-sm sm:grid-cols-2"><RequestSpecifications specifications={item.selected_options} /></dl></div> : null}</li>) : <li className="text-sm text-brand-textMuted">Item details are included in the order request.</li>}</ul></section>

    <section className="ui-card" aria-labelledby="payment-heading"><h2 id="payment-heading" className="text-xl font-semibold">Payment summary</h2>{paymentAvailable ? <dl className="mt-4 grid gap-2 text-sm">
      {payment.subtotal != null ? <Row label="Subtotal" value={money(payment.subtotal)} /> : null}{payment.discount > 0 ? <Row label="Discount" value={`−${money(payment.discount)}`} /> : null}{payment.shipping != null ? <Row label="Shipping" value={money(payment.shipping)} /> : null}{payment.tax != null ? <Row label="Tax" value={money(payment.tax)} /> : null}{payment.total != null ? <Row label="Total" value={money(payment.total)} strong /> : null}{payment.paid > 0 ? <Row label="Paid" value={money(payment.paid)} /> : null}{payment.refunded > 0 ? <Row label="Refunded" value={money(payment.refunded)} /> : null}{payment.balance != null ? <Row label="Balance" value={money(payment.balance)} strong /> : null}
    </dl> : <p role="status" className="mt-3 text-sm text-brand-textMuted">Payment information unavailable. Your order has not been counted as unpaid.</p>}</section>

    <OrderFulfillmentStatus order={{ ...order, fulfillment_status: order.fulfillment_status ?? null, fulfillment_method: order.fulfillment_method ?? null, shipping_address: order.shipping_address ?? null, pickup_location_snapshot: order.pickup_location_snapshot ?? null, shipping_method_snapshot: order.shipping_method_snapshot ?? null, shipping_carrier: order.shipping_carrier ?? null, tracking_number: order.tracking_number ?? null, tracking_url: order.tracking_url ?? null, customer_shipment_note: order.customer_shipment_note ?? null, shipping_cents: order.shipping_cents ?? null, ready_at: order.ready_at ?? null, shipped_at: order.shipped_at ?? null, delivered_at: order.delivered_at ?? null, picked_up_at: order.picked_up_at ?? null }} />
  </>;
}
function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) { return <div className={`flex items-baseline justify-between gap-4 ${strong ? "border-t border-brand-border pt-2 font-semibold" : ""}`}><dt className="text-brand-textMuted">{label}</dt><dd className="text-right">{value}</dd></div>; }
