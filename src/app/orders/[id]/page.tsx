"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { moneyFromCents, orderLabel, orderNeedsCustomerAction, orderNextStep } from "@/lib/orderHub";
import { checkoutAmountCents } from "@/lib/paymentMath";
import { OrderReviewGallery } from "@/components/OrderReviewGallery";
import { OrderLifecycleActions } from "@/components/commerce/OrderLifecycleActions";
import { OrderFulfillmentStatus } from "@/components/commerce/OrderFulfillmentStatus";
import { Badge, EmptyState, Notice, cx } from "@/components/ui/DesignSystem";

const CUSTOMER_STAGES = ["Request", "Quote & payment", "Production", "Review", "Fulfillment", "Complete"] as const;

function customerStageIndex(status: string) {
  if (["requested", "needs_information"].includes(status)) return 0;
  if (["accepted", "customer_review", "awaiting_payment"].includes(status)) return 1;
  if (status === "in_progress") return 2;
  if (status === "final_review") return 3;
  if (status === "ready") return 4;
  return 5;
}

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
  fulfillment_status: string | null;
  shipping_address: Record<string,string> | null;
  pickup_location_snapshot: Record<string, unknown> | null;
  shipping_method_snapshot: Record<string, unknown> | null;
  shipping_cents: number | null;
  customer_shipment_note: string | null;
  shipping_carrier: string | null;
  tracking_number: string | null;
  tracking_url: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  shipped_at: string | null;
  delivered_at: string | null;
  final_review_note: string | null;
  final_review_asset_paths: string[];
  initiated_by_staff: boolean;
  proposal_sent_at: string | null;
  proposal_decided_at: string | null;
  proposal_decline_reason: string | null;
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
  const [proposalDeclineReason, setProposalDeclineReason] = useState("");
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
  async function decideProposal(action:"accept"|"decline") {
    const reason = proposalDeclineReason.trim();
    if (action === "decline" && reason.length < 3) { setError("Please explain why you are declining."); return; }
    const prompt = action === "accept" ? "Accept this proposal and continue to payment?" : "Decline this proposal? This will close it.";
    if (!window.confirm(prompt)) return;
    setBusy(true); setError("");
    const { data } = await supabase.auth.getSession();
    const response = await fetch(`/api/orders/${id}/proposal`, { method:"POST", headers:{ "Content-Type":"application/json", ...(data.session?.access_token ? { Authorization:`Bearer ${data.session.access_token}` } : {}) }, body:JSON.stringify({ action, reason }) });
    const result = await response.json();
    if (!response.ok) setError(result.error || "Could not update proposal."); else { setProposalDeclineReason(""); await load(); }
    setBusy(false);
  }
  if (!order)
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 text-brand-textMuted">
        {error || "Loading order…"}
      </main>
    );
  const isPendingProposal = order.initiated_by_staff && order.status === "requested";
  const needsAction = isPendingProposal || orderNeedsCustomerAction(order);
  const customerStage = customerStageIndex(order.status);
  const isClosed = ["declined", "cancelled"].includes(order.status);
  const checkoutAmount = checkoutAmountCents(order);
  return (
    <main className="page-container page-stack">
      <Link href="/orders" className="text-sm text-brand-textMuted transition hover:text-brand-primary">← Back to your orders</Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
            {order.order_number || "Request pending"}
          </p>
          <h1 className="mt-2 text-3xl font-semibold">{order.product_name}</h1>
        </div>
        <Badge tone="accent" className="px-4 py-2 text-sm">{orderLabel(order.status)}</Badge>
      </div>
      <section className={`ui-card ${needsAction ? "!border-brand-primary/50 !bg-brand-primary/10" : ""}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
        <p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-textMuted">{needsAction ? "Your next step" : "What happens next"}</p>
        <p className={`mt-2 text-lg font-semibold ${needsAction ? "text-brand-primary" : "text-brand-text"}`}>{isPendingProposal ? "Review KeyMoura's proposal" : orderNextStep(order)}</p>
        {order.status === "needs_information" ? <p className="mt-1 text-sm text-brand-textMuted">Send the missing details in order chat below so work can continue.</p> : null}
        </div>
        {needsAction ? <a href="#customer-action" className="ui-btn ui-btn-primary text-sm">Complete this step ↓</a> : null}
        </div>
      </section>

      {!isClosed ? <section className="ui-card" aria-label="Order progress">
        <div className="ui-stepper">{CUSTOMER_STAGES.map((stage, index) => <div key={stage} data-step={index + 1} aria-current={index === customerStage ? "step" : undefined} className={cx("ui-step", index === customerStage && "is-current", index < customerStage && "is-complete")}>{stage}</div>)}</div>
        <p className="mt-4 text-sm text-brand-textMuted">Step {customerStage + 1} of {CUSTOMER_STAGES.length}: <span className="text-brand-text">{CUSTOMER_STAGES[customerStage]}</span></p>
      </section> : null}
      <details className="ui-card !p-0">
        <summary className="cursor-pointer list-none p-5 font-semibold">Order overview <span className="ml-2 text-sm font-normal text-brand-textMuted">price, payment, and target date</span></summary>
      <div className="grid gap-4 border-t border-zinc-800 p-5 sm:grid-cols-3">
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
      </details>
      <div id="customer-action" className="scroll-mt-24">
      {isPendingProposal ? <section className="ui-card !border-brand-primary/50 !bg-brand-primary/10"><p className="ui-eyebrow">Order proposal</p><h2 className="mt-2 text-xl font-semibold">Accept, decline, or ask a question</h2><p className="mt-2 text-sm text-brand-textMuted">KeyMoura is offering {order.quantity > 1 ? `${order.quantity} × ` : ""}{order.product_name} for {order.agreed_price_cents != null ? moneyFromCents(order.agreed_price_cents) : "a price to be confirmed"}. Accepting moves it into secure payment and the normal production workflow.</p>{order.customer_notes ? <div className="ui-card mt-4 whitespace-pre-wrap text-sm">{order.customer_notes}</div> : null}<div className="ui-card mt-5"><label className="block text-sm font-medium">Decline reason<textarea value={proposalDeclineReason} onChange={event=>setProposalDeclineReason(event.target.value)} maxLength={1000} placeholder="Tell KeyMoura why this proposal does not work for you…" className="ui-input mt-2 min-h-20" /></label></div><div className="ui-action-row mt-4"><button type="button" disabled={busy || proposalDeclineReason.trim().length < 3} onClick={()=>void decideProposal("decline")} className="ui-btn ui-btn-danger disabled:opacity-40">Decline proposal</button><button type="button" disabled={busy} onClick={()=>void decideProposal("accept")} className="ui-btn ui-btn-primary disabled:opacity-50">{busy ? "Saving…" : "Accept proposal"}</button><a href="#order-conversation" className="ui-btn ui-btn-secondary">Message KeyMoura</a></div></section> : null}
      {order.status === "customer_review" && !order.quote_accepted_at && order.agreed_price_cents ? <section className={`ui-card ${quoteExpired ? "!border-amber-500/50 !bg-amber-500/10" : "!border-brand-primary/50 !bg-brand-primary/10"}`}><p className="ui-eyebrow">Quote revision {order.quote_revision}</p><h2 className="mt-2 text-xl font-semibold">{quoteExpired ? "This quote has expired" : `Review and approve ${moneyFromCents(order.agreed_price_cents)}`}</h2><p className="mt-2 text-sm text-brand-textMuted">{quoteExpired ? "Send a message below to request an updated price and schedule." : <>Approve this quote to unlock secure payment. {order.deposit_amount_cents ? `${moneyFromCents(order.deposit_amount_cents)} is due first; the remaining balance is collected later.` : "The full amount will be due."}{order.quote_expires_at ? ` Valid through ${new Date(order.quote_expires_at).toLocaleDateString()}.` : ""}</>}</p>{!quoteExpired ? <button type="button" disabled={busy} onClick={()=>void approveQuote()} className="ui-btn ui-btn-primary mt-4 disabled:opacity-50">{busy?"Approving…":"Approve quote"}</button> : null}</section> : null}
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
            className="ui-btn ui-btn-primary mt-4 disabled:opacity-50"
          >
            {busy ? "Opening checkout…" : `Pay ${moneyFromCents(checkoutAmount)}`}
          </button>
        </div>
      ) : null}
      </div>
      <OrderLifecycleActions orderId={id} onChanged={() => void load()} />
      <details className="ui-card !p-0">
        <summary className="cursor-pointer list-none p-5 font-semibold">Request details <span className="ml-2 text-sm font-normal text-brand-textMuted">quantity, options, and original notes</span></summary>
      <section className="border-t border-zinc-800 p-5">
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
      </details>
      {/*
        Delivery, driven by `fulfillment_status` rather than by inspecting
        timestamps. The block this replaces rendered only for pickup orders or
        once a tracking number existed, so an order being packed showed nothing
        and every direct purchase had no delivery section at all.
      */}
      <OrderFulfillmentStatus order={order} />
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_.8fr]">
      <section id="order-conversation" className="ui-card scroll-mt-24">
        <h2 className="text-xl font-semibold">Order chat</h2>
        <p className="mt-1 text-sm text-brand-textMuted">Messages here stay connected to this order.</p>
        <div className="mt-3 space-y-3">
          {messages.length === 0 ? <EmptyState>No messages yet. Send a question whenever you need help.</EmptyState> : null}
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
            className="ui-input min-h-20 flex-1"
          />
          <button
            disabled={busy}
            className="ui-btn ui-btn-primary px-5 disabled:opacity-50"
          >
            Send
          </button>
        </form>
        {error ? <Notice tone="danger" role="alert" className="mt-3">{error}</Notice> : null}
      </section>
      <details className="rounded-2xl border border-zinc-800 bg-black/30">
        <summary className="cursor-pointer list-none p-5 font-semibold">Activity <span className="ml-2 text-sm font-normal text-brand-textMuted">order history</span></summary>
        <aside className="border-t border-zinc-800 p-5">
        <div className="mt-4 space-y-4">
          {[...history.map(item => ({ id:`status-${item.id}`, at:item.created_at, label:orderLabel(item.to_status), detail:item.note })), ...payments.map(payment => ({ id:`payment-${payment.id}`, at:payment.received_at, label:"Payment received", detail:moneyFromCents(payment.amount_cents) })), ...refunds.map(refund => ({ id:`refund-${refund.id}`, at:refund.created_at, label:"Refund issued", detail:`${moneyFromCents(refund.amount_cents)} — ${refund.reason}` })), { id:"created", at:order.created_at, label:"Request submitted", detail:null }].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).map(item => <div key={item.id} className="relative border-l border-zinc-700 pl-4"><span className={`absolute -left-1 top-0 h-2 w-2 rounded-full ${item.id.startsWith("payment-") ? "bg-emerald-400" : item.id.startsWith("refund-") ? "bg-rose-400" : item.id === "created" ? "bg-zinc-500" : "bg-brand-primary"}`} /><p className="text-sm font-medium">{item.label}</p>{item.detail ? <p className="mt-1 text-xs text-brand-textMuted">{item.detail}</p> : null}<time className="mt-1 block text-[11px] text-brand-textMuted">{new Date(item.at).toLocaleString()}</time></div>)}
        </div>
      </aside>
      </details>
      </div>
    </main>
  );
}
