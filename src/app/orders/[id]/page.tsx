"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { moneyFromCents, ORDER_STATUS_STEPS, orderLabel, orderNeedsCustomerAction, orderNextStep, orderProgressIndex } from "@/lib/orderHub";
import { checkoutAmountCents } from "@/lib/paymentMath";
import { OrderReviewGallery } from "@/components/OrderReviewGallery";

type Order = {
  id: string;
  order_number: string | null;
  product_name: string;
  status: string;
  quantity: number;
  specifications: Record<string, unknown>;
  customer_notes: string | null;
  agreed_price_cents: number | null;
  payment_status: string;
  amount_paid_cents: number;
  deposit_amount_cents: number | null;
  quote_revision: number;
  quote_accepted_at: string | null;
  quote_expires_at: string | null;
  amount_refunded_cents: number;
  cancellation_reason: string | null;
  target_date: string | null;
  created_at: string;
  fulfillment_method: "shipping" | "pickup";
  shipping_address: Record<string,string> | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  final_review_note: string | null;
  final_review_asset_paths: string[];
};
type Message = {
  id: number;
  sender_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
};
type History = { id: number; from_status: string | null; to_status: string; note: string | null; created_at: string };
type Payment = { id: string; amount_cents: number; received_at: string };
type Refund = { id: string; amount_cents: number; reason: string; created_at: string };

export default function OrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const [order, setOrder] = useState<Order | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<History[]>([]);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [userId, setUserId] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quoteExpired, setQuoteExpired] = useState(false);
  const [revisionNote, setRevisionNote] = useState("");
  const load = useCallback(async () => {
    const auth = await supabase.auth.getUser();
    setUserId(auth.data.user?.id ?? "");
    const [o, m, h, p, r] = await Promise.all([
      supabase.from("orders").select("*").eq("id", id).maybeSingle(),
      supabase
        .from("order_messages")
        .select("id,sender_id,body,is_internal,created_at")
        .eq("order_id", id)
        .order("created_at"),
      supabase.from("order_status_history").select("id,from_status,to_status,note,created_at").eq("order_id", id).order("created_at", { ascending: false }),
      supabase.from("order_payments").select("id,amount_cents,received_at").eq("order_id", id).order("received_at", { ascending: false }),
      supabase.from("order_refunds").select("id,amount_cents,reason,created_at").eq("order_id", id).order("created_at", { ascending: false }),
    ]);
    const loadedOrder = o.data as Order | null;
    setOrder(loadedOrder);
    setQuoteExpired(Boolean(loadedOrder?.quote_expires_at && new Date(loadedOrder.quote_expires_at).getTime() <= Date.now()));
    setMessages((m.data ?? []) as Message[]);
    setHistory((h.data ?? []) as History[]);
    setPayments((p.data ?? []) as Payment[]);
    setRefunds((r.data ?? []) as Refund[]);
    setError(o.error?.message ?? m.error?.message ?? h.error?.message ?? p.error?.message ?? r.error?.message ?? "");
  }, [id, supabase]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!body.trim() || !userId) return;
    setBusy(true);
    const session = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(session.data.session?.access_token
          ? { Authorization: `Bearer ${session.data.session.access_token}` }
          : {}),
      },
      body: JSON.stringify({ body: body.trim() }),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not send message");
    else {
      setBody("");
      await load();
    }
    setBusy(false);
  }
  async function checkout() {
    setBusy(true);
    setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/checkout`, {
      method: "POST",
      headers: data.session?.access_token
        ? { Authorization: `Bearer ${data.session.access_token}` }
        : {},
    });
    const result = await response.json();
    if (!response.ok || !result.url) {
      setError(result.error || "Could not start checkout.");
      setBusy(false);
      return;
    }
    window.location.assign(result.url);
  }
  async function approveFinishedOrder() {
    if (!window.confirm("Approve the finished order? KeyMoura will prepare it for pickup or shipping.")) return;
    setBusy(true);
    setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/final-review`, { method:"POST", headers:data.session?.access_token ? { Authorization:`Bearer ${data.session.access_token}` } : {} });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not approve the finished order");
    else await load();
    setBusy(false);
  }
  async function requestRevisions() {
    const note = revisionNote.trim();
    if (note.length < 3) {
      setError("Please explain what needs to be revised.");
      return;
    }
    if (!window.confirm("Send this revision request to KeyMoura and return the order to production?")) return;
    setBusy(true);
    setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/final-review`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
      },
      body: JSON.stringify({ action: "request_revisions", note }),
    });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not request revisions.");
    else {
      setRevisionNote("");
      await load();
    }
    setBusy(false);
  }
  async function approveQuote() {
    setBusy(true); setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/quote`, { method:"POST", headers:data.session?.access_token ? { Authorization:`Bearer ${data.session.access_token}` } : {} });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not approve quote."); else await load();
    setBusy(false);
  }
  if (!order)
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 text-brand-textMuted">
        {error || "Loading order…"}
      </main>
    );
  const needsAction = orderNeedsCustomerAction(order);
  const progressIndex = orderProgressIndex(order.status);
  const isClosed = ["declined", "cancelled"].includes(order.status);
  const checkoutAmount = checkoutAmountCents(order);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:py-12">
      <Link href="/orders" className="text-sm text-brand-textMuted transition hover:text-brand-primary">← Back to your orders</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
            {order.order_number || "Request pending"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold">{order.product_name}</h1>
        </div>
        <span className="rounded-full border border-brand-primary/60 bg-brand-primary/10 px-4 py-2 text-sm text-brand-primary">
          {orderLabel(order.status)}
        </span>
      </div>
      <section className={`mt-6 rounded-2xl border p-5 ${needsAction ? "border-brand-primary/50 bg-brand-primary/10" : "border-zinc-800 bg-black/30"}`}>
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-textMuted">What happens next</p>
        <p className={`mt-2 text-lg font-semibold ${needsAction ? "text-brand-primary" : "text-brand-text"}`}>{orderNextStep(order)}</p>
        {order.status === "needs_information" ? <p className="mt-1 text-sm text-brand-textMuted">Send the missing details in order chat below so work can continue.</p> : null}
      </section>

      {!isClosed ? <section className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-5" aria-label="Order progress">
        <div className="flex items-center justify-between text-xs text-brand-textMuted"><span>Request</span><span>Making</span><span>Complete</span></div>
        <div className="mt-3 flex gap-1.5">{ORDER_STATUS_STEPS.map((step, index) => <div key={step} title={orderLabel(step)} className={`h-2 flex-1 rounded-full ${index <= progressIndex ? "bg-brand-primary" : "bg-zinc-800"}`} />)}</div>
      </section> : null}
      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-brand-textMuted">Price</div>
          <div className="mt-1 font-medium">
            {order.agreed_price_cents == null
              ? "Pending"
              : moneyFromCents(order.agreed_price_cents)}
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-brand-textMuted">Payment</div>
          <div className="mt-1 font-medium">{orderLabel(order.payment_status)}</div>
          {order.amount_refunded_cents ? <div className="mt-1 text-xs text-brand-textMuted">{moneyFromCents(order.amount_refunded_cents)} refunded</div> : null}
        </div>
        <div className="rounded-xl border border-zinc-800 p-4">
          <div className="text-xs text-brand-textMuted">Target</div>
          <div className="mt-1 font-medium">
            {order.target_date || "Not set"}
          </div>
        </div>
      </div>
      {order.status === "customer_review" && !order.quote_accepted_at && order.agreed_price_cents ? <section className={`mt-4 rounded-2xl border p-5 ${quoteExpired ? "border-amber-500/50 bg-amber-500/10" : "border-brand-primary/50 bg-brand-primary/10"}`}><p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-primary">Quote revision {order.quote_revision}</p><h2 className="mt-2 text-xl font-semibold">{quoteExpired ? "This quote has expired" : `Review and approve ${moneyFromCents(order.agreed_price_cents)}`}</h2><p className="mt-2 text-sm text-brand-textMuted">{quoteExpired ? "Send a message below to request an updated price and schedule." : <>Approve this quote to unlock secure payment. {order.deposit_amount_cents ? `${moneyFromCents(order.deposit_amount_cents)} is due first; the remaining balance is collected later.` : "The full amount will be due."}{order.quote_expires_at ? ` Valid through ${new Date(order.quote_expires_at).toLocaleDateString()}.` : ""}</>}</p>{!quoteExpired ? <button type="button" disabled={busy} onClick={()=>void approveQuote()} className="catalog-action-primary mt-4 rounded-xl px-5 py-2.5 font-semibold disabled:opacity-50">{busy?"Approving…":"Approve quote"}</button> : null}</section> : null}
      {order.status === "final_review" ? <section className="mt-4 rounded-2xl border border-brand-accent/50 bg-brand-accent/10 p-5"><p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-accent">Finished-product review</p><h2 className="mt-2 text-xl font-semibold">Your order is ready for approval</h2>{order.final_review_note ? <p className="mt-3 whitespace-pre-wrap text-sm text-brand-textMuted">{order.final_review_note}</p> : <p className="mt-2 text-sm text-brand-textMuted">Review the finished work below. Approving confirms it and sends the order to fulfillment.</p>}<OrderReviewGallery paths={order.final_review_asset_paths || []} /><div className="mt-5 rounded-xl border border-zinc-700 bg-black/25 p-4"><label className="block text-sm font-medium">Need something changed?<textarea value={revisionNote} onChange={event=>setRevisionNote(event.target.value)} maxLength={2000} placeholder="Explain exactly what needs to be revised…" className="mt-2 min-h-24 w-full rounded-xl border border-zinc-700 bg-black/40 p-3 outline-none focus:border-brand-accent" /></label><p className="mt-2 text-xs text-brand-textMuted">Your note will be sent to KeyMoura and the order will return to production.</p></div><div className="mt-4 flex flex-wrap gap-3"><button type="button" disabled={busy || revisionNote.trim().length < 3} onClick={()=>void requestRevisions()} className="rounded-xl border border-rose-400/60 px-5 py-2.5 font-semibold text-rose-200 disabled:opacity-40">{busy?"Sending…":"Needs revisions"}</button><button type="button" disabled={busy} onClick={()=>void approveFinishedOrder()} className="rounded-xl border border-brand-accent/70 bg-zinc-950 px-5 py-2.5 font-semibold text-brand-accent disabled:opacity-50">{busy?"Approving…":"Approve finished order"}</button></div></section> : null}
      {order.status === "cancelled" ? <section className="mt-4 rounded-2xl border border-zinc-700 bg-zinc-900/40 p-5"><h2 className="font-semibold">Order cancelled</h2><p className="mt-1 text-sm text-brand-textMuted">{order.cancellation_reason || "Contact KeyMoura through order chat if you have questions."}</p>{order.amount_paid_cents > (order.amount_refunded_cents || 0) ? <p className="mt-2 text-sm text-amber-200">Cancellation does not automatically mean a refund. Any approved refund will appear in the payment summary.</p> : null}</section> : null}
      {order.agreed_price_cents && checkoutAmount >= 50 &&
      ["accepted", "awaiting_payment", "in_progress"].includes(order.status) ? (
        <div className="mt-4 rounded-2xl border border-brand-primary/50 bg-brand-primary/10 p-5">
          <h2 className="font-semibold">Ready for payment</h2>
          <p className="mt-1 text-sm text-brand-textMuted">
            Pay securely through Stripe. KeyMoura never receives or stores your
            card number.
          </p>
          <button
            disabled={busy}
            onClick={() => void checkout()}
            className="mt-4 rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-5 py-2.5 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50"
          >
            {busy ? "Opening checkout…" : `Pay ${moneyFromCents(checkoutAmount)}`}
          </button>
        </div>
      ) : null}
      <section className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-5">
        <h2 className="font-semibold">Request details</h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-brand-textMuted">Quantity</dt>
            <dd>{order.quantity}</dd>
          </div>
          <RequestSpecifications specifications={order.specifications || {}} />
        </dl>
        {order.customer_notes ? (
          <p className="mt-4 whitespace-pre-wrap border-t border-zinc-800 pt-4 text-sm">
            {order.customer_notes}
          </p>
        ) : null}
      </section>
      {(order.fulfillment_method === "pickup" || order.tracking_number || order.shipped_at) ? <section className="mt-6 rounded-2xl border border-zinc-800 bg-black/30 p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Fulfillment</h2><p className="mt-1 text-sm text-brand-textMuted">{order.delivered_at ? order.fulfillment_method === "pickup" ? "Pickup complete" : "Delivered" : order.shipped_at ? order.fulfillment_method === "pickup" ? "Ready for pickup" : "Shipped" : order.fulfillment_method === "pickup" ? "Customer pickup" : "Shipping details"}</p></div>{order.tracking_url ? <a className="ui-btn ui-btn-primary" href={order.tracking_url} target="_blank" rel="noreferrer">Track shipment</a> : null}</div>{order.tracking_number ? <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2"><div><dt className="text-brand-textMuted">Carrier</dt><dd>{order.shipping_carrier || "Carrier"}</dd></div><div><dt className="text-brand-textMuted">Tracking number</dt><dd className="break-all">{order.tracking_number}</dd></div></dl> : null}</section> : null}
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_.8fr]">
      <section className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
        <h2 className="text-xl font-semibold">Order chat</h2>
        <p className="mt-1 text-sm text-brand-textMuted">Messages here stay connected to this order.</p>
        <div className="mt-3 space-y-3">
          {messages.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-700 p-5 text-center text-sm text-brand-textMuted">No messages yet. Send a question whenever you need help.</div> : null}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-2xl border p-3 text-sm ${m.sender_id === userId ? "ml-auto border-brand-primary/40 bg-brand-primary/10" : "border-zinc-800 bg-black/30"}`}
            >
              <p className="whitespace-pre-wrap">{m.body}</p>
              <p className="mt-2 text-[10px] text-brand-textMuted">
                {new Date(m.created_at).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
        <form onSubmit={send} className="mt-4 flex gap-2">
          <textarea
            required
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Ask a question or send an update…"
            className="min-h-20 flex-1 rounded-xl border border-zinc-700 bg-black/40 p-3 outline-none focus:border-brand-primary"
          />
          <button
            disabled={busy}
            className="rounded-xl border border-brand-primary/80 bg-brand-primary/20 px-5 font-semibold text-brand-primary transition hover:bg-brand-primary/30 disabled:opacity-50"
          >
            Send
          </button>
        </form>
        {error ? <p className="mt-2 text-sm text-rose-200">{error}</p> : null}
      </section>
      <aside className="rounded-2xl border border-zinc-800 bg-black/30 p-5">
        <h2 className="font-semibold">Activity</h2>
        <div className="mt-4 space-y-4">
          {[...history.map(item => ({ id:`status-${item.id}`, at:item.created_at, label:orderLabel(item.to_status), detail:item.note })), ...payments.map(payment => ({ id:`payment-${payment.id}`, at:payment.received_at, label:"Payment received", detail:moneyFromCents(payment.amount_cents) })), ...refunds.map(refund => ({ id:`refund-${refund.id}`, at:refund.created_at, label:"Refund issued", detail:`${moneyFromCents(refund.amount_cents)} — ${refund.reason}` })), { id:"created", at:order.created_at, label:"Request submitted", detail:null }].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).map(item => <div key={item.id} className="relative border-l border-zinc-700 pl-4"><span className={`absolute -left-1 top-0 h-2 w-2 rounded-full ${item.id.startsWith("payment-") ? "bg-emerald-400" : item.id.startsWith("refund-") ? "bg-rose-400" : item.id === "created" ? "bg-zinc-500" : "bg-brand-primary"}`} /><p className="text-sm font-medium">{item.label}</p>{item.detail ? <p className="mt-1 text-xs text-brand-textMuted">{item.detail}</p> : null}<time className="mt-1 block text-[11px] text-brand-textMuted">{new Date(item.at).toLocaleString()}</time></div>)}
        </div>
      </aside>
      </div>
    </main>
  );
}
