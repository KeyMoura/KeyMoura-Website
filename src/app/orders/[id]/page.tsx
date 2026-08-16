"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { CustomOrderAgreement } from "@/components/legal/TermsNotice";
import { TERMS_VERSION } from "@/lib/legal/terms";
import Link from "next/link";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { moneyFromCents } from "@/lib/orderHub";
import { customerOrderStatus } from "@/lib/commerce/customerOrderView";
import { checkoutAmountCents } from "@/lib/paymentMath";
import { OrderReviewGallery } from "@/components/OrderReviewGallery";
import { OrderLifecycleActions } from "@/components/commerce/OrderLifecycleActions";
import { CustomerOrderOverview } from "@/components/commerce/CustomerOrderOverview";
import { EmptyState, Notice } from "@/components/ui/DesignSystem";

type Order = {
  id: string;
  order_number: string | null;
  product_name: string;
  status: string;
  quantity: number;
  specifications: Record<string, unknown>;
  customer_notes: string | null;
  agreed_price_cents: number | null;
  subtotal_cents: number | null;
  discount_cents: number | null;
  tax_cents: number | null;
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
  order_items?: Array<{ id: string; product_name: string; product_slug: string | null; quantity: number; unit_price_cents: number; line_subtotal_cents: number; selected_options: Record<string, unknown> | null }>;
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
  /** Whether the first read has come back, so "empty" can be told from "not yet". */
  const [loaded, setLoaded] = useState(false);
  const [paymentAvailable, setPaymentAvailable] = useState(true);
  const [updatesAvailable, setUpdatesAvailable] = useState(true);
  const [revisionNote, setRevisionNote] = useState("");
  const [proposalDeclineReason, setProposalDeclineReason] = useState("");
  /*
   * The custom-order clickwrap.
   *
   * Unticked on every load, deliberately: an agreement that is pre-ticked, or
   * that survives a reload, is not an agreement the customer made on this
   * visit. The server refuses the approval without it regardless, so this
   * state only decides whether the button is offered.
   */
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const load = useCallback(async () => {
    const auth = await supabase.auth.getUser();
    setUserId(auth.data.user?.id ?? "");
    const [o, m, h, p, r] = await Promise.all([
      supabase.from("orders").select("id,order_number,product_name,status,quantity,specifications,customer_notes,agreed_price_cents,subtotal_cents,discount_cents,tax_cents,payment_status,amount_paid_cents,deposit_amount_cents,quote_revision,quote_accepted_at,quote_expires_at,amount_refunded_cents,cancellation_reason,target_date,created_at,fulfillment_method,fulfillment_status,shipping_address,pickup_location_snapshot,shipping_method_snapshot,shipping_cents,customer_shipment_note,shipping_carrier,tracking_number,tracking_url,ready_at,picked_up_at,shipped_at,delivered_at,final_review_note,final_review_asset_paths,initiated_by_staff,proposal_sent_at,proposal_decided_at,proposal_decline_reason,order_items(id,product_name,product_slug,quantity,unit_price_cents,line_subtotal_cents,selected_options)").eq("id", id).maybeSingle(),
      supabase
        .from("order_messages")
        .select("id,sender_id,body,is_internal,created_at")
        .eq("order_id", id)
        .eq("is_internal", false)
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
    setPaymentAvailable(!p.error && !r.error);
    setUpdatesAvailable(!m.error && !h.error);
    setError(o.error?.message ?? m.error?.message ?? h.error?.message ?? p.error?.message ?? r.error?.message ?? "");
    setLoaded(true);
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
    const response = await fetch(`/api/orders/${id}/quote`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(data.session?.access_token ? { Authorization: `Bearer ${data.session.access_token}` } : {}),
      },
      // The version travels with the agreement so the server can refuse a stale
      // tab that is still showing last month's Terms.
      body: JSON.stringify({ agreedToTerms: true, termsVersion: TERMS_VERSION }),
    });
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
      <main className="page-container page-stack">
        {!loaded && !error ? (
          <p className="text-brand-textMuted">Loading order…</p>
        ) : (
          /**
           * One wording for every reason this page has no order: it does not
           * exist, it belongs to somebody else, or it was placed as a guest and
           * is reachable only from `/orders/guest/[id]`. This page reads through
           * RLS as the signed-in customer, so all three arrive here identically
           * and must *stay* identical — answering differently would turn the
           * route into a test for whether an order id is real.
           *
           * Previously all three rendered "Loading order…" forever, which told
           * the customer the page was still working when it had already
           * finished.
           */
          <div className="ui-card max-w-xl">
            <h1 className="text-2xl font-semibold">This order is not available</h1>
            <p className="mt-3 text-sm leading-6 text-brand-textMuted">
              We could not open this order on your account. If you placed it as a guest, use the link in your
              confirmation email — guest orders open from the browser you checked out with.
            </p>
            {/* The underlying reason is deliberately not printed. RLS refuses
                this read with "permission denied for table orders", which is a
                schema detail rather than an answer, and showing it for a denial
                but not for a missing row would make the two distinguishable
                again. The sentence above is the whole answer. */}
            <div className="ui-action-row mt-5">
              <Link href="/account/orders" className="ui-btn ui-btn-primary">Your orders</Link>
              <Link href="/support" className="ui-btn ui-btn-ghost">Contact support</Link>
            </div>
          </div>
        )}
      </main>
    );
  const isPendingProposal = order.initiated_by_staff && order.status === "requested";
  const checkoutAmount = checkoutAmountCents(order);
  return (
    <main className="page-container page-stack">
      <Link href="/account/orders" className="text-sm text-brand-textMuted transition hover:text-brand-primary">← Back to your orders</Link>
      <CustomerOrderOverview order={order} items={order.order_items ?? []} paymentAvailable={paymentAvailable} />
      <div id="customer-action" className="scroll-mt-24">
      {isPendingProposal ? <section className="ui-card !border-brand-primary/50 !bg-brand-primary/10"><p className="ui-eyebrow">Order proposal</p><h2 className="mt-2 text-xl font-semibold">Accept, decline, or ask a question</h2><p className="mt-2 text-sm text-brand-textMuted">KeyMoura is offering {order.quantity > 1 ? `${order.quantity} × ` : ""}{order.product_name} for {order.agreed_price_cents != null ? moneyFromCents(order.agreed_price_cents) : "a price to be confirmed"}. Accepting moves it into secure payment and the normal production workflow.</p>{order.customer_notes ? <div className="ui-card mt-4 whitespace-pre-wrap text-sm">{order.customer_notes}</div> : null}<div className="ui-card mt-5"><label className="block text-sm font-medium">Decline reason<textarea value={proposalDeclineReason} onChange={event=>setProposalDeclineReason(event.target.value)} maxLength={1000} placeholder="Tell KeyMoura why this proposal does not work for you…" className="ui-input mt-2 min-h-20" /></label></div><div className="ui-action-row mt-4"><button type="button" disabled={busy || proposalDeclineReason.trim().length < 3} onClick={()=>void decideProposal("decline")} className="ui-btn ui-btn-danger disabled:opacity-40">Decline proposal</button><button type="button" disabled={busy} onClick={()=>void decideProposal("accept")} className="ui-btn ui-btn-primary disabled:opacity-50">{busy ? "Saving…" : "Accept proposal"}</button><a href="#order-conversation" className="ui-btn ui-btn-secondary">Message KeyMoura</a></div></section> : null}
      {order.status === "customer_review" && !order.quote_accepted_at && order.agreed_price_cents ? <section className={`ui-card ${quoteExpired ? "!border-amber-500/50 !bg-amber-500/10" : "!border-brand-primary/50 !bg-brand-primary/10"}`}><p className="ui-eyebrow">Quote revision {order.quote_revision}</p><h2 className="mt-2 text-xl font-semibold">{quoteExpired ? "This quote has expired" : `Review and approve ${moneyFromCents(order.agreed_price_cents)}`}</h2><p className="mt-2 text-sm text-brand-textMuted">{quoteExpired ? "Send a message below to request an updated price and schedule." : <>Approve this quote to unlock secure payment. {order.deposit_amount_cents ? `${moneyFromCents(order.deposit_amount_cents)} is due first; the remaining balance is collected later.` : "The full amount will be due."}{order.quote_expires_at ? ` Valid through ${new Date(order.quote_expires_at).toLocaleDateString()}.` : ""}</>}</p>{!quoteExpired ? <><CustomOrderAgreement checked={agreedToTerms} onChange={setAgreedToTerms} disabled={busy} /><button type="button" disabled={busy || !agreedToTerms} onClick={()=>void approveQuote()} className="ui-btn ui-btn-primary mt-4 disabled:opacity-50">{busy?"Approving…":"Approve quote"}</button></> : null}</section> : null}
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
      <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.4fr_.8fr]">
      <section id="order-conversation" className="ui-card scroll-mt-24">
        <h2 className="text-xl font-semibold">Order chat</h2>
        <p className="mt-1 text-sm text-brand-textMuted">Messages here stay connected to this order.</p>
        <div className="mt-3 space-y-3">
          {!updatesAvailable ? <Notice tone="warning" role="status">Updates unavailable. Your order has not been treated as having no updates.</Notice> : messages.length === 0 ? <EmptyState>No messages yet. Send a question whenever you need help.</EmptyState> : null}
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
          {!updatesAvailable ? <Notice tone="warning" role="status">Updates unavailable. Please try again shortly.</Notice> : null}
          {[...history.map(item => ({ id:`status-${item.id}`, at:item.created_at, label:customerOrderStatus({ status:item.to_status, fulfillment_status:order.fulfillment_status }), detail:null })), ...payments.map(payment => ({ id:`payment-${payment.id}`, at:payment.received_at, label:"Payment received", detail:moneyFromCents(payment.amount_cents) })), ...refunds.map(refund => ({ id:`refund-${refund.id}`, at:refund.created_at, label:"Refund issued", detail:moneyFromCents(refund.amount_cents) })), { id:"created", at:order.created_at, label:"Order received", detail:null }].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).map(item => <div key={item.id} className="relative border-l border-zinc-700 pl-4"><span className={`absolute -left-1 top-0 h-2 w-2 rounded-full ${item.id.startsWith("payment-") ? "bg-emerald-400" : item.id.startsWith("refund-") ? "bg-rose-400" : item.id === "created" ? "bg-zinc-500" : "bg-brand-primary"}`} /><p className="text-sm font-medium">{item.label}</p>{item.detail ? <p className="mt-1 text-xs text-brand-textMuted">{item.detail}</p> : null}<time className="mt-1 block text-[11px] text-brand-textMuted">{new Date(item.at).toLocaleString()}</time></div>)}
        </div>
      </aside>
      </details>
      </div>
    </main>
  );
}
