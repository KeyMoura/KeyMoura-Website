"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { StaffOrderWorkspace } from "@/components/staff/StaffOrderWorkspace";

type Order = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_name: string;
  status: string;
  quantity: number;
  specifications: Record<string, unknown>;
  customer_notes: string | null;
  staff_notes: string | null;
  agreed_price_cents: number | null;
  payment_status: string;
  amount_paid_cents: number;
  deposit_amount_cents: number | null;
  quote_revision: number;
  quote_expires_at: string | null;
  amount_refunded_cents: number;
  target_date: string | null;
  fulfillment_method: "shipping" | "pickup";
  shipping_address: Record<string, string> | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  created_at: string;
  paid_at: string | null;
};
type Message = {
  id: number;
  sender_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
};
type EmailDelivery = { id:string; recipient:string; subject:string; status:"sent"|"failed"|"skipped"; error_message:string|null; created_at:string };
type History = { id:number; from_status:string|null; to_status:string; note:string|null; created_at:string };
type Payment = { id:string; amount_cents:number; received_at:string };
type Refund = { id:string; amount_cents:number; reason:string; created_at:string };
const statuses = [
  "requested",
  "needs_information",
  "accepted",
  "awaiting_payment",
  "in_progress",
  "customer_review",
  "final_review",
  "ready",
  "completed",
  "declined",
  "cancelled",
];
const pretty = (s: string) =>
  s.replaceAll("_", " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusLabel = (status: string) => {
  if (status === "customer_review") return "Quote Review";
  if (status === "final_review") return "Finished Product Review";
  return pretty(status);
};
const nextStaffStep = (order: Order) => {
  if (order.status === "requested") return { title: "Review the request", detail: "Confirm the specifications, then prepare and send the customer quote.", href: "#quote" };
  if (order.status === "needs_information") return { title: "Waiting for customer information", detail: "Use the conversation to follow up if the customer has not replied.", href: "#conversation" };
  if (order.status === "accepted" || order.status === "awaiting_payment") return { title: "Waiting for payment", detail: "The customer has the quote. Production can begin after the required payment is received.", href: "#activity" };
  if (order.status === "customer_review") return { title: "Waiting for quote approval", detail: "The customer needs to approve the current quote before checkout.", href: "#quote" };
  if (order.status === "in_progress") return { title: "Complete production", detail: "Use the production workspace, then send the finished product for customer review.", href: "#production" };
  if (order.status === "final_review") return { title: "Waiting for finished-product approval", detail: "The customer is reviewing the finished product. Fulfillment unlocks after approval.", href: "#fulfillment" };
  if (order.status === "ready") return { title: order.fulfillment_method === "pickup" ? "Prepare customer pickup" : "Ship the order", detail: "Confirm the balance is paid, then complete the fulfillment action below.", href: "#fulfillment" };
  if (order.status === "completed") return { title: "Order complete", detail: "No action is required. The full record remains available below.", href: "#activity" };
  if (order.status === "declined" || order.status === "cancelled") return { title: statusLabel(order.status), detail: "No normal workflow action is pending. Review payment and refund records if needed.", href: "#activity" };
  return { title: "Review this order", detail: "Check the order details and choose the appropriate next action.", href: "#quote" };
};
export default function StaffOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const perms = new Set(access?.permissions ?? []);
  const canView = perms.has("orders.view") || perms.has("orders.manage");
  const canManage = perms.has("orders.manage");
  const [order, setOrder] = useState<Order | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [emails, setEmails] = useState<EmailDelivery[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [price, setPrice] = useState("");
  const [paid, setPaid] = useState("");
  const [deposit, setDeposit] = useState("");
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteExpires, setQuoteExpires] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [target, setTarget] = useState("");
  const [staffNotes, setStaffNotes] = useState("");
  const [method, setMethod] = useState<"shipping"|"pickup">("shipping");
  const [address, setAddress] = useState({ name:"", line1:"", line2:"", city:"", state:"", postal_code:"", country:"US" });
  const [carrier, setCarrier] = useState("");
  const [trackingNumber, setTrackingNumber] = useState("");
  const [trackingUrl, setTrackingUrl] = useState("");
  const [error, setError] = useState("");
  const [pendingStatus, setPendingStatus] = useState("");
  const load = useCallback(async () => {
    const [o, m, e, h, p, r] = await Promise.all([
      supabase.from("orders").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("order_messages")
        .select("*")
        .eq("order_id", id)
        .order("created_at"),
      supabase.from("email_deliveries").select("id,recipient,subject,status,error_message,created_at").eq("order_id",id).order("created_at",{ascending:false}),
      supabase.from("order_status_history").select("id,from_status,to_status,note,created_at").eq("order_id",id).order("created_at",{ascending:false}),
      supabase.from("order_payments").select("id,amount_cents,received_at").eq("order_id",id).order("received_at",{ascending:false}),
      supabase.from("order_refunds").select("id,amount_cents,reason,created_at").eq("order_id",id).order("created_at",{ascending:false}),
    ]);
    const row = o.data as Order | null;
    setOrder(row);
    setMessages((m.data ?? []) as Message[]);
    setEmails((e.data ?? []) as EmailDelivery[]);
    setHistory((h.data ?? []) as History[]);
    setPayments((p.data ?? []) as Payment[]);
    setRefunds((r.data ?? []) as Refund[]);
    if (row) {
      setPrice(
        row.agreed_price_cents == null
          ? ""
          : String(row.agreed_price_cents / 100),
      );
      setPaid(String(row.amount_paid_cents / 100));
      setDeposit(row.deposit_amount_cents == null ? "" : String(row.deposit_amount_cents / 100));
      setQuoteExpires(row.quote_expires_at?.slice(0, 10) ?? "");
      setTarget(row.target_date ?? "");
      setStaffNotes(row.staff_notes ?? "");
      setMethod(row.fulfillment_method ?? "shipping");
      setAddress({ name:"", line1:"", line2:"", city:"", state:"", postal_code:"", country:"US", ...(row.shipping_address ?? {}) });
      setCarrier(row.shipping_carrier ?? "");
      setTrackingNumber(row.tracking_number ?? "");
      setTrackingUrl(row.tracking_url ?? "");
    }
    setError(o.error?.message ?? m.error?.message ?? e.error?.message ?? h.error?.message ?? p.error?.message ?? r.error?.message ?? "");
  }, [id, supabase]);
  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);
  async function authHeaders() {
    const session = await supabase.auth.getSession();
    return {
      "Content-Type": "application/json",
      ...(session.data.session?.access_token
        ? { Authorization: `Bearer ${session.data.session.access_token}` }
        : {}),
    };
  }
  async function updateStatus(status: string) {
    if (status === order?.status) return;
    const cancellationReason = status === "cancelled" ? window.prompt("Why is this order being cancelled? This reason is kept with the order.")?.trim() : "";
    if (status === "cancelled" && !cancellationReason) return;
    if (!window.confirm(`Change this order from ${pretty(order?.status || "current")} to ${pretty(status)}?\n\nThe customer will be notified and may receive an email.${order?.amount_paid_cents ? " This does not issue a refund; use the refund control separately." : ""}`)) return;
    const r = await fetch(`/api/staff/orders/${id}`, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({ status, cancellation_reason: cancellationReason || undefined }),
    });
    const result = await r.json();
    if (!r.ok) {
      setError(result.error || "Could not update status");
      return;
    }
    setPendingStatus("");
    await load();
  }
  async function save() {
    const priceCents = price.trim() ? Math.round(Number(price) * 100) : null;
    const depositCents = deposit.trim() ? Math.round(Number(deposit) * 100) : null;
    const quoteChanged = priceCents !== order?.agreed_price_cents || depositCents !== order?.deposit_amount_cents;
    if (quoteChanged && priceCents && !window.confirm(`Send quote revision ${(order?.quote_revision ?? 0) + 1} for $${(priceCents / 100).toFixed(2)}?\n\nThis moves the order to Customer Review and notifies the customer. Internal material and labor costs are not the customer price.`)) return;
    const r = await fetch(`/api/staff/orders/${id}`, {
      method: "PATCH",
      headers: await authHeaders(),
      body: JSON.stringify({
        agreed_price_cents: priceCents,
        deposit_amount_cents: depositCents,
        quote_note: quoteNote.trim() || null,
        quote_expires_at: quoteExpires ? new Date(`${quoteExpires}T23:59:59.999Z`).toISOString() : null,
        target_date: target || null,
        staff_notes: staffNotes || null,
        fulfillment_method: method,
        shipping_address: method === "shipping" ? address : null,
        shipping_carrier: carrier || null,
        tracking_number: trackingNumber || null,
        tracking_url: trackingUrl || null,
      }),
    });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not save details");
    else await load();
  }
  async function issueRefund() {
    const cents = Math.round(Number(refundAmount) * 100);
    if (!Number.isInteger(cents) || cents < 1 || refundReason.trim().length < 3) { setError("Enter a refund amount and reason."); return; }
    if (!window.confirm(`Issue a $${(cents/100).toFixed(2)} refund through Stripe?\n\nThis cannot be undone. The customer will be notified.`)) return;
    const r = await fetch(`/api/staff/orders/${id}/refund`, { method:"POST", headers:await authHeaders(), body:JSON.stringify({ amount_cents:cents, reason:refundReason.trim() }) });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not issue refund");
    else { setRefundAmount(""); setRefundReason(""); setError(""); await load(); }
  }
  async function fulfillmentAction(shipment_action: "mark_shipped"|"mark_delivered") {
    const actionLabel = shipment_action === "mark_delivered" ? "mark this order completed" : method === "pickup" ? "mark this order ready for pickup" : "mark this order shipped";
    if (!window.confirm(`Confirm you want to ${actionLabel}?\n\nThe status will change and the customer will be notified by email.`)) return;
    const r = await fetch(`/api/staff/orders/${id}`, { method:"PATCH", headers:await authHeaders(), body:JSON.stringify({ shipment_action, fulfillment_method:method, shipping_address:method === "shipping" ? address : null, shipping_carrier:carrier || null, tracking_number:trackingNumber || null, tracking_url:trackingUrl || null }) });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not update fulfillment"); else { setError(""); await load(); }
  }
  async function send(e: FormEvent) {
    e.preventDefault();
    const r = await fetch(`/api/orders/${id}/messages`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ body: body.trim(), internal }),
    });
    const result = await r.json();
    if (!r.ok) setError(result.error || "Could not send message");
    else {
      setBody("");
      await load();
    }
  }
  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView)
    return <AccessDeniedCard message="You do not have access to orders." />;
  if (!order)
    return <p className="text-rose-200">{error || "Order not found."}</p>;
  const input =
    "rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 outline-none focus:border-brand-primary";
  const nextStep = nextStaffStep(order);
  return (
    <main>
      <header className="rounded-3xl border border-zinc-800 bg-[linear-gradient(145deg,rgba(24,24,27,.95),rgba(0,0,0,.75))] p-5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[.2em] text-brand-primary">{order.order_number || "Request pending"}</p><h1 className="mt-2 text-3xl font-semibold">{order.product_name}</h1><p className="mt-2 text-sm text-brand-textMuted">Quantity {order.quantity} · Submitted {new Date(order.created_at).toLocaleDateString()}</p></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Status</p><p className="mt-1 text-sm font-semibold text-brand-primary">{statusLabel(order.status)}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Customer price</p><p className="mt-1 text-sm font-semibold">{order.agreed_price_cents == null ? "Not quoted" : `$${(order.agreed_price_cents/100).toFixed(2)}`}</p></div>
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Net paid</p><p className="mt-1 text-sm font-semibold text-emerald-300">${((order.amount_paid_cents-(order.amount_refunded_cents||0))/100).toFixed(2)}</p>{order.amount_refunded_cents ? <p className="text-[10px] text-brand-textMuted">${(order.amount_refunded_cents/100).toFixed(2)} refunded</p> : null}</div>
            <div className="rounded-xl border border-zinc-800 bg-black/30 p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Balance</p><p className="mt-1 text-sm font-semibold">${(Math.max(0,(order.agreed_price_cents || 0)-order.amount_paid_cents)/100).toFixed(2)}</p></div>
          </div>
        </div>
      </header>
      <div className="mt-5 rounded-2xl border border-brand-primary/35 bg-brand-primary/10 p-4 sm:flex sm:items-center sm:justify-between sm:gap-5">
        <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-primary">Next step</p><h2 className="mt-1 text-lg font-semibold">{nextStep.title}</h2><p className="mt-1 text-sm text-brand-textMuted">{nextStep.detail}</p></div>
        <a href={nextStep.href} className="mt-3 inline-flex shrink-0 rounded-xl bg-brand-primary px-4 py-2 font-semibold text-black sm:mt-0">Go to action</a>
      </div>
      <nav className="mt-3 flex gap-2 overflow-x-auto pb-1 text-xs font-medium text-brand-textMuted" aria-label="Order sections">
        <a href="#quote" className="rounded-full border border-zinc-800 px-3 py-1.5 hover:text-white">Quote & request</a><a href="#production" className="rounded-full border border-zinc-800 px-3 py-1.5 hover:text-white">Production</a><a href="#fulfillment" className="rounded-full border border-zinc-800 px-3 py-1.5 hover:text-white">Fulfillment</a><a href="#conversation" className="rounded-full border border-zinc-800 px-3 py-1.5 hover:text-white">Conversation</a><a href="#activity" className="rounded-full border border-zinc-800 px-3 py-1.5 hover:text-white">Activity</a>
      </nav>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div id="production" className="scroll-mt-5 lg:col-span-2">
          <StaffOrderWorkspace orderId={id} canManage={canManage} />
        </div>
        <section id="quote" className="-order-1 scroll-mt-5 rounded-2xl border border-zinc-800 bg-black/30 p-5 lg:col-span-2">
          <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-primary">Customer quote</p><h2 className="mt-1 text-xl font-semibold">Price & schedule</h2></div><span className="rounded-full border border-zinc-700 px-3 py-1 text-xs text-brand-textMuted">Revision {order.quote_revision}</span></div>
          <p className="mt-2 text-sm leading-6 text-brand-textMuted">This is the final price the customer pays—not your material or labor cost. Internal costs stay in the Production workspace.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Total customer price ($)
              <input
                disabled={!canManage || order.payment_status === "paid"}
                className={`${input} mt-1 w-full`}
                type="number"
                step=".01"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
              />
            </label>
            <label className="text-sm">
              Amount paid ($)
              <input
                disabled
                className={`${input} mt-1 w-full opacity-70`}
                type="number"
                value={paid}
              />
              <span className="mt-1 block text-[10px] text-brand-textMuted">
                Updated automatically by Stripe
              </span>
            </label>
            <label className="text-sm">
              Deposit due first ($)
              <input disabled={!canManage || order.payment_status === "paid"} className={`${input} mt-1 w-full`} type="number" min="0.5" step=".01" value={deposit} onChange={(e)=>setDeposit(e.target.value)} placeholder="Blank = collect full price" />
              <span className="mt-1 block text-[10px] text-brand-textMuted">Leave blank to collect the full quote. Editing price or deposit creates a new quote revision.</span>
            </label>
            <label className="text-sm sm:col-span-2">Quote note<textarea disabled={!canManage} className={`${input} mt-1 min-h-20 w-full`} value={quoteNote} onChange={e=>setQuoteNote(e.target.value)} placeholder="What changed or what is included in this quote?" /></label>
            <label className="text-sm">Quote valid through<input disabled={!canManage || order.payment_status === "paid"} className={`${input} mt-1 w-full`} type="date" value={quoteExpires} onChange={e=>setQuoteExpires(e.target.value)} /><span className="mt-1 block text-[10px] text-brand-textMuted">Checkout is blocked after this date until a new quote is sent.</span></label>
            <label className="text-sm">
              Target date
              <input
                disabled={!canManage}
                className={`${input} mt-1 w-full`}
                type="date"
                value={target}
                onChange={(e) => setTarget(e.target.value)}
              />
            </label>
            <label className="text-sm sm:col-span-2">
              Internal notes
              <textarea
                disabled={!canManage}
                className={`${input} mt-1 min-h-24 w-full`}
                value={staffNotes}
                onChange={(e) => setStaffNotes(e.target.value)}
              />
            </label>
          </div>
          <div id="fulfillment" className="mt-5 scroll-mt-5 border-t border-zinc-800 pt-5">
            <h2 className="font-semibold">Fulfillment</h2>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <label className="text-sm">Delivery method<select disabled={!canManage} className={`${input} mt-1 w-full`} value={method} onChange={e=>setMethod(e.target.value as "shipping"|"pickup")}><option value="shipping">Ship to customer</option><option value="pickup">Customer pickup</option></select></label>
              <label className="text-sm">Carrier<input disabled={!canManage || method === "pickup"} className={`${input} mt-1 w-full`} value={carrier} onChange={e=>setCarrier(e.target.value)} placeholder="USPS, UPS, FedEx…" /></label>
              {method === "shipping" ? <><label className="text-sm sm:col-span-2">Recipient<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.name} onChange={e=>setAddress({...address,name:e.target.value})} /></label><label className="text-sm sm:col-span-2">Address<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.line1} onChange={e=>setAddress({...address,line1:e.target.value})} /></label><label className="text-sm">City<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.city} onChange={e=>setAddress({...address,city:e.target.value})} /></label><label className="text-sm">State / region<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.state} onChange={e=>setAddress({...address,state:e.target.value})} /></label><label className="text-sm">Postal code<input disabled={!canManage} className={`${input} mt-1 w-full`} value={address.postal_code} onChange={e=>setAddress({...address,postal_code:e.target.value})} /></label></> : null}
              <label className="text-sm">Tracking number<input disabled={!canManage || method === "pickup"} className={`${input} mt-1 w-full`} value={trackingNumber} onChange={e=>setTrackingNumber(e.target.value)} /></label>
              <label className="text-sm sm:col-span-2">Tracking link<input disabled={!canManage || method === "pickup"} type="url" className={`${input} mt-1 w-full`} value={trackingUrl} onChange={e=>setTrackingUrl(e.target.value)} placeholder="https://…" /></label>
            </div>
            {canManage ? <div className="mt-4 flex flex-wrap gap-2"><button onClick={()=>void save()} className="rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary">Save fulfillment</button>{order.status === "in_progress" ? <button onClick={()=>void updateStatus("final_review")} className="rounded-xl border border-brand-primary/80 bg-brand-primary px-4 py-2 font-semibold text-black">Send for Customer Review</button> : null}<button disabled={Boolean(order.shipped_at) || order.status !== "ready" || order.amount_paid_cents - (order.amount_refunded_cents || 0) < (order.agreed_price_cents || 0)} onClick={()=>void fulfillmentAction("mark_shipped")} className="rounded-xl border border-brand-accent/70 px-4 py-2 font-semibold text-brand-accent disabled:opacity-40">{order.shipped_at ? "Shipped" : method === "pickup" ? "Mark ready for pickup" : "Mark shipped + email"}</button><button disabled={!order.shipped_at || Boolean(order.delivered_at)} onClick={()=>void fulfillmentAction("mark_delivered")} className="rounded-xl border border-emerald-500/60 px-4 py-2 font-semibold text-emerald-300 disabled:opacity-40">{order.delivered_at ? "Completed" : method === "pickup" ? "Mark picked up + email" : "Mark delivered + email"}</button></div> : null}
          </div>
          {canManage ? (
            <button
              onClick={() => void save()}
              className="mt-3 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary transition hover:bg-brand-primary/30"
            >
              {price.trim() && Math.round(Number(price)*100)!==order.agreed_price_cents ? "Review & send quote" : "Save internal details"}
            </button>
          ) : null}
          {canManage && order.amount_paid_cents > (order.amount_refunded_cents || 0) ? <div className="mt-6 rounded-xl border border-rose-500/30 bg-rose-500/5 p-4"><h3 className="font-semibold text-rose-200">Cancellation & refund</h3><p className="mt-1 text-xs text-brand-textMuted">Cancelling an order does not move money. Refunds are separate, recorded actions sent through Stripe.</p><div className="mt-3 grid gap-3 sm:grid-cols-[160px_1fr_auto]"><label className="text-sm">Refund amount ($)<input className={`${input} mt-1 w-full`} type="number" min=".01" max={(order.amount_paid_cents-(order.amount_refunded_cents||0))/100} step=".01" value={refundAmount} onChange={e=>setRefundAmount(e.target.value)} /></label><label className="text-sm">Internal reason<input className={`${input} mt-1 w-full`} value={refundReason} onChange={e=>setRefundReason(e.target.value)} placeholder="Why is this refund being issued?" /></label><button onClick={()=>void issueRefund()} className="self-end rounded-xl border border-rose-500/60 px-4 py-2 font-semibold text-rose-200">Review & issue refund</button></div></div> : null}
          <dl className="mt-5 grid gap-3 border-t border-zinc-800 pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-brand-textMuted">Quantity</dt>
              <dd>{order.quantity}</dd>
            </div>
            <RequestSpecifications
              specifications={order.specifications || {}}
            />
          </dl>
          <div className="mt-5 border-t border-zinc-800 pt-4 text-sm">
            <div className="text-brand-textMuted">Customer notes</div>
            <p className="mt-1 whitespace-pre-wrap">
              {order.customer_notes || "None"}
            </p>
          </div>
        </section>
        <section id="conversation" className="scroll-mt-5">
          <h2 className="font-semibold">Conversation</h2>
          <div className="mt-3 max-h-[480px] space-y-3 overflow-y-auto">
            {messages.map((m) => (
              <div
                key={m.id}
                className={`rounded-xl border p-3 text-sm ${m.is_internal ? "border-sky-500/40 bg-sky-500/10" : "border-zinc-800 bg-black/30"}`}
              >
                <div className="text-[10px] text-brand-textMuted">
                  {m.is_internal
                    ? "INTERNAL NOTE"
                    : m.sender_id === order.customer_id
                      ? "CUSTOMER"
                      : "KEYMOURA"}{" "}
                  · {new Date(m.created_at).toLocaleString()}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              </div>
            ))}
          </div>
          {canManage ? (
            <form onSubmit={send} className="mt-3">
              <textarea
                required
                className={`${input} min-h-24 w-full`}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Reply to customer or add an internal note…"
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-brand-textMuted">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                />{" "}
                Internal note (customer cannot see)
              </label>
              <button className="mt-3 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-4 py-2 font-semibold text-brand-primary transition hover:bg-brand-primary/30">
                Send
              </button>
            </form>
          ) : null}
        </section>
        <section id="activity" className="scroll-mt-5 md:col-span-2">
          <h2 className="font-semibold">Activity timeline</h2>
          <div className="mt-3 space-y-2 rounded-xl border border-zinc-800 p-4">
            {[...history.map(item=>({id:`h-${item.id}`,at:item.created_at,label:`Status changed to ${pretty(item.to_status)}`,detail:item.note})),...messages.map(item=>({id:`m-${item.id}`,at:item.created_at,label:item.is_internal?"Internal note added":item.sender_id===order.customer_id?"Customer message":"KeyMoura message",detail:item.body})),...payments.map(payment=>({id:`p-${payment.id}`,at:payment.received_at,label:"Payment received",detail:`$${(payment.amount_cents/100).toFixed(2)}`})),...refunds.map(refund=>({id:`r-${refund.id}`,at:refund.created_at,label:"Refund issued",detail:`$${(refund.amount_cents/100).toFixed(2)} — ${refund.reason}`})),...(order.shipped_at?[{id:"shipped",at:order.shipped_at,label:method==="pickup"?"Ready for pickup":"Order shipped",detail:trackingNumber || null}]:[]),...(order.delivered_at?[{id:"delivered",at:order.delivered_at,label:"Order delivered / completed",detail:null}]:[]),{id:"created",at:order.created_at,label:"Request submitted",detail:null}].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).map(item=><div key={item.id} className={`border-l-2 pl-4 ${item.id.startsWith("r-") ? "border-rose-400/70" : item.id.startsWith("p-") ? "border-emerald-400/70" : "border-brand-accent/60"}`}><div className="text-sm font-medium">{item.label}</div><div className="text-[11px] text-brand-textMuted">{new Date(item.at).toLocaleString()}</div>{item.detail?<p className="mt-1 line-clamp-2 text-xs text-brand-textMuted">{item.detail}</p>:null}</div>)}
          </div>
        </section>
        <section className="md:col-span-2">
          <h2 className="font-semibold">Email history</h2>
          <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
            {emails.map(email=><div key={email.id} className="grid gap-1 border-b border-zinc-800 bg-black/20 px-4 py-3 text-sm last:border-b-0 md:grid-cols-[1fr_1.4fr_auto]"><div><span className="text-brand-textMuted">To </span>{email.recipient}</div><div>{email.subject}</div><div className={email.status==="sent"?"text-emerald-300":email.status==="failed"?"text-rose-300":"text-amber-200"}>{pretty(email.status)} · {new Date(email.created_at).toLocaleString()}</div>{email.error_message?<div className="text-xs text-rose-200 md:col-span-3">{email.error_message}</div>:null}</div>)}
            {emails.length===0?<div className="px-4 py-6 text-center text-sm text-brand-textMuted">No email attempts for this order yet.</div>:null}
          </div>
        </section>
        {canManage ? <details className="md:col-span-2 rounded-2xl border border-zinc-800 bg-black/20 p-4"><summary className="cursor-pointer font-semibold">Advanced status override</summary><p className="mt-2 text-xs text-brand-textMuted">Use this only when the normal quote, payment, review, or fulfillment buttons cannot represent what happened. The customer will be notified.</p><div className="mt-3 sm:flex sm:items-end sm:gap-4"><label className="block flex-1 text-sm font-medium">Customer-facing status<select value={pendingStatus || order.status} onChange={e=>setPendingStatus(e.target.value)} className="mt-2 w-full rounded-xl border border-zinc-700 bg-zinc-950 px-3 py-2.5 outline-none focus:border-brand-primary">{statuses.map(s=><option key={s} value={s}>{statusLabel(s)}</option>)}</select></label><button disabled={!pendingStatus || pendingStatus===order.status} onClick={()=>void updateStatus(pendingStatus)} className="mt-3 rounded-xl border border-amber-400/60 px-5 py-2.5 font-semibold text-amber-200 disabled:cursor-not-allowed disabled:opacity-40 sm:mt-0">Review & confirm update</button></div></details> : null}
      </div>
      {error ? <p className="mt-4 text-rose-200">{error}</p> : null}
    </main>
  );
}
