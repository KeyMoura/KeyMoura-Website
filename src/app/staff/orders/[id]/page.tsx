"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { StaffOrderWorkspace } from "@/components/staff/StaffOrderWorkspace";
import { OrderProductionJobs } from "@/components/staff/production/OrderProductionJobs";
import { OrderReviewGallery } from "@/components/OrderReviewGallery";
import { Badge, Notice, cx } from "@/components/ui/DesignSystem";
import { OrderLifecyclePanel } from "@/components/staff/OrderLifecyclePanel";
import { OrderFulfillmentPanel } from "@/components/staff/OrderFulfillmentPanel";
import {
  ConsequentialAction,
  resultFromResponse,
  type ActionResult,
} from "@/components/staff/ConsequentialAction";
import {
  classifySupabaseError,
  fromSupabase,
  isFailed,
  isTrulyEmpty,
  loading as loadingState,
  rowsOrNull,
  type LoadState,
} from "@/lib/staff/loadState";

/**
 * One section's failure, stated in the section.
 *
 * A page-level banner is not enough when the panels underneath keep rendering:
 * a staff member scanning an order workspace reads the panel, not the sentence
 * at the bottom of the page.
 */
function SectionFailure({ state, what }: { state: LoadState<unknown>; what: string }) {
  if (!isFailed(state)) return null;
  return (
    <Notice tone="danger" role="alert" className="mt-3">
      {what} could not be loaded, so nothing is shown here. This is not the same as there being none —
      {" "}{state.failure.message}
    </Notice>
  );
}

/**
 * A settled quote is not editable.
 *
 * This was `payment_status === "paid"`, which stopped being the right question
 * once the column gained `partially_refunded` and `refunded`: a paid order that
 * was partly refunded would have become editable again, letting its price be
 * rewritten underneath money that had already changed hands.
 */
const quoteLocked = (order: { payment_status: string }) =>
  ["paid", "partially_refunded", "refunded"].includes(order.payment_status);

type Order = {
  id: string;
  order_number: string | null;
  customer_id: string;
  product_id: string | null;
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
const requestedEstimateCents = (order: Order) => {
  const value = order.specifications?.estimated_total_cents;
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
};
const optionAdjustmentCents = (order: Order) =>
  Object.entries(order.specifications || {}).reduce((sum, [key, raw]) => {
    if (key === "estimated_total_cents" || !raw || typeof raw !== "object") return sum;
    const adjustment = (raw as { price_adjustment_cents?: unknown }).price_adjustment_cents;
    return sum + (typeof adjustment === "number" && Number.isFinite(adjustment) ? Math.round(adjustment) : 0);
  }, 0);
const nextStaffStep = (order: Order) => {
  if (order.status === "requested") return { title: "Review the request", detail: "Confirm the specifications, then prepare and send the customer quote.", href: "#quote" };
  if (order.status === "needs_information") return { title: "Waiting for customer information", detail: "Use the conversation to follow up if the customer has not replied.", href: "#conversation" };
  if (order.status === "accepted") return { title: "Prepare the quote", detail: "The request is accepted. Set the customer price, deposit, schedule, and send the quote for approval.", href: "#quote" };
  if (order.status === "awaiting_payment") return { title: "Waiting for payment", detail: "The quote is approved. Production begins automatically when the required payment is received.", href: "#activity" };
  if (order.status === "customer_review") return { title: "Waiting for quote approval", detail: "The customer needs to approve the current quote before checkout.", href: "#quote" };
  if (order.status === "in_progress") return { title: "Complete production", detail: "Use the production workspace, then send the finished product for customer review.", href: "#production" };
  if (order.status === "final_review") return { title: "Waiting for finished-product approval", detail: "The customer is reviewing the finished product. Fulfillment unlocks after approval.", href: "#fulfillment" };
  if (order.status === "ready") return { title: order.fulfillment_method === "pickup" ? "Prepare customer pickup" : "Ship the order", detail: "Confirm the balance is paid, then complete the fulfillment action below.", href: "#fulfillment" };
  if (order.status === "completed") return { title: "Order complete", detail: "No action is required. The full record remains available below.", href: "#activity" };
  if (order.status === "declined" || order.status === "cancelled") return { title: statusLabel(order.status), detail: "No normal workflow action is pending. Review payment and refund records if needed.", href: "#activity" };
  return { title: "Review this order", detail: "Check the order details and choose the appropriate next action.", href: "#quote" };
};
const workflowSteps = [
  { label: "Request", statuses: ["requested", "needs_information"] },
  { label: "Quote", statuses: ["accepted"] },
  { label: "Approval & payment", statuses: ["customer_review", "awaiting_payment"] },
  { label: "Production", statuses: ["in_progress"] },
  { label: "Customer review", statuses: ["final_review"] },
  { label: "Fulfillment", statuses: ["ready", "completed"] },
] as const;
const workflowStepIndex = (status: string) => {
  const index = workflowSteps.findIndex((step) => (step.statuses as readonly string[]).includes(status));
  return index < 0 ? 0 : index;
};
export default function StaffOrderDetail() {
  const { id } = useParams<{ id: string }>();
  const supabase = useMemo(() => supabaseBrowser(), []);
  const { data: access, isLoading } = useMeAccess();
  const perms = new Set(access?.permissions ?? []);
  const canView = perms.has("orders.view") || perms.has("orders.manage");
  const canManage = perms.has("orders.manage");
  const [order, setOrder] = useState<Order | null>(null);
  /*
   * Six independent loads, six independent states.
   *
   * These used to be six `useState<T[]>([])` filled with `result.data ?? []`
   * and one shared `error` string built by `??`-chaining the six messages. That
   * had three separate consequences on a page that shows money:
   *
   * 1. A failed payments query rendered as *no payments*, which on an order
   *    workspace reads as "this customer has not paid".
   * 2. The activity timeline is assembled from four of these lists, so one
   *    failed source silently vanished from the history and the timeline still
   *    looked complete and chronological.
   * 3. Only the first failure was shown, with a raw Postgres message, and
   *    nothing said which section it belonged to.
   *
   * `LoadState` makes (1) and (2) unrepresentable — rows cannot be read without
   * narrowing to `ready` — and the panels below name their own failure.
   */
  const [messages, setMessages] = useState<LoadState<Message[]>>(loadingState<Message[]>());
  const [emails, setEmails] = useState<LoadState<EmailDelivery[]>>(loadingState<EmailDelivery[]>());
  const [history, setHistory] = useState<LoadState<History[]>>(loadingState<History[]>());
  const [payments, setPayments] = useState<LoadState<Payment[]>>(loadingState<Payment[]>());
  const [refunds, setRefunds] = useState<LoadState<Refund[]>>(loadingState<Refund[]>());
  const [body, setBody] = useState("");
  const [internal, setInternal] = useState(false);
  const [price, setPrice] = useState("");
  const [paid, setPaid] = useState("");
  const [deposit, setDeposit] = useState("");
  const [quoteNote, setQuoteNote] = useState("");
  const [quoteExpires, setQuoteExpires] = useState("");
  const [target, setTarget] = useState("");
  const [staffNotes, setStaffNotes] = useState("");
  const [error, setError] = useState("");
  const [pendingStatus, setPendingStatus] = useState("");
  const [reviewNote, setReviewNote] = useState("");
  const [reviewFiles, setReviewFiles] = useState<File[]>([]);
  const [savingInternal, setSavingInternal] = useState(false);
  const [sending, setSending] = useState(false);
  /**
   * Minted once per composed message and cleared when it lands. Retrying the
   * same text reuses it; a genuinely new message gets a new one.
   */
  const [messageToken, setMessageToken] = useState("");
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
    setMessages(fromSupabase<Message>(m as never));
    setEmails(fromSupabase<EmailDelivery>(e as never));
    setHistory(fromSupabase<History>(h as never));
    setPayments(fromSupabase<Payment>(p as never));
    setRefunds(fromSupabase<Refund>(r as never));
    if (row) {
      const initialCustomerPrice = row.agreed_price_cents ?? requestedEstimateCents(row);
      setPrice(initialCustomerPrice == null ? "" : String(initialCustomerPrice / 100));
      setPaid(String(row.amount_paid_cents / 100));
      setDeposit(row.deposit_amount_cents == null ? "" : String(row.deposit_amount_cents / 100));
      setQuoteExpires(row.quote_expires_at?.slice(0, 10) ?? "");
      setTarget(row.target_date ?? "");
      setStaffNotes(row.staff_notes ?? "");
      setReviewNote(row.final_review_note ?? "");
      // The refund amount is no longer seeded here. It lives in
      // OrderLifecyclePanel, which computes what is refundable server-side with
      // pending refunds already subtracted — this local subtraction did not
      // know about refunds still in flight.
    }
    /*
     * Only the order's own failure becomes the page-level error, and it is
     * classified rather than echoed — a Postgres message names schema objects
     * and can quote row values. The other five report inside their own panels,
     * because "which section is missing" is the thing a staff member needs to
     * know and a single chained string cannot say it.
     */
    setError(o.error ? classifySupabaseError(o.error).message : "");
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
  /**
   * Every write to the order row, through one place.
   *
   * The two things that make it safe are here rather than at each call site, so
   * a control added later cannot forget them:
   *
   * - **`expected_status`** is always sent. The route puts it in the `WHERE`
   *   clause, so a colleague's change that landed since this page rendered is a
   *   409 rather than a silent overwrite.
   * - **A 409 becomes a conflict**, which `ConsequentialAction` shows in place
   *   and refuses to retry. Retrying a consequential action against state that
   *   has moved is the failure this whole pass is about.
   */
  const patchOrder = useCallback(
    async (payload: Record<string, unknown>): Promise<ActionResult> => {
      if (!order) return { ok: false, error: "The order is not loaded." };
      const response = await fetch(`/api/staff/orders/${id}`, {
        method: "PATCH",
        headers: await authHeaders(),
        body: JSON.stringify({ expected_status: order.status, ...payload }),
      });
      const result = await resultFromResponse(response, "Could not update the order.");
      if (result.ok) await load();
      return result;
    },
    // `authHeaders` is stable enough for this — it reads the session on every
    // call rather than closing over one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [id, order, load]
  );

  async function changeStatus(status: string, reason: string): Promise<ActionResult> {
    const result = await patchOrder({
      status,
      cancellation_reason: status === "cancelled" ? reason : undefined,
    });
    if (result.ok) setPendingStatus("");
    return result;
  }

  /**
   * Sending a new quote.
   *
   * Carries `expected_quote_revision` on top of the status guard, because two
   * staff repricing the same order never change its status — they both sit on
   * `accepted` — so a status comparison alone would let the second price win
   * silently. The customer would then be quoted a number nobody chose.
   */
  async function sendQuote(): Promise<ActionResult> {
    return patchOrder({
      expected_quote_revision: order?.quote_revision ?? 0,
      agreed_price_cents: price.trim() ? Math.round(Number(price) * 100) : null,
      deposit_amount_cents: deposit.trim() ? Math.round(Number(deposit) * 100) : null,
      quote_note: quoteNote.trim() || null,
      quote_expires_at: quoteExpires ? new Date(`${quoteExpires}T23:59:59.999Z`).toISOString() : null,
      target_date: target || null,
      staff_notes: staffNotes || null,
    });
  }

  /**
   * Saving details that no customer ever sees.
   *
   * Deliberately not a confirmed action: an internal note and a target date
   * change nothing outside the shop, and putting a dialog in front of them would
   * teach staff to click through dialogs. It still takes the status guard and
   * still disables while saving.
   */
  async function saveInternal() {
    if (savingInternal) return;
    setSavingInternal(true);
    setError("");
    const result = await patchOrder({
      target_date: target || null,
      staff_notes: staffNotes || null,
      quote_expires_at: quoteExpires ? new Date(`${quoteExpires}T23:59:59.999Z`).toISOString() : null,
    });
    if (!result.ok) setError("conflict" in result ? result.conflict.message : result.error);
    setSavingInternal(false);
  }
  async function sendForReview(): Promise<ActionResult> {
    if (!order || reviewNote.trim().length < 3 || reviewFiles.length < 1) {
      return { ok: false, error: "Add a customer note and at least one finished-product photo." };
    }
    const uploaded: string[] = [];
    for (const file of reviewFiles) {
      const extension = file.name.split(".").pop()?.replace(/[^a-z0-9]/gi, "").toLowerCase() || "jpg";
      const path = `${order.customer_id}/${order.id}/final-review/${crypto.randomUUID()}.${extension}`;
      const { error: uploadError } = await supabase.storage.from("order-assets").upload(path, file, { contentType:file.type, upsert:false });
      // The upload message is the storage layer's own and names the file the
      // operator chose, so it is safe to show and genuinely useful.
      if (uploadError) return { ok: false, error: `Could not upload ${file.name}: ${uploadError.message}` };
      uploaded.push(path);
    }
    const result = await patchOrder({
      status: "final_review",
      final_review_note: reviewNote.trim(),
      final_review_asset_paths: uploaded,
    });
    if (result.ok) setReviewFiles([]);
    return result;
  }

  /**
   * One send, one message.
   *
   * The token is minted when the text is composed and reused for every attempt
   * at that same text, so a double click, a retried fetch and a resubmitted form
   * all collapse into the first message at the unique index. `sending` stops the
   * common case in the browser; the token is what actually holds.
   */
  async function send() {
    if (sending || !body.trim()) return;
    setSending(true);
    setError("");
    const token = messageToken || crypto.randomUUID();
    setMessageToken(token);
    const response = await fetch(`/api/orders/${id}/messages`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ body: body.trim(), internal, client_token: token }),
    });
    const result = await resultFromResponse(response, "Could not send the message.");
    if (!result.ok) setError("conflict" in result ? result.conflict.message : result.error);
    else {
      setBody("");
      setMessageToken("");
      await load();
    }
    setSending(false);
    return result;
  }
  if (isLoading) return <div className="ui-card">Loading…</div>;
  if (!canView)
    return <AccessDeniedCard message="You do not have access to orders." />;
  if (!order)
    return <p className="text-rose-200">{error || "Order not found."}</p>;
  const input = "ui-input";
  const nextStep = nextStaffStep(order);
  /*
   * Which of the timeline's four sources are missing.
   *
   * Named in the order they appear so the notice reads the way the list does.
   * Payments and refunds are called out by name rather than as "some data",
   * because a missing payment entry is the one omission that changes what a
   * staff member believes about money.
   */
  const missingTimelineSources = [
    isFailed(history) ? "status history" : null,
    isFailed(messages) ? "messages" : null,
    isFailed(payments) ? "payments" : null,
    isFailed(refunds) ? "refunds" : null,
  ].filter((source): source is string => source !== null);
  const activeStep = workflowStepIndex(order.status);
  const isClosed = order.status === "cancelled" || order.status === "declined";
  const requestedTotalCents = requestedEstimateCents(order);
  const requestedOptionTotalCents = optionAdjustmentCents(order) * order.quantity;
  const requestedBaseTotalCents = requestedTotalCents == null ? null : requestedTotalCents - requestedOptionTotalCents;
  return (
    <main className="page-stack">
      <header className="ui-card p-5 sm:p-7">
        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[.2em] text-brand-primary">{order.order_number || "Request pending"}</p><h1 className="mt-2 text-3xl font-semibold">{order.product_name}</h1><p className="mt-2 text-sm text-brand-textMuted">Quantity {order.quantity} · Submitted {new Date(order.created_at).toLocaleDateString()}</p></div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="ui-card !p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Status</p><p className="mt-1 text-sm font-semibold text-brand-primary">{statusLabel(order.status)}</p></div>
            <div className="ui-card !p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Customer price</p><p className="mt-1 text-sm font-semibold">{order.agreed_price_cents == null ? "Not quoted" : `$${(order.agreed_price_cents/100).toFixed(2)}`}</p></div>
            <div className="ui-card !p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Net paid</p><p className="mt-1 text-sm font-semibold text-emerald-300">${((order.amount_paid_cents-(order.amount_refunded_cents||0))/100).toFixed(2)}</p>{order.amount_refunded_cents ? <p className="text-[10px] text-brand-textMuted">${(order.amount_refunded_cents/100).toFixed(2)} refunded</p> : null}</div>
            <div className="ui-card !p-3"><p className="text-[10px] uppercase tracking-wider text-brand-textMuted">Balance</p><p className="mt-1 text-sm font-semibold">${(Math.max(0,(order.agreed_price_cents || 0)-order.amount_paid_cents)/100).toFixed(2)}</p></div>
          </div>
        </div>
      </header>
      <div className="ui-card !border-brand-primary/35 !bg-brand-primary/10 sm:flex sm:items-center sm:justify-between sm:gap-5">
        <div><p className="text-xs font-semibold uppercase tracking-[.16em] text-brand-primary">Next step</p><h2 className="mt-1 text-lg font-semibold">{nextStep.title}</h2><p className="mt-1 text-sm text-brand-textMuted">{nextStep.detail}</p></div>
        <div className="mt-4 flex shrink-0 flex-wrap gap-2 sm:mt-0">
          {(order.status === "requested" || order.status === "needs_information") && canManage ? <>
            <a href="#conversation" className="ui-btn ui-btn-secondary">Message customer</a>
            <ConsequentialAction
              label="Cancel request"
              title="Cancel this request?"
              summary="The request is closed and the customer is told. This does not move any money — a refund is issued separately from the lifecycle panel."
              currentState={statusLabel(order.status)}
              nextState="Cancelled"
              tone="danger"
              confirmLabel="Cancel the request"
              reason={{
                label: "Why is this being cancelled?",
                placeholder: "Kept with the order and shown to the customer.",
                required: true,
                help: "Stored on the order permanently and included in what the customer is told.",
              }}
              effects={{
                customer: "The order reads Cancelled on their order page.",
                financial: order.amount_paid_cents
                  ? `No refund is issued here. ${`$${(order.amount_paid_cents / 100).toFixed(2)}`} remains collected until you refund it below.`
                  : null,
                inventory: null,
                notification: "“Order cancelled”, with the reason above.",
              }}
              onConfirm={({ reason }) => changeStatus("cancelled", reason)}
            />
            <ConsequentialAction
              label="Accept & continue"
              title="Accept this request?"
              summary="Moves the request into quoting. The customer is told you have taken it on; no price is sent yet."
              currentState={statusLabel(order.status)}
              nextState="Accepted"
              confirmLabel="Accept the request"
              effects={{
                customer: "The order reads Accepted, with quote and payment details to follow.",
                financial: null,
                inventory: null,
                notification: "“Order request accepted”.",
              }}
              onConfirm={() => changeStatus("accepted", "")}
            />
          </> : null}
          {order.status === "in_progress" && canManage ? <a href="#customer-review-package" className="ui-btn ui-btn-primary">Prepare customer review</a> : null}
          {order.status !== "requested" && order.status !== "needs_information" && order.status !== "in_progress" ? <a href={nextStep.href} className="ui-btn ui-btn-primary">{order.status === "accepted" ? "Continue to quote" : "View current stage"}</a> : null}
        </div>
      </div>
      <nav className="ui-card overflow-x-auto" aria-label="Order workflow">
        <ol className="ui-stepper min-w-[680px]">
          {workflowSteps.map((step, index) => {
            const complete = !isClosed && index < activeStep;
            const active = !isClosed && index === activeStep;
            return <li key={step.label} data-step={index + 1} aria-current={active ? "step" : undefined} className={cx("ui-step", active && "is-current", complete && "is-complete")}>{step.label}</li>;
          })}
        </ol>
      </nav>
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        <div id="production" className="scroll-mt-5 lg:col-span-2">
          <StaffOrderWorkspace orderId={id} canManage={canManage} />
        </div>
        <div id="shop-work" className="scroll-mt-5 lg:col-span-2">
          <OrderProductionJobs
            orderId={id}
            productId={order.product_id}
            customerId={order.customer_id}
            productName={order.product_name}
          />
        </div>
        {order.status === "in_progress" && canManage ? <section id="customer-review-package" className="scroll-mt-5 rounded-2xl border border-amber-400/35 bg-amber-400/5 p-5 lg:col-span-2">
          <p className="text-xs font-semibold uppercase tracking-[.16em] text-amber-300">Next · Customer review</p>
          <h2 className="mt-1 text-xl font-semibold">Show the customer the finished work</h2>
          <p className="mt-2 text-sm text-brand-textMuted">Add the photos and note the customer should review. Nothing is sent until you confirm below.</p>
          <label className="mt-5 block text-sm font-medium">Finished-product photos
            <input type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple onChange={event=>setReviewFiles(Array.from(event.target.files || []).slice(0,6))} className="mt-2 block w-full rounded-xl border border-dashed border-zinc-700 bg-black/30 px-4 py-5 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-white" />
            <span className="mt-1 block text-xs text-brand-textMuted">Up to 6 photos. These are private to staff and this customer.</span>
          </label>
          {reviewFiles.length ? <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">{reviewFiles.map((file,index)=><div key={`${file.name}-${index}`} className="rounded-xl border border-zinc-700 bg-black/30 p-3"><p className="truncate text-sm font-medium">{file.name}</p><p className="mt-1 text-xs text-brand-textMuted">{(file.size/1024/1024).toFixed(1)} MB</p></div>)}</div> : null}
          <label className="mt-5 block text-sm font-medium">Note to customer<textarea value={reviewNote} onChange={event=>setReviewNote(event.target.value)} maxLength={3000} className={`${input} mt-2 min-h-28 w-full`} placeholder="Here is the finished piece. Please review the photos, finish, color, and details…" /></label>
          <div className="mt-5 rounded-xl border border-zinc-800 bg-black/30 p-4"><p className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">Customer preview</p><p className="mt-2 whitespace-pre-wrap text-sm">{reviewNote.trim() || "Your note will appear here."}</p><p className="mt-3 text-xs text-brand-textMuted">{reviewFiles.length ? `${reviewFiles.length} photo${reviewFiles.length === 1 ? "" : "s"} attached` : "No photos attached yet"}</p></div>
          <ConsequentialAction
            className="mt-5"
            label="Send to customer"
            title="Send the finished product for approval?"
            summary={`${reviewFiles.length} photo${reviewFiles.length === 1 ? "" : "s"} and your note go to the customer. Fulfillment unlocks once they approve.`}
            currentState={statusLabel(order.status)}
            nextState="Finished Product Review"
            confirmLabel="Send for approval"
            disabled={reviewFiles.length < 1 || reviewNote.trim().length < 3}
            disabledReason={
              reviewFiles.length < 1 || reviewNote.trim().length < 3
                ? "Add a note and at least one photo first."
                : null
            }
            effects={{
              customer: "They see the photos and your note, and can approve or ask for revisions.",
              financial: null,
              inventory: null,
              notification: "“Finished product ready for review”.",
            }}
            notificationPreview={reviewNote.trim()}
            onConfirm={() => sendForReview()}
          />
        </section> : null}
        {order.status === "final_review" ? <section className="ui-card lg:col-span-2"><p className="ui-eyebrow">Sent to customer</p><h2 className="mt-1 text-xl font-semibold">Finished-product review package</h2>{order.final_review_note ? <p className="mt-3 whitespace-pre-wrap text-sm text-brand-textMuted">{order.final_review_note}</p> : null}<OrderReviewGallery paths={order.final_review_asset_paths || []} /></section> : null}
        <OrderLifecyclePanel orderId={id} productName={order.product_name} />
        <section id="quote" className="ui-card -order-1 scroll-mt-5 lg:col-span-2">
          <div className="flex items-start justify-between gap-4"><div><p className="ui-eyebrow">Customer quote</p><h2 className="mt-1 text-xl font-semibold">Price & schedule</h2></div><Badge>Revision {order.quote_revision}</Badge></div>
          <p className="mt-2 text-sm leading-6 text-brand-textMuted">This is the final price the customer pays—not your material or labor cost. Internal costs stay in the Production workspace.</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              Total customer price ($)
              <input
                disabled={!canManage || quoteLocked(order)}
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
              <input disabled={!canManage || quoteLocked(order)} className={`${input} mt-1 w-full`} type="number" min="0.5" step=".01" value={deposit} onChange={(e)=>setDeposit(e.target.value)} placeholder="Blank = collect full price" />
              <span className="mt-1 block text-[10px] text-brand-textMuted">Leave blank to collect the full quote. Editing price or deposit creates a new quote revision.</span>
            </label>
            <label className="text-sm sm:col-span-2">Quote note<textarea disabled={!canManage} className={`${input} mt-1 min-h-20 w-full`} value={quoteNote} onChange={e=>setQuoteNote(e.target.value)} placeholder="What changed or what is included in this quote?" /></label>
            <label className="text-sm">Quote valid through<input disabled={!canManage || quoteLocked(order)} className={`${input} mt-1 w-full`} type="date" value={quoteExpires} onChange={e=>setQuoteExpires(e.target.value)} /><span className="mt-1 block text-[10px] text-brand-textMuted">Checkout is blocked after this date until a new quote is sent.</span></label>
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
          {/*
            Two buttons, because these are two different actions.

            One button whose label changed between "Review & send quote" and
            "Save internal details" depending on whether a number had been typed
            meant the consequence of pressing it depended on a field above it.
            Sending a customer a price and jotting a target date are not the same
            act and no longer share a control.
          */}
          {canManage ? (
            <div className="ui-action-row mt-4">
              <button
                type="button"
                onClick={() => void saveInternal()}
                disabled={savingInternal}
                className="ui-btn ui-btn-secondary disabled:cursor-not-allowed disabled:opacity-40"
              >
                {savingInternal ? "Saving…" : "Save internal details"}
              </button>
              <ConsequentialAction
                label="Send quote"
                title={`Send quote revision ${(order.quote_revision ?? 0) + 1}?`}
                summary="This is the price the customer pays. It moves the order to Quote Review and asks them to approve it. Material and labour costs are internal and are not this number."
                currentState={statusLabel(order.status)}
                nextState="Quote Review"
                confirmLabel="Send the quote"
                disabled={quoteLocked(order) || !price.trim() || Number(price) <= 0}
                disabledReason={
                  quoteLocked(order)
                    ? "This order has been paid, so its price cannot be rewritten."
                    : !price.trim() || Number(price) <= 0
                      ? "Enter a customer price first."
                      : null
                }
                effects={{
                  customer: `They are asked to approve ${price.trim() ? `$${(Math.round(Number(price) * 100) / 100).toFixed(2)}` : "the quote"}${deposit.trim() ? `, paying $${Number(deposit).toFixed(2)} up front` : ""}.`,
                  financial: "Nothing is charged now. The customer pays at checkout after approving.",
                  inventory: null,
                  notification: "“Quote ready for review”, with the amount.",
                }}
                notificationPreview={quoteNote.trim() || undefined}
                onConfirm={() => sendQuote()}
              />
            </div>
          ) : null}
          {/* Refunds, cancellations and returns moved into OrderLifecyclePanel
              below. They used to be three unrelated controls in three places;
              refunding sensibly means seeing the production and fulfillment
              state at the same moment. */}
          <dl className="mt-5 grid gap-3 border-t border-zinc-800 pt-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-brand-textMuted">Item</dt>
              <dd className="mt-0.5 font-medium">{order.product_name}</dd>
            </div>
            <div>
              <dt className="text-brand-textMuted">Base item price</dt>
              <dd className="mt-0.5">
                {requestedBaseTotalCents == null
                  ? "Price pending"
                  : "$" + (requestedBaseTotalCents / 100).toFixed(2) + (order.quantity > 1 ? " ($" + (requestedBaseTotalCents / order.quantity / 100).toFixed(2) + " each)" : "")}
              </dd>
            </div>
            <div>
              <dt className="text-brand-textMuted">Quantity</dt>
              <dd>{order.quantity}</dd>
            </div>
            <div>
              <dt className="text-brand-textMuted">Requested total</dt>
              <dd className="mt-0.5 font-semibold text-brand-primary">{requestedTotalCents == null ? "Quoted after review" : "$" + (requestedTotalCents / 100).toFixed(2)}</dd>
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
        {/*
          The fulfillment control.

          This replaces a local form that posted `shipment_action` to
          `PATCH /api/staff/orders/[id]`. That path set `shipped_at` and moved
          `orders.status`, but never wrote `orders.fulfillment_status` — the
          column the cancellation and return eligibility rules actually read —
          so a shipped order stayed "unfulfilled" to every rule that asked, and
          still looked cancellable. The panel drives the pass-8 state machine,
          which enforces the transition graph, the method narrowing, the
          tracking requirement and the balance guard server-side.

          It is always mounted rather than gated on `status === "ready"`: a
          direct purchase never passes through `ready`, and gating on it is why
          direct purchases had no fulfillment surface at all.
        */}
        <OrderFulfillmentPanel orderId={id} canManage={canManage} onChanged={() => void load()} />
        <section id="conversation" className="scroll-mt-5">
          <h2 className="font-semibold">Conversation</h2>
          <SectionFailure state={messages} what="The conversation" />
          <div className="mt-3 max-h-[480px] space-y-3 overflow-y-auto">
            {(rowsOrNull(messages) ?? []).map((m) => (
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
          {/*
            The checkbox decided whether text left the building, and the button
            said "Send" either way. Now the choice repaints the composer — the
            border, the label under it and the button all change — so which of
            the two things you are about to do is readable without re-reading the
            checkbox.
          */}
          {canManage ? (
            <div className="mt-3">
              <textarea
                className={cx(
                  input,
                  "min-h-24 w-full",
                  internal ? "!border-sky-500/50" : "!border-brand-primary/40"
                )}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder={internal ? "Note for staff only…" : "Reply to the customer…"}
                aria-label={internal ? "Internal note" : "Message to the customer"}
              />
              <label className="mt-2 flex items-center gap-2 text-xs text-brand-textMuted">
                <input
                  type="checkbox"
                  checked={internal}
                  onChange={(e) => setInternal(e.target.checked)}
                />{" "}
                Internal note (customer cannot see)
              </label>
              <p className="mt-1 text-xs">
                {internal ? (
                  <span className="text-sky-300">Stays on this order. No email, no notification.</span>
                ) : (
                  <span className="text-amber-200">The customer reads this and is emailed a copy.</span>
                )}
              </p>
              <div className="ui-action-row mt-3">
                {internal ? (
                  <button
                    type="button"
                    onClick={() => void send()}
                    disabled={sending || !body.trim()}
                    className="ui-btn ui-btn-secondary disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {sending ? "Saving…" : "Save internal note"}
                  </button>
                ) : (
                  <ConsequentialAction
                    label="Send to customer"
                    title="Send this message to the customer?"
                    summary="It appears on their order page and is emailed to them. A sent message cannot be unsent."
                    confirmLabel="Send the message"
                    disabled={!body.trim()}
                    disabledReason={!body.trim() ? "Write the message first." : null}
                    effects={{
                      customer: "The message appears in their order conversation.",
                      financial: null,
                      inventory: null,
                      notification: "“New order message”, with a link to the order.",
                    }}
                    notificationPreview={body.trim()}
                    onConfirm={async () => (await send()) ?? { ok: true }}
                  />
                )}
              </div>
            </div>
          ) : null}
        </section>
        <section id="activity" className="scroll-mt-5 md:col-span-2">
          <h2 className="font-semibold">Activity timeline</h2>
          {/*
            A timeline assembled from four independent sources is the one place
            a partial failure is genuinely invisible: the entries that did load
            still render in order and still look like a complete history. So the
            sources that failed are named *above* the timeline, and the timeline
            is explicitly labelled incomplete rather than being left to imply
            that nothing else happened.
          */}
          {missingTimelineSources.length ? (
            <Notice tone="warning" role="status" className="mt-3">
              This timeline is incomplete: {missingTimelineSources.join(", ")} could not be loaded. Entries of that kind
              are missing from the list below — they are not absent from the order.
            </Notice>
          ) : null}
          <div className="mt-3 space-y-2 rounded-xl border border-zinc-800 p-4">
            {[...(rowsOrNull(history) ?? []).map(item=>({id:`h-${item.id}`,at:item.created_at,label:`Status changed to ${pretty(item.to_status)}`,detail:item.note})),...(rowsOrNull(messages) ?? []).map(item=>({id:`m-${item.id}`,at:item.created_at,label:item.is_internal?"Internal note added":item.sender_id===order.customer_id?"Customer message":"KeyMoura message",detail:item.body})),...(rowsOrNull(payments) ?? []).map(payment=>({id:`p-${payment.id}`,at:payment.received_at,label:"Payment received",detail:`$${(payment.amount_cents/100).toFixed(2)}`})),...(rowsOrNull(refunds) ?? []).map(refund=>({id:`r-${refund.id}`,at:refund.created_at,label:"Refund issued",detail:`$${(refund.amount_cents/100).toFixed(2)} — ${refund.reason}`})),...(order.shipped_at?[{id:"shipped",at:order.shipped_at,label:order.fulfillment_method==="pickup"?"Ready for pickup":"Order shipped",detail:order.tracking_number || null}]:[]),...(order.delivered_at?[{id:"delivered",at:order.delivered_at,label:"Order delivered / completed",detail:null}]:[]),{id:"created",at:order.created_at,label:"Request submitted",detail:null}].sort((a,b)=>new Date(b.at).getTime()-new Date(a.at).getTime()).map(item=><div key={item.id} className={`border-l-2 pl-4 ${item.id.startsWith("r-") ? "border-rose-400/70" : item.id.startsWith("p-") ? "border-emerald-400/70" : "border-brand-accent/60"}`}><div className="text-sm font-medium">{item.label}</div><div className="text-[11px] text-brand-textMuted">{new Date(item.at).toLocaleString()}</div>{item.detail?<p className="mt-1 line-clamp-2 text-xs text-brand-textMuted">{item.detail}</p>:null}</div>)}
          </div>
        </section>
        <section className="md:col-span-2">
          <h2 className="font-semibold">Email history</h2>
          <SectionFailure state={emails} what="The email history" />
          <div className="mt-3 overflow-hidden rounded-xl border border-zinc-800">
            {(rowsOrNull(emails) ?? []).map(email=><div key={email.id} className="grid gap-1 border-b border-zinc-800 bg-black/20 px-4 py-3 text-sm last:border-b-0 md:grid-cols-[1fr_1.4fr_auto]"><div><span className="text-brand-textMuted">To </span>{email.recipient}</div><div>{email.subject}</div><div className={email.status==="sent"?"text-emerald-300":email.status==="failed"?"text-rose-300":"text-amber-200"}>{pretty(email.status)} · {new Date(email.created_at).toLocaleString()}</div>{email.error_message?<div className="text-xs text-rose-200 md:col-span-3">{email.error_message}</div>:null}</div>)}
            {/* Only a successful query that returned nothing earns this sentence. */}
            {isTrulyEmpty(emails)?<div className="px-4 py-6 text-center text-sm text-brand-textMuted">No email attempts for this order yet.</div>:null}
          </div>
        </section>
        {/*
          The override stays, and stays explicit. Choosing in the dropdown still
          writes nothing; the named button and the dialog behind it do. The
          selection is what the dialog then describes, so "Now → After" is read
          from the same value that will be posted.
        */}
        {canManage ? (
          <details className="ui-card md:col-span-2">
            <summary className="cursor-pointer font-semibold">Advanced status override</summary>
            <p className="mt-2 text-xs text-brand-textMuted">
              Use this only when the normal quote, payment, review, or fulfillment buttons cannot represent what
              happened. Choosing a status here changes nothing until you confirm.
            </p>
            <div className="mt-3 sm:flex sm:items-end sm:gap-4">
              <label className="block flex-1 text-sm font-medium">
                Customer-facing status
                <select
                  value={pendingStatus || order.status}
                  onChange={(e) => setPendingStatus(e.target.value)}
                  className="ui-input mt-2 w-full"
                >
                  {statuses.map((s) => (
                    <option key={s} value={s}>
                      {statusLabel(s)}
                    </option>
                  ))}
                </select>
              </label>
              <ConsequentialAction
                className="mt-3 sm:mt-0"
                label="Apply this status"
                title={`Move this order to ${statusLabel(pendingStatus || order.status)}?`}
                summary="An override skips the checks the normal buttons make. The customer is told, and this cannot be undone by choosing the old status again — that would send a second message."
                currentState={statusLabel(order.status)}
                nextState={statusLabel(pendingStatus || order.status)}
                tone={pendingStatus === "cancelled" || pendingStatus === "declined" ? "danger" : "default"}
                confirmLabel="Apply the override"
                disabled={!pendingStatus || pendingStatus === order.status}
                disabledReason={!pendingStatus || pendingStatus === order.status ? "Choose a different status first." : null}
                reason={
                  pendingStatus === "cancelled"
                    ? {
                        label: "Why is this being cancelled?",
                        required: true,
                        help: "Stored on the order permanently.",
                      }
                    : undefined
                }
                effects={{
                  customer: `Their order page reads ${statusLabel(pendingStatus || order.status)}.`,
                  financial: order.amount_paid_cents
                    ? "No money moves. Refunds are issued from the lifecycle panel."
                    : null,
                  inventory: null,
                  notification: "A status-update email and an on-site notification.",
                }}
                onConfirm={({ reason }) => changeStatus(pendingStatus, reason)}
              />
            </div>
          </details>
        ) : null}
      </div>
      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    </main>
  );
}
