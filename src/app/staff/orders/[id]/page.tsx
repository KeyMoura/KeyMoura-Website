"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { useHashTab } from "@/lib/hooks/useHashTab";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { RequestSpecifications } from "@/components/RequestSpecifications";
import { OrderTriagePanel } from "@/components/staff/OrderTriagePanel";
import { OrderCostingPanel } from "@/components/staff/OrderCostingPanel";
import { OrderProductionJobs } from "@/components/staff/production/OrderProductionJobs";
import { OrderReviewGallery } from "@/components/OrderReviewGallery";
import { Badge, Notice, cx } from "@/components/ui/DesignSystem";
import { Field } from "@/components/ui/DesignSystem";
import { OrderLifecyclePanel } from "@/components/staff/OrderLifecyclePanel";
import { OrderFulfillmentPanel } from "@/components/staff/OrderFulfillmentPanel";
import { OrderSupportConversations } from "@/components/staff/OrderSupportConversations";
import {
  Card,
  CheckField,
  EmptyState,
  Fact,
  Facts,
  FormGrid,
  FormWide,
  LoadingState,
  PageTabs,
  Row,
  Rows,
  Section,
  StaffPage,
  StatusChip,
  TabPanel,
} from "@/components/staff/StaffPage";
import { ORDER_TAB_ALIASES, type StaffTab } from "@/lib/staff/pageFramework";
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
 * The order workspace — the one place an order is managed.
 *
 * ## What this replaced
 *
 * A single 877-line column of eleven panels, every one of them mounted at once
 * and most of them `lg:col-span-2`, so the "two column" grid was in practice a
 * very long scroll: a header of four metric cards, a next-step banner, a
 * six-step stepper, the production workspace, the shop-work list, a customer
 * review composer, the lifecycle panel, the quote editor, the fulfillment
 * panel, the conversation, the activity timeline, the email history, and an
 * advanced status override. Three of those rendered the payment state, two
 * rendered the fulfillment state, and the financial position appeared twice.
 *
 * ## The shape now
 *
 * A **persistent header** that answers the four questions without scrolling —
 * who, how much, where is it, what next — and eight tabs beneath it. Each tab
 * holds one kind of work, and each piece of state is rendered exactly once.
 *
 * ## Why the hash, not a query parameter
 *
 * The tabs are addressed by `#hash`, which is what the page's own sections used
 * before this pass. `/staff/orders/<id>#fulfillment` is linked from the
 * fulfillment queue, `#production` from the production panel, and the dashboard
 * now links every attention row to the tab that holds its work. Those links all
 * still mean what they meant — `ORDER_TAB_ALIASES` maps the retired anchors
 * (`#conversation`, `#quote`, `#shop-work`) onto the tabs that replaced them,
 * so a bookmark from last week lands on the right control rather than silently
 * on Overview.
 *
 * Only tabs that apply are shown: a direct purchase with no production, an
 * order with nothing to deliver, and a request that has never taken money each
 * get a shorter strip rather than empty panels.
 */

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
    <Notice tone="danger" role="alert">
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
  order_kind: string | null;
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
  fulfillment_status: string | null;
  fulfillment_method: "shipping" | "pickup";
  cancellation_status: string | null;
  return_status: string | null;
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
  order_items?: Array<{ id: string; product_name: string; selected_options: Record<string, unknown> | null }>;
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
type Profile = { display_name: string | null; username: string | null };

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
const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

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

/**
 * What has to happen next, and which tab it happens on.
 *
 * The `tab` replaces a `#quote`/`#fulfillment`/`#activity` anchor. It is the
 * same idea — send the reader to the control — except that the control is now
 * on a tab of its own rather than 2,000 pixels down a single page.
 */
const nextStaffStep = (order: Order): { title: string; detail: string; tab: string } => {
  if (order.status === "requested") return { title: "Review the request", detail: "Confirm the specifications, then prepare and send the customer quote.", tab: "overview" };
  if (order.status === "needs_information") return { title: "Waiting for customer information", detail: "Use the conversation to follow up if the customer has not replied.", tab: "messages" };
  if (order.status === "accepted") return { title: "Prepare the quote", detail: "The request is accepted. Set the customer price, deposit and schedule, then send the quote for approval.", tab: "payment" };
  if (order.status === "awaiting_payment") return { title: "Waiting for payment", detail: "The quote is approved. Production begins automatically when the required payment is received.", tab: "payment" };
  if (order.status === "customer_review") return { title: "Waiting for quote approval", detail: "The customer needs to approve the current quote before checkout.", tab: "payment" };
  if (order.status === "in_progress") return { title: "Complete production", detail: "Use the production workspace, then send the finished product for customer review.", tab: "production" };
  if (order.status === "final_review") return { title: "Waiting for finished-product approval", detail: "The customer is reviewing the finished product. Fulfillment unlocks after approval.", tab: "overview" };
  if (order.status === "ready") return { title: order.fulfillment_method === "pickup" ? "Prepare customer pickup" : "Ship the order", detail: "Confirm the balance is paid, then complete the fulfillment action.", tab: "fulfillment" };
  if (order.status === "completed") return { title: "Order complete", detail: "No action is required. The full record remains available.", tab: "activity" };
  if (order.status === "declined" || order.status === "cancelled") return { title: statusLabel(order.status), detail: "No normal workflow action is pending. Review payment and refund records if needed.", tab: "activity" };
  return { title: "Review this order", detail: "Check the order details and choose the appropriate next action.", tab: "overview" };
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
  const perms = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = perms.has("orders.view") || perms.has("orders.manage");
  const canManage = perms.has("orders.manage");
  const canViewProduction = perms.has("production.view") || perms.has("production.manage");

  const [order, setOrder] = useState<Order | null>(null);
  const [customer, setCustomer] = useState<Profile | null>(null);
  /** How many production jobs are linked, reported up by the panel below. */
  const [jobSummary, setJobSummary] = useState<{ count: number; label: string } | null>(null);
  /*
   * Six independent loads, six independent states.
   *
   * `LoadState` makes it unrepresentable to read rows without narrowing to
   * `ready`, so a failed payments query cannot render as *no payments* — which
   * on an order workspace reads as "this customer has not paid".
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
      supabase.from("orders").select("*,order_items(id,product_name,selected_options)").eq("id", id).maybeSingle(),
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
      // The customer's name, for the header. A refused profile read leaves the
      // header generic; it does not mean the order has no customer.
      const profile = await supabase
        .from("profiles")
        .select("display_name,username")
        .eq("id", row.customer_id)
        .maybeSingle();
      setCustomer(profile.error ? null : ((profile.data as Profile | null) ?? null));
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

  /*
   * The tab strip.
   *
   * Built before the early returns below so the hook order is stable across
   * the loading, refused and loaded renders — `useHashTab` cannot sit after a
   * `return`. An order that has not loaded yet gets the full strip; the
   * `available` flags narrow it as soon as the row arrives.
   */
  const tabs = useMemo<StaffTab[]>(
    () => [
      { id: "overview", label: "Overview" },
      { id: "items", label: "Items" },
      { id: "payment", label: "Payment" },
      {
        id: "production",
        label: "Production",
        // A direct purchase of a stocked item is not made to order. It still
        // gets the tab if somebody has raised shop work against it, which the
        // panel reports up once it has loaded.
        available:
          canViewProduction &&
          (order == null || order.order_kind !== "direct_purchase" || (jobSummary?.count ?? 0) > 0),
      },
      {
        id: "fulfillment",
        label: "Fulfillment",
        available: order == null || order.fulfillment_status !== "not_required",
      },
      { id: "messages", label: "Messages" },
      {
        id: "returns",
        label: "Returns & cancellations",
        // Nothing can be returned or refunded before money has moved, and a
        // request that has never taken any does not need the tab.
        available:
          order == null ||
          order.amount_paid_cents > 0 ||
          (order.cancellation_status ?? "none") !== "none" ||
          (order.return_status ?? "none") !== "none",
      },
      { id: "activity", label: "Activity" },
    ],
    [canViewProduction, jobSummary, order]
  );
  const [tab, setTab] = useHashTab(tabs, ORDER_TAB_ALIASES);

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
   * - **`expected_status`** is always sent. The route puts it in the `WHERE`
   *   clause, so a colleague's change that landed since this page rendered is a
   *   409 rather than a silent overwrite.
   * - **A 409 becomes a conflict**, which `ConsequentialAction` shows in place
   *   and refuses to retry.
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

  if (isLoading) return <LoadingState>Loading the order…</LoadingState>;
  if (!canView) return <AccessDeniedCard message="You do not have access to orders." />;
  if (!order) return <Notice tone="danger" role="alert">{error || "Order not found."}</Notice>;

  const input = "ui-input";
  const nextStep = nextStaffStep(order);
  const activeStep = workflowStepIndex(order.status);
  const isClosed = order.status === "cancelled" || order.status === "declined";
  const requestedTotalCents = requestedEstimateCents(order);
  const requestedOptionTotalCents = optionAdjustmentCents(order) * order.quantity;
  const requestedBaseTotalCents = requestedTotalCents == null ? null : requestedTotalCents - requestedOptionTotalCents;
  const netPaidCents = order.amount_paid_cents - (order.amount_refunded_cents || 0);
  const balanceCents = Math.max(0, (order.agreed_price_cents || 0) - netPaidCents);
  const customerName =
    customer?.display_name || (customer?.username ? `@${customer.username}` : "Customer");

  /*
   * Which of the timeline's four sources are missing.
   *
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

  return (
    <StaffPage>
      {/* ================= Persistent header ================= */}
      <header className="staff-record-header">
        <div className="staff-record-top">
          <div className="min-w-0">
            <p className="staff-record-eyebrow">
              {order.order_number || "Request pending"} ·{" "}
              {order.order_kind === "direct_purchase" ? "Direct purchase" : "Custom request"}
            </p>
            <h1 className="staff-record-title">{order.product_name}</h1>
            <p className="staff-row-meta mt-1">
              {customerName} · Quantity {order.quantity} · Submitted{" "}
              {new Date(order.created_at).toLocaleDateString()}
            </p>
          </div>
          {/*
            The money, once. It was four `ui-card` tiles here *and* a four-tile
            financial grid inside the lifecycle panel further down, which is two
            places for "how much has this customer paid" to be read from.
          */}
          <Facts className="w-full sm:w-auto sm:min-w-[22rem]">
            <Fact label="Total">
              {order.agreed_price_cents == null ? "Not quoted" : money(order.agreed_price_cents)}
            </Fact>
            <Fact label="Net paid">
              <span className="text-emerald-300">{money(netPaidCents)}</span>
            </Fact>
            <Fact label="Balance">{money(balanceCents)}</Fact>
          </Facts>
        </div>

        {/* Every state this order is in, in one strip, each named. */}
        <div className="staff-record-states">
          <StatusChip value={order.status} label={statusLabel(order.status)} />
          <StatusChip value={order.payment_status} prefix="Payment · " />
          {order.fulfillment_status && order.fulfillment_status !== "not_required" ? (
            <StatusChip value={order.fulfillment_status} prefix="Delivery · " />
          ) : null}
          {jobSummary && jobSummary.count > 0 ? (
            <Badge tone="accent">
              <span className="opacity-60">Production · </span>
              {jobSummary.label}
            </Badge>
          ) : null}
          {(order.cancellation_status ?? "none") !== "none" ? (
            <StatusChip value={order.cancellation_status} prefix="Cancellation · " />
          ) : null}
          {(order.return_status ?? "none") !== "none" ? (
            <StatusChip value={order.return_status} prefix="Return · " />
          ) : null}
        </div>

        {/* The single next action, always visible, never scrolled past. */}
        <div className="staff-record-next">
          <div className="min-w-0">
            <p className="staff-record-next-label">Next step</p>
            <p className="staff-record-next-title">{nextStep.title}</p>
            <p className="staff-record-next-detail">{nextStep.detail}</p>
          </div>
          {nextStep.tab !== tab ? (
            <button type="button" onClick={() => setTab(nextStep.tab)} className="ui-btn ui-btn-primary text-sm">
              Go to {tabs.find((candidate) => candidate.id === nextStep.tab)?.label ?? "next step"}
            </button>
          ) : null}
        </div>
      </header>

      <PageTabs tabs={tabs} value={tab} onChange={setTab} ariaLabel="Order sections" />

      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}

      {/* ================= Overview ================= */}
      <TabPanel id="overview" value={tab}>
        <Section
          title="Where this order is"
          description="The six stages every custom order passes through."
        >
          <nav className="ui-card overflow-x-auto" aria-label="Order workflow">
            <ol className="ui-stepper min-w-[680px]">
              {workflowSteps.map((step, index) => {
                const complete = !isClosed && index < activeStep;
                const active = !isClosed && index === activeStep;
                return (
                  <li
                    key={step.label}
                    data-step={index + 1}
                    aria-current={active ? "step" : undefined}
                    className={cx("ui-step", active && "is-current", complete && "is-complete")}
                  >
                    {step.label}
                  </li>
                );
              })}
            </ol>
          </nav>
        </Section>

        <Section title="At a glance" description="The questions this page exists to answer.">
          <Card>
            <Facts>
              <Fact label="Has it been paid?">
                {balanceCents === 0 && order.amount_paid_cents > 0
                  ? "Paid in full"
                  : order.amount_paid_cents > 0
                    ? `${money(balanceCents)} still to collect`
                    : "Nothing collected yet"}
              </Fact>
              <Fact label="Does it need making?">
                {order.order_kind === "direct_purchase" ? "Direct purchase — stock item" : "Custom work"}
              </Fact>
              <Fact label="Production linked">
                {!canViewProduction
                  ? "—"
                  : jobSummary == null
                    ? "Loading…"
                    : jobSummary.count === 0
                      ? "No production job yet"
                      : `${jobSummary.count} job${jobSummary.count === 1 ? "" : "s"} · ${jobSummary.label}`}
              </Fact>
              <Fact label="Ready to fulfill?">
                {order.fulfillment_status === "not_required"
                  ? "Nothing to deliver"
                  : order.fulfillment_status === "ready_to_fulfill" || order.fulfillment_status === "ready_for_pickup"
                    ? "Yes — waiting to go out"
                    : pretty(String(order.fulfillment_status || "unfulfilled"))}
              </Fact>
              <Fact label="Delivery method">
                {order.fulfillment_method === "pickup" ? "Local pickup" : "Shipping"}
              </Fact>
              <Fact label="Target date">
                {order.target_date
                  ? new Date(`${order.target_date}T00:00:00`).toLocaleDateString()
                  : "None set"}
              </Fact>
            </Facts>
          </Card>
        </Section>

        {/*
          Triage sits on Overview because it is a property of the *order*: the
          Orders queue sorts and filters on this priority, and an order with no
          shop work still has an owner. The job's own priority and assignee are
          on the Production tab, on the job — two controls, two tables, two
          clearly different questions.
        */}
        <Section
          title="Triage"
          description="How urgent this order is, and who is answerable for it."
        >
          <OrderTriagePanel orderId={id} canManage={canManage} />
        </Section>

        {order.customer_notes ? (
          <Section title="Customer notes" headingLevel={2}>
            <Card>
              <p className="whitespace-pre-wrap text-sm">{order.customer_notes}</p>
            </Card>
          </Section>
        ) : null}

        {/* The accept/decline decision lives with the thing being decided. */}
        {(order.status === "requested" || order.status === "needs_information") && canManage ? (
          <Section
            title="Decide this request"
            description="Accepting moves it into quoting. Nothing is charged either way."
          >
            <div className="ui-action-row">
              <button type="button" onClick={() => setTab("messages")} className="ui-btn ui-btn-secondary">
                Message customer
              </button>
              <ConsequentialAction
                label="Cancel request"
                title="Cancel this request?"
                summary="The request is closed and the customer is told. This does not move any money — a refund is issued separately from Returns & cancellations."
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
                    ? `No refund is issued here. ${money(order.amount_paid_cents)} remains collected until you refund it from Returns & cancellations.`
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
            </div>
          </Section>
        ) : null}

        {order.status === "final_review" ? (
          <Section
            title="Sent for approval"
            description="What the customer is looking at right now."
          >
            <Card>
              {order.final_review_note ? (
                <p className="whitespace-pre-wrap text-sm text-brand-textMuted">{order.final_review_note}</p>
              ) : null}
              <OrderReviewGallery paths={order.final_review_asset_paths || []} />
            </Card>
          </Section>
        ) : null}
      </TabPanel>

      {/* ================= Items ================= */}
      <TabPanel id="items" value={tab}>
        <Section
          title="What was ordered"
          description="The item, its options and what each contributed to the requested total."
        >
          <Card>
            <Facts>
              <Fact label="Item">{order.product_name}</Fact>
              <Fact label="Quantity">{order.quantity}</Fact>
              <Fact label="Base item price">
                {requestedBaseTotalCents == null
                  ? "Price pending"
                  : money(requestedBaseTotalCents) +
                    (order.quantity > 1 ? ` (${money(requestedBaseTotalCents / order.quantity)} each)` : "")}
              </Fact>
              <Fact label="Options">
                {requestedOptionTotalCents ? money(requestedOptionTotalCents) : "No price change"}
              </Fact>
              <Fact label="Requested total">
                <span className="text-brand-primary">
                  {requestedTotalCents == null ? "Quoted after review" : money(requestedTotalCents)}
                </span>
              </Fact>
              <Fact label="Quoted total">
                {order.agreed_price_cents == null ? "Not quoted yet" : money(order.agreed_price_cents)}
              </Fact>
            </Facts>
          </Card>
        </Section>

        <Section title="Chosen options" description="Exactly what the customer specified.">
          <Card>
            <dl className="staff-facts">
              <RequestSpecifications specifications={order.specifications || {}} />
              {(order.order_items ?? []).map((item) =>
                item.selected_options && Object.keys(item.selected_options).length ? (
                  <div key={item.id}>
                    <dt className="font-semibold">{item.product_name} customization</dt>
                    <dd><dl className="mt-2 staff-facts"><RequestSpecifications specifications={item.selected_options} /></dl></dd>
                  </div>
                ) : null
              )}
            </dl>
          </Card>
        </Section>
      </TabPanel>

      {/* ================= Payment ================= */}
      <TabPanel id="payment" value={tab}>
        <Section
          title="Customer quote"
          description="The final price the customer pays — not your material or labor cost. Internal costs stay in Production."
          actions={<Badge>Revision {order.quote_revision}</Badge>}
        >
          <Card>
            <FormGrid>
              <Field label="Total customer price ($)">
                <input
                  disabled={!canManage || quoteLocked(order)}
                  className={`${input} w-full`}
                  type="number"
                  step=".01"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                />
              </Field>
              <Field label="Amount paid ($)" help="Updated automatically by Stripe.">
                <input disabled className={`${input} w-full opacity-70`} type="number" value={paid} />
              </Field>
              <Field
                label="Deposit due first ($)"
                help="Leave blank to collect the full quote. Editing price or deposit creates a new quote revision."
              >
                <input
                  disabled={!canManage || quoteLocked(order)}
                  className={`${input} w-full`}
                  type="number"
                  min="0.5"
                  step=".01"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                  placeholder="Blank = collect full price"
                />
              </Field>
              <Field label="Quote valid through" help="Checkout is blocked after this date until a new quote is sent.">
                <input
                  disabled={!canManage || quoteLocked(order)}
                  className={`${input} w-full`}
                  type="date"
                  value={quoteExpires}
                  onChange={(e) => setQuoteExpires(e.target.value)}
                />
              </Field>
              <Field label="Target date">
                <input
                  disabled={!canManage}
                  className={`${input} w-full`}
                  type="date"
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                />
              </Field>
              <FormWide>
                <Field label="Quote note" help="What changed, or what is included in this quote.">
                  <textarea
                    disabled={!canManage}
                    className={`${input} min-h-20 w-full`}
                    value={quoteNote}
                    onChange={(e) => setQuoteNote(e.target.value)}
                  />
                </Field>
              </FormWide>
              <FormWide>
                <Field label="Internal notes" help="Never shown to the customer.">
                  <textarea
                    disabled={!canManage}
                    className={`${input} min-h-24 w-full`}
                    value={staffNotes}
                    onChange={(e) => setStaffNotes(e.target.value)}
                  />
                </Field>
              </FormWide>
            </FormGrid>

            {/*
              Two buttons, because these are two different actions. One button
              whose label changed between "Review & send quote" and "Save
              internal details" depending on whether a number had been typed
              meant the consequence of pressing it depended on a field above it.
            */}
            {canManage ? (
              <div className="ui-action-row mt-5">
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
                    customer: `They are asked to approve ${price.trim() ? money(Math.round(Number(price) * 100)) : "the quote"}${deposit.trim() ? `, paying ${money(Math.round(Number(deposit) * 100))} up front` : ""}.`,
                    financial: "Nothing is charged now. The customer pays at checkout after approving.",
                    inventory: null,
                    notification: "“Quote ready for review”, with the amount.",
                  }}
                  notificationPreview={quoteNote.trim() || undefined}
                  onConfirm={() => sendQuote()}
                />
              </div>
            ) : null}
          </Card>
        </Section>

        <Section title="Payments received" description="Every collection Stripe has confirmed.">
          <SectionFailure state={payments} what="The payment history" />
          {rowsOrNull(payments)?.length ? (
            <Rows>
              {(rowsOrNull(payments) ?? []).map((payment) => (
                <Row
                  key={payment.id}
                  title={money(payment.amount_cents)}
                  detail={new Date(payment.received_at).toLocaleString()}
                />
              ))}
            </Rows>
          ) : isTrulyEmpty(payments) ? (
            <EmptyState>No payment has been collected on this order yet.</EmptyState>
          ) : null}
        </Section>

        <Section
          title="Refunds"
          description="The financial position, and the control that changes it."
        >
          <OrderLifecyclePanel orderId={id} productName={order.product_name} view="money" />
        </Section>
      </TabPanel>

      {/* ================= Production ================= */}
      <TabPanel id="production" value={tab}>
        <Section
          title="Linked shop work"
          description="Production jobs raised against this order. Internal — never shown to the customer."
        >
          <OrderProductionJobs
            orderId={id}
            productId={order.product_id}
            customerId={order.customer_id}
            productName={order.product_name}
            /* So both surfaces call the order the same thing, and the new-job
               form can name it rather than saying "the order it was raised
               from". Display only — the link is the id. */
            orderNumber={order.order_number}
            quantity={order.quantity}
            onSummary={setJobSummary}
          />
        </Section>

        <Section
          title="Job costing"
          description="Internal material and labour cost for this order. Never shown to the customer."
        >
          <OrderCostingPanel orderId={id} canManage={canManage} />
        </Section>

        {order.status === "in_progress" && canManage ? (
          <Section
            title="Show the customer the finished work"
            description="Add the photos and note the customer should review. Nothing is sent until you confirm."
          >
            <Card>
              <Field
                label="Finished-product photos"
                help="Up to 6 photos. These are private to staff and this customer."
              >
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/avif"
                  multiple
                  onChange={(event) => setReviewFiles(Array.from(event.target.files || []).slice(0, 6))}
                  className="block w-full rounded-xl border border-dashed border-[var(--border)] bg-black/20 px-4 py-5 text-sm file:mr-4 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-2 file:text-white"
                />
              </Field>
              {reviewFiles.length ? (
                <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {reviewFiles.map((file, index) => (
                    <div key={`${file.name}-${index}`} className="rounded-xl border border-[var(--border)] p-3">
                      <p className="truncate text-sm font-medium">{file.name}</p>
                      <p className="mt-1 text-xs text-brand-textMuted">{(file.size / 1024 / 1024).toFixed(1)} MB</p>
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="mt-4">
                <Field label="Note to customer">
                  <textarea
                    value={reviewNote}
                    onChange={(event) => setReviewNote(event.target.value)}
                    maxLength={3000}
                    className={`${input} min-h-28 w-full`}
                    placeholder="Here is the finished piece. Please review the photos, finish, colour and details…"
                  />
                </Field>
              </div>
              <div className="mt-4 rounded-xl border border-[var(--border)] bg-black/20 p-4">
                <p className="staff-fact-label">Customer preview</p>
                <p className="mt-2 whitespace-pre-wrap text-sm">
                  {reviewNote.trim() || "Your note will appear here."}
                </p>
                <p className="mt-3 text-xs text-brand-textMuted">
                  {reviewFiles.length
                    ? `${reviewFiles.length} photo${reviewFiles.length === 1 ? "" : "s"} attached`
                    : "No photos attached yet"}
                </p>
              </div>
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
            </Card>
          </Section>
        ) : null}
      </TabPanel>

      {/* ================= Fulfillment ================= */}
      <TabPanel id="fulfillment" value={tab}>
        <Section
          title="Delivery"
          description="The method, its state and the actions the server says are legal right now."
        >
          <OrderFulfillmentPanel orderId={id} canManage={canManage} onChanged={() => void load()} />
        </Section>
      </TabPanel>

      {/* ================= Messages ================= */}
      <TabPanel id="messages" value={tab}>
        <Section
          title="Conversation"
          description="Everything said about this order, including notes only staff can see."
        >
          <SectionFailure state={messages} what="The conversation" />
          <div className="max-h-[520px] space-y-3 overflow-y-auto">
            {(rowsOrNull(messages) ?? []).map((m) => (
              <div
                key={m.id}
                className={cx(
                  "rounded-xl border p-3 text-sm",
                  m.is_internal ? "border-sky-500/40 bg-sky-500/10" : "border-[var(--border)] bg-black/20"
                )}
              >
                <div className="staff-fact-label">
                  {m.is_internal
                    ? "Internal note"
                    : m.sender_id === order.customer_id
                      ? "Customer"
                      : "KeyMoura"}{" "}
                  · {new Date(m.created_at).toLocaleString()}
                </div>
                <p className="mt-1 whitespace-pre-wrap">{m.body}</p>
              </div>
            ))}
            {isTrulyEmpty(messages) ? <EmptyState>Nothing has been said about this order yet.</EmptyState> : null}
          </div>

          {/*
            The checkbox decides whether text leaves the building, and the
            composer repaints when it changes — the border, the sentence under
            it and the button all change — so which of the two things you are
            about to do is readable without re-reading the checkbox.
          */}
          {canManage ? (
            <Card>
              <Field label={internal ? "Internal note" : "Message to the customer"}>
                <textarea
                  className={cx(input, "min-h-24 w-full", internal ? "!border-sky-500/50" : "!border-brand-primary/40")}
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  placeholder={internal ? "Note for staff only…" : "Reply to the customer…"}
                />
              </Field>
              <div className="mt-3">
                <CheckField
                  label="Internal note (the customer cannot see this)"
                  help={
                    internal
                      ? "Stays on this order. No email, no notification."
                      : "The customer reads this and is emailed a copy."
                  }
                  checked={internal}
                  onChange={setInternal}
                />
              </div>
              <div className="ui-action-row mt-4">
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
            </Card>
          ) : null}
        </Section>

        {/*
          The order's own thread is above; this is the other conversation that
          can exist about the same order. Both are here because a staff member
          reading one needs to know the other exists — answering half a
          conversation is how a customer gets told two different things.
        */}
        <OrderSupportConversations orderId={id} />
      </TabPanel>

      {/* ================= Returns & cancellations ================= */}
      <TabPanel id="returns" value={tab}>
        <Section
          title="Cancellations and returns"
          description="Lifecycle decisions for this order. The money they move is shown on Payment."
          actions={
            <button type="button" onClick={() => setTab("payment")} className="ui-btn ui-btn-ghost text-sm">
              Payment & refunds
            </button>
          }
        >
          <OrderLifecyclePanel orderId={id} productName={order.product_name} view="lifecycle" />
        </Section>
      </TabPanel>

      {/* ================= Activity ================= */}
      <TabPanel id="activity" value={tab}>
        <Section title="Activity timeline" description="Everything that happened, newest first.">
          {/*
            A timeline assembled from four independent sources is the one place
            a partial failure is genuinely invisible: the entries that did load
            still render in order and still look like a complete history. So the
            sources that failed are named *above* the timeline.
          */}
          {missingTimelineSources.length ? (
            <Notice tone="warning" role="status">
              This timeline is incomplete: {missingTimelineSources.join(", ")} could not be loaded. Entries of that
              kind are missing from the list below — they are not absent from the order.
            </Notice>
          ) : null}
          <div className="space-y-2 rounded-xl border border-[var(--border)] p-4">
            {[
              ...(rowsOrNull(history) ?? []).map((item) => ({
                id: `h-${item.id}`,
                at: item.created_at,
                label: `Status changed to ${pretty(item.to_status)}`,
                detail: item.note,
              })),
              ...(rowsOrNull(messages) ?? []).map((item) => ({
                id: `m-${item.id}`,
                at: item.created_at,
                label: item.is_internal
                  ? "Internal note added"
                  : item.sender_id === order.customer_id
                    ? "Customer message"
                    : "KeyMoura message",
                detail: item.body,
              })),
              ...(rowsOrNull(payments) ?? []).map((payment) => ({
                id: `p-${payment.id}`,
                at: payment.received_at,
                label: "Payment received",
                detail: money(payment.amount_cents),
              })),
              ...(rowsOrNull(refunds) ?? []).map((refund) => ({
                id: `r-${refund.id}`,
                at: refund.created_at,
                label: "Refund issued",
                detail: `${money(refund.amount_cents)} — ${refund.reason}`,
              })),
              ...(order.shipped_at
                ? [
                    {
                      id: "shipped",
                      at: order.shipped_at,
                      label: order.fulfillment_method === "pickup" ? "Ready for pickup" : "Order shipped",
                      detail: order.tracking_number || null,
                    },
                  ]
                : []),
              ...(order.delivered_at
                ? [{ id: "delivered", at: order.delivered_at, label: "Order delivered / completed", detail: null }]
                : []),
              { id: "created", at: order.created_at, label: "Request submitted", detail: null },
            ]
              .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
              .map((item) => (
                <div
                  key={item.id}
                  className={cx(
                    "border-l-2 pl-4",
                    item.id.startsWith("r-")
                      ? "border-rose-400/70"
                      : item.id.startsWith("p-")
                        ? "border-emerald-400/70"
                        : "border-brand-accent/60"
                  )}
                >
                  <div className="text-sm font-medium">{item.label}</div>
                  <div className="staff-row-meta">{new Date(item.at).toLocaleString()}</div>
                  {item.detail ? <p className="mt-1 line-clamp-2 text-xs text-brand-textMuted">{item.detail}</p> : null}
                </div>
              ))}
          </div>
        </Section>

        <Section title="Email history" description="Every message this order tried to send.">
          <SectionFailure state={emails} what="The email history" />
          {rowsOrNull(emails)?.length ? (
            <Rows>
              {(rowsOrNull(emails) ?? []).map((email) => (
                <Row
                  key={email.id}
                  title={email.subject}
                  detail={`To ${email.recipient}`}
                  meta={email.error_message || undefined}
                  aside={
                    <>
                      <StatusChip value={email.status === "sent" ? "delivered" : email.status} />
                      <span className="staff-row-meta whitespace-nowrap">
                        {new Date(email.created_at).toLocaleString()}
                      </span>
                    </>
                  }
                />
              ))}
            </Rows>
          ) : isTrulyEmpty(emails) ? (
            <EmptyState>No email attempts for this order yet.</EmptyState>
          ) : null}
        </Section>

        {/*
          The override stays, and stays explicit. Choosing in the dropdown still
          writes nothing; the named button and the dialog behind it do. It lives
          on Activity because that is where the record of what was forced is
          read, and it is a `<details>` so it is never the first thing on a tab.
        */}
        {canManage ? (
          <details className="ui-card">
            <summary className="cursor-pointer text-sm font-semibold">Advanced status override</summary>
            <p className="mt-2 text-xs text-brand-textMuted">
              Use this only when the normal quote, payment, review or fulfillment buttons cannot represent what
              happened. Choosing a status here changes nothing until you confirm.
            </p>
            <div className="mt-4 sm:flex sm:items-end sm:gap-4">
              <div className="flex-1">
                <Field label="Customer-facing status">
                  <select
                    value={pendingStatus || order.status}
                    onChange={(e) => setPendingStatus(e.target.value)}
                    className="ui-input w-full"
                  >
                    {statuses.map((s) => (
                      <option key={s} value={s}>
                        {statusLabel(s)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
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
                disabledReason={
                  !pendingStatus || pendingStatus === order.status ? "Choose a different status first." : null
                }
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
                    ? "No money moves. Refunds are issued from Returns & cancellations."
                    : null,
                  inventory: null,
                  notification: "A status-update email and an on-site notification.",
                }}
                onConfirm={({ reason }) => changeStatus(pendingStatus, reason)}
              />
            </div>
          </details>
        ) : null}

        <p className="text-xs text-brand-textMuted">
          <Link href="/staff/orders" className="text-brand-accent hover:underline">
            ← Back to all orders
          </Link>
        </p>
      </TabPanel>
    </StaffPage>
  );
}
