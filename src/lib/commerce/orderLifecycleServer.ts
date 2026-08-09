import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { routeServiceClient } from "@/lib/api/routeAuth";
import { stripeClient } from "@/lib/stripe";
import { captureCommerceException } from "@/lib/monitoring";
import { getCommerceEmailConfig, sendCommerceEmail, type CommerceEmailTemplateKey } from "@/lib/commerceEmail";
import { filterCustomerVariables } from "@/lib/comms/emailEvents";
import { notifyOrderStaff, notifyOrderUser } from "@/lib/orderNotifications";
import type { ChangeSet } from "@/lib/audit/diff";
import { recordAuditEvent, resolveActorLabel } from "@/lib/audit/events";
import {
  DEFAULT_COMMERCE_POLICY,
  parseCommercePolicy,
  refundableCents,
  type CommercePolicy,
  type ReturnableLine,
} from "./orderLifecycle";

/**
 * Server-side lifecycle operations: everything that needs the database, Stripe,
 * email or an audit trail. The rules themselves live in `orderLifecycle.ts` and
 * are imported, never restated.
 */

const db = (): SupabaseClient => routeServiceClient;

/**
 * Postgres errors are logged with SQLSTATE, message and hint — and deliberately
 * **not** `details`, the one field that echoes row values back. A unique
 * violation reports the conflicting key, and an order row carries customer
 * identifiers, internal notes and money.
 */
export function logLifecycleFailure(operation: string, error: unknown, context: Record<string, string | number | null> = {}) {
  const pgError = error as { code?: string; message?: string; hint?: string } | null;
  console.error("[order-lifecycle]", {
    operation,
    ...context,
    code: pgError?.code ?? null,
    message: pgError?.message?.slice(0, 400) ?? null,
    hint: pgError?.hint?.slice(0, 200) ?? null,
  });
  captureCommerceException(error, { operation, ...context });
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export async function loadCommercePolicy(): Promise<CommercePolicy> {
  const { data, error } = await db()
    .from("site_settings")
    .select("commerce_policy")
    .eq("singleton", true)
    .maybeSingle();
  if (error) {
    // A settings read failing must not take cancellations offline. The
    // conservative defaults are safe to fall back to.
    logLifecycleFailure("load_commerce_policy", error);
    return DEFAULT_COMMERCE_POLICY;
  }
  return parseCommercePolicy((data as { commerce_policy?: unknown } | null)?.commerce_policy);
}

// ---------------------------------------------------------------------------
// Order context
// ---------------------------------------------------------------------------

export type OrderLifecycleRow = {
  id: string;
  order_number: string | null;
  /** Null on a guest order — see `20260806050000_guest_commerce.sql`. */
  customer_id: string | null;
  guest_email: string | null;
  guest_name: string | null;
  product_id: string | null;
  product_name: string;
  order_kind: string | null;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  cancellation_status: string;
  return_status: string;
  fulfillment_method: string;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number;
  deposit_amount_cents: number | null;
  discount_code_id: string | null;
  created_at: string;
  delivered_at: string | null;
  picked_up_at: string | null;
  shipped_at: string | null;
  cancelled_at: string | null;
  cancellation_reason: string | null;
  inventory_committed_at: string | null;
};

const ORDER_COLUMNS =
  "id,order_number,customer_id,guest_email,guest_name,product_id,product_name,order_kind,status,payment_status," +
  "fulfillment_status,cancellation_status,return_status,fulfillment_method,agreed_price_cents," +
  "amount_paid_cents,amount_refunded_cents,deposit_amount_cents,discount_code_id,created_at," +
  "delivered_at,picked_up_at,shipped_at,cancelled_at,cancellation_reason,inventory_committed_at";

export type OrderLifecycleContext = {
  order: OrderLifecycleRow;
  policy: CommercePolicy;
  pendingRefundCents: number;
  refundableCents: number;
  openCancellationRequest: { id: string; status: string; reason_code: string; created_at: string } | null;
  openReturn: { id: string; status: string; return_number: string } | null;
  lines: ReturnableLine[];
  productionStatus: string | null;
};

/**
 * Everything a lifecycle decision needs, read in one place so no caller has to
 * remember that "refundable" also has to subtract pending refunds.
 */
export async function loadOrderLifecycleContext(orderId: string): Promise<OrderLifecycleContext | null> {
  const { data: order, error } = await db().from("orders").select(ORDER_COLUMNS).eq("id", orderId).maybeSingle();
  if (error) {
    logLifecycleFailure("load_order_lifecycle", error, { orderId });
    return null;
  }
  if (!order) return null;

  const [policy, refunds, cancellation, returns, items, jobs] = await Promise.all([
    loadCommercePolicy(),
    db().from("order_refunds").select("requested_amount_cents,amount_cents,status").eq("order_id", orderId),
    db()
      .from("order_cancellation_requests")
      .select("id,status,reason_code,created_at")
      .eq("order_id", orderId)
      .eq("status", "pending")
      .maybeSingle(),
    db()
      .from("order_returns")
      .select("id,status,return_number")
      .eq("order_id", orderId)
      .not("status", "in", "(denied,closed,completed)")
      .order("created_at", { ascending: false })
      .limit(1),
    db().from("order_items").select("id,product_id,product_name,unit_price_cents,quantity").eq("order_id", orderId),
    db().from("production_jobs").select("status").eq("order_id", orderId),
  ]);

  const pendingRefundCents = (refunds.data || [])
    .filter((row) => row.status === "pending")
    .reduce((sum, row) => sum + Number(row.requested_amount_cents ?? row.amount_cents ?? 0), 0);

  const orderRow = order as unknown as OrderLifecycleRow;

  // Quantities already spoken for by a return that is neither denied nor
  // closed. A denied return releases its hold; anything else keeps it.
  const itemIds = (items.data || []).map((row) => row.id as string);
  let returnedByItem = new Map<string, number>();
  if (itemIds.length) {
    const { data: returnLines } = await db()
      .from("order_return_items")
      .select("order_item_id,requested_quantity,order_returns!inner(status)")
      .in("order_item_id", itemIds);
    returnedByItem = (returnLines || []).reduce((map, row) => {
      const parent = (row as { order_returns?: { status?: string } | { status?: string }[] }).order_returns;
      const status = Array.isArray(parent) ? parent[0]?.status : parent?.status;
      if (status === "denied" || status === "closed") return map;
      const key = String((row as { order_item_id?: string }).order_item_id ?? "");
      map.set(key, (map.get(key) ?? 0) + Number((row as { requested_quantity?: number }).requested_quantity ?? 0));
      return map;
    }, new Map<string, number>());
  }

  const productIds = [...new Set((items.data || []).map((row) => row.product_id).filter(Boolean))] as string[];
  const customProducts = new Set<string>();
  if (productIds.length) {
    const { data: products } = await db()
      .from("products")
      .select("id,is_custom,made_to_order,purchase_mode")
      .in("id", productIds);
    for (const product of products || []) {
      const row = product as { id: string; is_custom?: boolean; made_to_order?: boolean; purchase_mode?: string };
      if (row.is_custom || row.made_to_order || row.purchase_mode === "request_only") customProducts.add(row.id);
    }
  }

  const lines: ReturnableLine[] = (items.data || []).map((row) => ({
    order_item_id: String(row.id),
    product_name: String(row.product_name),
    unit_price_cents: Number(row.unit_price_cents || 0),
    quantity: Number(row.quantity || 0),
    returned_quantity: returnedByItem.get(String(row.id)) ?? 0,
    is_custom: row.product_id ? customProducts.has(String(row.product_id)) : true,
  }));

  // The furthest-along job wins: one finished job and one not started means
  // work has started on this order.
  const jobStatuses = (jobs.data || []).map((row) => String(row.status));
  const productionStatus =
    ["completed", "ready_to_ship", "ready_for_pickup", "quality_check", "rework_required", "in_progress", "scheduled", "waiting_on_materials", "planning"].find(
      (candidate) => jobStatuses.includes(candidate)
    ) ?? (jobStatuses[0] || null);

  const openReturnRow = (returns.data || [])[0] as { id: string; status: string; return_number: string } | undefined;

  return {
    order: orderRow,
    policy,
    pendingRefundCents,
    refundableCents: refundableCents({ ...orderRow, pending_refund_cents: pendingRefundCents }),
    openCancellationRequest: (cancellation.data as OrderLifecycleContext["openCancellationRequest"]) ?? null,
    openReturn: openReturnRow ?? null,
    lines,
    productionStatus,
  };
}

// ---------------------------------------------------------------------------
// Refunds
// ---------------------------------------------------------------------------

export type RefundLeg = {
  refund_id: string;
  order_payment_id: string;
  payment_intent_id: string;
  amount_cents: number;
  idempotency_key: string;
  status: string;
  stripe_refund_id: string | null;
  replayed: boolean;
};

export type IssueRefundInput = {
  orderId: string;
  amountCents: number;
  kind: "manual" | "cancellation" | "return";
  reason: string;
  /**
   * Stable across retries of the *same logical action*. A staff click on
   * "Refund $40" must produce the same key however many times the browser
   * retries; a genuinely new refund must produce a different one.
   */
  idempotencyKey: string;
  actorUserId?: string | null;
  customerNote?: string | null;
  internalNote?: string | null;
  cancellationRequestId?: string | null;
  returnId?: string | null;
};

export type IssueRefundResult =
  | { ok: true; settledCents: number; pendingCents: number; failedCents: number; legs: RefundLeg[] }
  | { ok: false; error: string; refundableCents?: number };

const STRIPE_REFUND_STATUS: Record<string, "succeeded" | "pending" | "failed" | "canceled"> = {
  succeeded: "succeeded",
  pending: "pending",
  requires_action: "pending",
  failed: "failed",
  canceled: "canceled",
};

/**
 * Issue a refund, settling it against Stripe's answer rather than against the
 * fact that a request was sent.
 *
 * The claim happens first, in Postgres, under a row lock: `begin_order_refund`
 * writes one pending row per payment the refund draws from and refuses outright
 * if the amount exceeds what is left. Only then is Stripe called, once per leg,
 * with a per-leg idempotency key. Whatever Stripe says — succeeded, pending,
 * failed, or an exception — is written back through `settle_order_refund`, so a
 * leg never stays claimed by accident.
 */
export async function issueOrderRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents < 1) {
    return { ok: false, error: "Enter a refund amount of at least one cent." };
  }
  if (String(input.reason || "").trim().length < 3) {
    return { ok: false, error: "Give the refund a reason." };
  }

  const { data: claim, error: claimError } = await db().rpc("begin_order_refund", {
    p_order_id: input.orderId,
    p_amount_cents: input.amountCents,
    p_kind: input.kind,
    p_reason: input.reason,
    p_base_idempotency_key: input.idempotencyKey,
    p_initiated_by: input.actorUserId ?? null,
    p_customer_note: input.customerNote ?? null,
    p_internal_note: input.internalNote ?? null,
    p_cancellation_request_id: input.cancellationRequestId ?? null,
    p_return_id: input.returnId ?? null,
  });

  if (claimError) {
    logLifecycleFailure("begin_order_refund", claimError, { orderId: input.orderId });
    const message = String((claimError as { message?: string }).message || "");
    if (message.includes("refund_exceeds_recorded_payments")) {
      return {
        ok: false,
        error: "This order's payment records cannot cover that refund. Refund it in Stripe, then reconcile the order.",
      };
    }
    return { ok: false, error: "Could not start the refund. Nothing was sent to Stripe." };
  }

  const claimResult = claim as { ok?: boolean; error?: string; refundable_cents?: number; legs?: RefundLeg[] } | null;
  if (!claimResult?.ok) {
    return {
      ok: false,
      error: "That is more than this order has left to refund.",
      refundableCents: Number(claimResult?.refundable_cents ?? 0),
    };
  }

  const legs = (claimResult.legs || []) as RefundLeg[];
  let settledCents = 0;
  let pendingCents = 0;
  let failedCents = 0;

  for (const leg of legs) {
    // A replayed leg that Stripe already settled needs no second call.
    if (leg.status === "succeeded") {
      settledCents += leg.amount_cents;
      continue;
    }

    let stripeStatus: "succeeded" | "pending" | "failed" | "canceled" = "failed";
    let stripeRefundId: string | null = leg.stripe_refund_id;
    let failureCode: string | null = null;
    let failureMessage: string | null = null;
    let settledAmount = leg.amount_cents;

    try {
      const refund = await stripeClient().refunds.create(
        {
          payment_intent: leg.payment_intent_id,
          amount: leg.amount_cents,
          reason: "requested_by_customer",
          metadata: {
            order_id: input.orderId,
            refund_id: leg.refund_id,
            kind: input.kind,
            actor: String(input.actorUserId || "system"),
          },
        },
        // Stripe's own idempotency, keyed identically to ours, so a retried
        // fetch cannot create a second refund on Stripe's side either.
        { idempotencyKey: leg.idempotency_key }
      );
      stripeRefundId = refund.id;
      stripeStatus = STRIPE_REFUND_STATUS[String(refund.status)] ?? "pending";
      if (typeof refund.amount === "number" && refund.amount > 0) settledAmount = refund.amount;
      failureCode = refund.failure_reason ? String(refund.failure_reason) : null;
    } catch (error) {
      // The claim must not stay pending: an unreleased hold would block every
      // later refund on this order for good.
      stripeStatus = "failed";
      failureCode = (error as { code?: string })?.code ?? "stripe_error";
      failureMessage = (error as { message?: string })?.message?.slice(0, 500) ?? "Stripe rejected the refund.";
      logLifecycleFailure("stripe_refund_create", error, { orderId: input.orderId, refundId: leg.refund_id });
    }

    const { error: settleError } = await db().rpc("settle_order_refund", {
      p_refund_id: leg.refund_id,
      p_stripe_refund_id: stripeRefundId,
      p_stripe_status: stripeStatus,
      p_amount_cents: stripeStatus === "succeeded" ? settledAmount : null,
      p_failure_code: failureCode,
      p_failure_message: failureMessage,
    });

    if (settleError) {
      // Stripe may well have taken the refund. The webhook reconciles it, so
      // this is loud but not fatal.
      logLifecycleFailure("settle_order_refund", settleError, { orderId: input.orderId, refundId: leg.refund_id });
      pendingCents += leg.amount_cents;
      continue;
    }

    if (stripeStatus === "succeeded") settledCents += settledAmount;
    else if (stripeStatus === "pending") pendingCents += leg.amount_cents;
    else failedCents += leg.amount_cents;
  }

  return { ok: true, settledCents, pendingCents, failedCents, legs };
}

/** Refunds already sent to Stripe and not yet confirmed, for one order. */
export async function pendingRefundCentsFor(orderId: string): Promise<number> {
  const { data } = await db()
    .from("order_refunds")
    .select("requested_amount_cents,amount_cents")
    .eq("order_id", orderId)
    .eq("status", "pending");
  return (data || []).reduce((sum, row) => sum + Number(row.requested_amount_cents ?? row.amount_cents ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Applying a cancellation
// ---------------------------------------------------------------------------

export type ApplyCancellationInput = {
  orderId: string;
  actorUserId: string | null;
  reason: string;
  cancellationStatus: "completed" | "refund_pending" | "refund_failed";
  cancellationRequestId?: string | null;
  restockInventory?: boolean;
  restoreDiscount?: boolean;
};

/**
 * Move an order into its cancelled shape and unwind what the order was holding.
 *
 * Inventory comes back only for what the ledger says was actually committed,
 * and the discount redemption is released only when policy asks for it. Both
 * are idempotent, so a retried request cannot restock twice.
 */
export async function applyOrderCancellation(input: ApplyCancellationInput) {
  const now = new Date().toISOString();

  const { data: updated, error } = await db()
    .from("orders")
    .update({
      status: "cancelled",
      cancellation_status: input.cancellationStatus,
      cancelled_at: now,
      cancelled_by: input.actorUserId,
      cancellation_reason: input.reason.slice(0, 1000),
      fulfillment_status: "not_required",
      stripe_checkout_session_id: null,
      updated_at: now,
    })
    .eq("id", input.orderId)
    .neq("status", "cancelled")
    .select("id")
    .maybeSingle();

  if (error) {
    logLifecycleFailure("apply_cancellation", error, { orderId: input.orderId });
    return { ok: false as const, error: "Could not cancel the order." };
  }

  // `updated` being null means it was already cancelled — a double submission.
  // The unwinding below is idempotent, so running it again is harmless, but
  // there is nothing to unwind that was not unwound the first time.
  if (!updated) return { ok: true as const, alreadyCancelled: true };

  await db().from("order_status_history").insert({
    order_id: input.orderId,
    from_status: null,
    to_status: "cancelled",
    changed_by: input.actorUserId,
    note: input.reason.slice(0, 500),
  });

  if (input.restockInventory !== false) {
    const { error: restoreError } = await db().rpc("restore_order_inventory", {
      p_order_id: input.orderId,
      p_reason: `Cancelled: ${input.reason}`.slice(0, 1000),
      p_cancellation_request_id: input.cancellationRequestId ?? null,
      p_created_by: input.actorUserId,
    });
    if (restoreError) logLifecycleFailure("restore_order_inventory", restoreError, { orderId: input.orderId });
  }

  if (input.restoreDiscount !== false) {
    const { error: discountError } = await db().rpc("release_order_discount", { p_order_id: input.orderId });
    if (discountError) logLifecycleFailure("release_order_discount", discountError, { orderId: input.orderId });
  }

  return { ok: true as const, alreadyCancelled: false };
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export type LifecycleNotification = {
  orderId: string;
  order: Pick<OrderLifecycleRow, "customer_id" | "guest_email" | "guest_name" | "product_name" | "order_number">;
  actorUserId: string | null;
  templateKey: CommerceEmailTemplateKey;
  /**
   * Stable per logical event. A replayed webhook computes the same key, and
   * `email_deliveries` upserts on it, so the customer gets one email.
   */
  eventKey: string;
  title: string;
  message: string;
  /** Customer-safe extra sentence. Never an internal note. */
  detail?: string;
  price?: string;
  href?: string;
  staffTitle?: string;
  staffMessage?: string;
  notifyStaff?: boolean;
  /**
   * Extra template variables, filtered through `filterCustomerVariables`.
   *
   * Pass 8 seeded five templates interpolating `{{carrier}}`,
   * `{{tracking_number}}`, `{{pickup_location}}`, `{{pickup_instructions}}`,
   * `{{fulfillment_method}}` and `{{date}}` — and nothing ever supplied any of
   * them, so a real shipped email read "has shipped with . Tracking number: ."
   * and the ready-for-pickup email had two blank paragraphs where the address
   * belongs. This is the channel that fills them.
   *
   * Deliberately filtered rather than spread: an open extras bag is how an
   * internal note reaches a customer under a new name.
   */
  extraVariables?: Record<string, string>;
};

/**
 * One customer email, one customer notification, and optionally a staff
 * notification — all keyed so a repeat delivery is a no-op.
 *
 * `detail` is the only free text that reaches the customer, and every caller
 * passes a sentence written for them. Internal notes are never routed here.
 */
export async function sendLifecycleNotification(input: LifecycleNotification) {
  try {
    /**
     * A guest order has no account, so there is no auth user to look up and no
     * bell for a notification to land in. Their address is on the order.
     *
     * The lookup is skipped rather than attempted with a null id: asking the
     * admin API for user `null` is a request that can only fail, and a failure
     * here is swallowed by the catch below — so it would present as a customer
     * silently not being told their refund completed.
     */
    const [authUserResult, config] = await Promise.all([
      input.order.customer_id
        ? db().auth.admin.getUserById(input.order.customer_id)
        : Promise.resolve({ data: null }),
      getCommerceEmailConfig(),
    ]);
    const authUser = authUserResult.data;
    const recipient = input.order.customer_id
      ? authUser?.user?.email
      : input.order.guest_email ?? undefined;
    const displayName = input.order.customer_id
      ? authUser?.user?.user_metadata?.display_name || authUser?.user?.email?.split("@")[0] || "Customer"
      : input.order.guest_name?.trim() || input.order.guest_email?.split("@")[0] || "Customer";

    if (config.sendStatusUpdates !== false) {
      await sendCommerceEmail({
        to: recipient,
        orderId: input.orderId,
        templateKey: input.templateKey,
        eventKey: input.eventKey,
        href: input.href,
        variables: {
          customer_name: displayName,
          product_name: input.order.product_name,
          order_label: input.order.order_number || "your KeyMoura order",
          detail: input.detail || "",
          price: input.price || "",
          status: input.title,
          ...filterCustomerVariables(input.extraVariables ?? {}),
        },
      });
    }

    if (input.order.customer_id) {
      await notifyOrderUser({
        orderId: input.orderId,
        actorUserId: input.actorUserId,
        recipientUserId: input.order.customer_id,
        title: input.title,
        message: input.message,
      });
    }

    if (input.notifyStaff) {
      await notifyOrderStaff({
        orderId: input.orderId,
        actorUserId: input.actorUserId,
        title: input.staffTitle || input.title,
        message: input.staffMessage || input.message,
      });
    }
  } catch (error) {
    // A notification failure must never undo a completed financial action.
    logLifecycleFailure("lifecycle_notification", error, { orderId: input.orderId, template: input.templateKey });
  }
}

/**
 * One email to the configured staff alert address.
 *
 * Separate from `sendLifecycleNotification`, which is the *customer* path. A
 * staff alert has a different recipient, a different template, a different
 * deep link and — importantly — a different privacy rule: it may name the
 * order, but it still carries no internal note, no customer address and no
 * Stripe identifier, because the alert mailbox is not the order page.
 *
 * Silent when no staff address is configured. That is not a failure: a shop
 * that has not set one has chosen the in-app bell, which always fires.
 */
export async function notifyStaffEmail(input: {
  templateKey: CommerceEmailTemplateKey;
  eventKey: string;
  orderId: string;
  order: Pick<OrderLifecycleRow, "product_name" | "order_number">;
  detail?: string;
  price?: string;
  status?: string;
  href?: string;
}): Promise<void> {
  try {
    const config = await getCommerceEmailConfig();
    if (!config.staffNotificationEmail) return;
    await sendCommerceEmail({
      to: config.staffNotificationEmail,
      orderId: input.orderId,
      templateKey: input.templateKey,
      eventKey: input.eventKey,
      href: input.href ?? `/staff/orders/${input.orderId}`,
      variables: {
        customer_name: "",
        product_name: input.order.product_name,
        order_label: input.order.order_number || "an order",
        status: input.status || "",
        price: input.price || "",
        detail: input.detail || "",
      },
    });
  } catch (error) {
    logLifecycleFailure("staff_email", error, { orderId: input.orderId, template: input.templateKey });
  }
}

/**
 * Audit events for the lifecycle.
 *
 * All `staff.`-prefixed, because `logAuditEvent` drops anything that is not
 * admin/security/moderation/staff — a differently prefixed type is silently
 * discarded. Note bodies are never copied in: the audit log is read more
 * widely than the order page.
 */
export const LIFECYCLE_AUDIT_EVENTS = [
  "staff.order.cancellation_requested",
  "staff.order.cancellation_withdrawn",
  "staff.order.cancellation_approved",
  "staff.order.cancellation_denied",
  "staff.order.cancelled",
  "staff.order.refund_requested",
  "staff.order.refund_sent",
  "staff.order.refund_confirmed",
  "staff.order.refund_failed",
  "staff.order.return_requested",
  "staff.order.return_approved",
  "staff.order.return_denied",
  "staff.order.return_received",
  "staff.order.return_inspected",
  "staff.order.return_closed",
  "staff.order.fulfillment_changed",
  "staff.order.tracking_added",
  "staff.order.tracking_corrected",
  "staff.inventory.adjusted",
  "staff.inventory.committed",
  "staff.inventory.restored",
  "staff.commerce.policy_changed",
  "staff.order.email_resent",
] as const;

export type LifecycleAuditEvent = (typeof LIFECYCLE_AUDIT_EVENTS)[number];

export async function logLifecycleAudit(input: {
  eventType: LifecycleAuditEvent;
  actorUserId: string | null;
  actorRole?: string | null;
  orderId: string;
  /**
   * KM-0012. Supplied by callers that already hold the order, so the log reads
   * without a second query per row.
   */
  orderNumber?: string | null;
  /**
   * The before/after pair for this transition, when there is one. A refund or a
   * fulfillment move has a genuine two-state change; a "return received" does
   * not, and passing nothing is correct there.
   */
  changes?: ChangeSet;
  metadata?: Record<string, string | number | boolean | null>;
}) {
  await recordAuditEvent({
    action: input.eventType,
    actor: input.actorUserId
      ? {
          kind: "staff",
          userId: input.actorUserId,
          role: input.actorRole ?? "staff",
          label: await resolveActorLabel(input.actorUserId),
        }
      : // A lifecycle step with no actor is the system reconciling itself —
        // usually a Stripe webhook landing. It is not attributed to a person.
        { kind: "system" },
    entity: {
      type: "order",
      id: input.orderId,
      label: input.orderNumber?.trim() || `Order ${input.orderId.slice(0, 8)}`,
    },
    related: { orderId: input.orderId },
    changes: input.changes ?? {},
    metadata: input.metadata ?? {},
    source: "staff_ui",
  });
}

export const moneyText = (cents: number) => `$${(Math.max(0, cents) / 100).toFixed(2)}`;
