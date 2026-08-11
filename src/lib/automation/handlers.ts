import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { sendCommerceEmail } from "@/lib/commerceEmail";
import { resolveOrderRecipient } from "@/lib/commerce/orderLifecycleServer";
import { raiseOperationalAlert } from "@/lib/comms/operationalAlerts";
import { createNotification } from "@/lib/notifications";
import { recordAuditEvent } from "@/lib/audit/events";
import { daysBetween, hoursBetween, type AutomationJobType } from "./catalogue";
import type { AutomationSettings } from "./settings";
import { completedOccurrences, type ScheduledJob } from "./store";
import { AUTOMATION_JOBS_BY_TYPE } from "./catalogue";

/**
 * Doing the work, and refusing to.
 *
 * ## The rule this file exists for
 *
 * **A reminder is never sent because a job row says so.** Every handler reloads
 * the entity it is about and re-asks whether the reminder is still true, at the
 * moment it would fire. A job scheduled at 09:00 for 09:00 tomorrow is a
 * statement about the world as it was; twenty-four hours is plenty of time for a
 * customer to pay the invoice, collect the parcel, or reply to the message the
 * reminder is about to chase them for.
 *
 * Discovery already avoids queueing obviously-dead work and the state-change
 * hooks already cancel it, but neither is the guarantee. This is. If the two
 * other mechanisms both fail, the worst outcome is a job that reaches here and
 * is cancelled — which is a row in a table, not an email to a customer.
 *
 * ## Ineligible is not a failure
 *
 * `ineligible` is the single most common successful outcome of this whole
 * system, and it is reported as its own thing rather than as an error. A quote
 * that got paid before its reminder fired is the system working. Counting it as
 * a failure would make the health page red on a good day.
 */

const db = () => routeServiceClient;

export type HandlerResult =
  /** Something was sent, or an alert was raised. */
  | { outcome: "sent"; summary: string }
  /**
   * Correctly did nothing, and the job is finished. Either the send was already
   * claimed upstream by `email_deliveries`, or the cap for this entity is spent.
   */
  | { outcome: "skipped"; summary: string }
  /** The world moved on. The job is cancelled, not retried. */
  | { outcome: "ineligible"; reason: string }
  | { outcome: "failed"; category: "transient" | "invalid_recipient" | "configuration" | "unknown"; error: string };

export type HandlerContext = {
  job: ScheduledJob;
  settings: AutomationSettings;
  /**
   * The shop's configured display zone, from `commerce_settings.business`.
   *
   * Passed in rather than read from `settings`, because `AutomationSettings`
   * deliberately holds no timezone: every threshold it describes is a duration
   * applied to UTC instants, and a zone sitting in that object would invite
   * somebody to compute one against it. This is for turning an instant into
   * words on the one line of an email that shows a date.
   */
  timezone: string;
};

/**
 * Order columns every order handler needs.
 *
 * Notice what is absent: `staff_notes`, `fulfillment_notes` and every Stripe
 * identifier. These handlers write customer-facing email, and a column that is
 * never selected is a column that cannot be interpolated into one by accident.
 */
const ORDER_FIELDS =
  "id,order_number,product_name,customer_id,guest_email,guest_name,status,payment_status," +
  "quote_expires_at,quote_accepted_at,agreed_price_cents,cancelled_at,ready_at,picked_up_at," +
  "fulfillment_status,fulfillment_method,pickup_location_snapshot";

type OrderRow = {
  id: string;
  order_number: string | null;
  product_name: string;
  customer_id: string | null;
  guest_email: string | null;
  guest_name: string | null;
  status: string;
  payment_status: string;
  quote_expires_at: string | null;
  quote_accepted_at: string | null;
  agreed_price_cents: number | null;
  cancelled_at: string | null;
  ready_at: string | null;
  picked_up_at: string | null;
  fulfillment_status: string;
  fulfillment_method: string;
  pickup_location_snapshot: Record<string, unknown> | null;
};

function money(cents: number | null): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "";
  return `$${(cents / 100).toFixed(2)}`;
}

/** A date a customer can read, in the shop's own words rather than an ISO string. */
function readableDate(value: string | null | undefined, timezone: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  try {
    /*
     * The one place a timezone is consulted, and it is for *display only*.
     * Every threshold in this system is computed from UTC instants; this turns
     * one of those instants into words for a person, using the shop's own
     * configured zone rather than the server's incidental one.
     */
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "long",
      timeZone: timezone || "UTC",
    }).format(parsed);
  } catch {
    return parsed.toISOString().slice(0, 10);
  }
}

/**
 * The customer notification that accompanies a reminder email.
 *
 * Account holders only: a guest has no bell for it to land in. Keyed on the
 * job's own dedupe key, so the notification inherits the email's idempotency
 * rather than inventing a weaker one.
 */
async function notifyCustomer(job: ScheduledJob, orderId: string, title: string, message: string) {
  const { data } = await db().from("orders").select("customer_id").eq("id", orderId).maybeSingle();
  const customerId = (data as { customer_id: string | null } | null)?.customer_id;
  if (!customerId) return;
  await createNotification({
    recipientUserId: customerId,
    actorUserId: null,
    type: "order",
    eventKey: `automation:${job.dedupe_key}`,
    payload: { title, message, href: `/orders/${orderId}` },
  }).catch(() => undefined);
}

/**
 * Record that a customer was actually written to.
 *
 * Customer sends only. A staff bell ringing does not need an audit trail, and
 * the worker's own heartbeat certainly does not — `automation_runs` holds that.
 * The actor is `scheduled`, never a staff user: nobody pressed anything, and
 * attributing this to the last person who touched the order would be a lie that
 * survives in the permanent record.
 */
async function auditReminder(job: ScheduledJob, entityLabel: string, summary: string) {
  await recordAuditEvent({
    action: "automation.reminder_sent",
    actor: { kind: "scheduled", job: job.job_type },
    entity: { type: job.entity_type, id: job.entity_id, label: entityLabel },
    related: job.entity_type === "order" ? { orderId: job.entity_id } : {},
    summary,
    source: "job",
    metadata: { job_type: job.job_type, dedupe_key: job.dedupe_key },
  }).catch(() => undefined);
}

async function loadOrder(orderId: string | null): Promise<OrderRow | null> {
  if (!orderId) return null;
  const { data } = await db().from("orders").select(ORDER_FIELDS).eq("id", orderId).maybeSingle();
  return (data as OrderRow | null) ?? null;
}

/**
 * Turn a send result into a handler result.
 *
 * `suppressed` means `email_deliveries` already had this event key and refused
 * to send it twice — which is the duplicate guard working, so the job is
 * finished rather than failed. This is the second of the two layers: the job
 * table stops the work being scheduled twice, the delivery table stops the
 * message leaving twice, and this line is where the worker learns the latter
 * caught something.
 */
function fromSend(
  result: { sent: boolean; suppressed?: boolean; category?: string },
  summary: string
): HandlerResult {
  if (result.sent) return { outcome: "sent", summary };
  if (result.suppressed) return { outcome: "skipped", summary: "Already delivered; nothing re-sent." };
  const category = result.category;
  if (category === "invalid_recipient") {
    return { outcome: "failed", category: "invalid_recipient", error: "The recipient address was refused." };
  }
  if (category === "not_configured" || category === "disabled") {
    return {
      outcome: "failed",
      category: "configuration",
      error: `Email is ${category === "disabled" ? "switched off" : "not configured"}.`,
    };
  }
  if (category === "provider_unavailable" || category === "rate_limited") {
    return { outcome: "failed", category: "transient", error: `The email provider was ${category.replace(/_/g, " ")}.` };
  }
  return { outcome: "failed", category: "unknown", error: "The email was not accepted." };
}

/** Whether this entity has already had all the reminders of this type it may have. */
async function capReached(type: AutomationJobType, entityId: string): Promise<boolean> {
  const max = AUTOMATION_JOBS_BY_TYPE[type].maxOccurrences;
  if (max === null) return false;
  return (await completedOccurrences(type, entityId)) >= max;
}

// ---------------------------------------------------------------------------
// Quotes
// ---------------------------------------------------------------------------

/**
 * The eligibility question for both quote jobs, asked once.
 *
 * Every branch here is a reason the brief names explicitly: paid, withdrawn,
 * cancelled, superseded, or rescheduled. The last one is the subtle one — a job
 * carries the expiry it was scheduled against in its metadata, and if the order
 * now says something different then this job is about a deadline that no longer
 * exists. Sending it would tell a customer their quote expires on a date it does
 * not.
 */
function quoteEligibility(order: OrderRow | null, job: ScheduledJob): string | null {
  if (!order) return "The order no longer exists.";
  if (order.cancelled_at) return "The order was cancelled.";
  if (["cancelled", "declined", "completed"].includes(order.status)) {
    return `The order moved to ${order.status}.`;
  }
  if (["paid", "partial", "refunded", "partially_refunded"].includes(order.payment_status)) {
    return "The quote was paid.";
  }
  if (!order.quote_expires_at) return "The quote no longer has an expiry.";

  const scheduledFor = job.metadata?.expires_at;
  if (typeof scheduledFor === "string" && scheduledFor.slice(0, 16) !== order.quote_expires_at.slice(0, 16)) {
    return "The quote expiry was changed after this reminder was scheduled.";
  }
  return null;
}

async function handleQuoteExpiryWarning(context: HandlerContext): Promise<HandlerResult> {
  const order = await loadOrder(context.job.entity_id);
  const reason = quoteEligibility(order, context.job);
  if (reason) return { outcome: "ineligible", reason };
  if (!order) return { outcome: "ineligible", reason: "The order no longer exists." };

  // Already expired by the time this ran — the warning is pointless and the
  // expiry job will speak for itself.
  if (Date.parse(order.quote_expires_at!) <= Date.now()) {
    return { outcome: "ineligible", reason: "The quote had already expired before the warning ran." };
  }

  const { recipient, displayName } = await resolveOrderRecipient(order);
  if (!recipient) return { outcome: "failed", category: "invalid_recipient", error: "No address on the order." };

  const label = order.order_number || "your KeyMoura order";
  const result = await sendCommerceEmail({
    to: recipient,
    orderId: order.id,
    templateKey: "quote_expiring",
    eventKey: `automation-quote-expiring-${order.id}-${order.quote_expires_at!.slice(0, 16).replace(/[:T-]/g, "")}`,
    variables: {
      customer_name: displayName,
      product_name: order.product_name,
      order_label: label,
      price: money(order.agreed_price_cents),
      date: readableDate(order.quote_expires_at, context.timezone),
      status: "Quote expiring",
    },
  });

  const handled = fromSend(result, `Warned about the quote on ${label} expiring.`);
  if (handled.outcome === "sent") {
    await notifyCustomer(context.job, order.id, "Your quote is expiring", `The quote for ${order.product_name} runs out soon.`);
    await auditReminder(context.job, label, `Quote expiry warning sent for ${label}.`);
  }
  return handled;
}

/**
 * The quote has lapsed.
 *
 * This handler is deliberately **not** the thing that decides what an expired
 * quote means. It records the expiry against the order's own history and tells
 * the customer; it does not cancel the order, void the price, or restock
 * anything. Those are decisions with money attached, and a scheduled job that
 * quietly makes them is a scheduled job that will one day make them wrongly.
 * Staff see the order in their queue as they always did.
 */
async function handleQuoteExpired(context: HandlerContext): Promise<HandlerResult> {
  const order = await loadOrder(context.job.entity_id);
  const reason = quoteEligibility(order, context.job);
  if (reason) return { outcome: "ineligible", reason };
  if (!order) return { outcome: "ineligible", reason: "The order no longer exists." };

  if (Date.parse(order.quote_expires_at!) > Date.now()) {
    return { outcome: "ineligible", reason: "The quote has not expired yet." };
  }

  const { recipient, displayName } = await resolveOrderRecipient(order);
  if (!recipient) return { outcome: "failed", category: "invalid_recipient", error: "No address on the order." };

  const label = order.order_number || "your KeyMoura order";
  const result = await sendCommerceEmail({
    to: recipient,
    orderId: order.id,
    templateKey: "status_update",
    eventKey: `automation-quote-expired-${order.id}-${order.quote_expires_at!.slice(0, 16).replace(/[:T-]/g, "")}`,
    variables: {
      customer_name: displayName,
      product_name: order.product_name,
      order_label: label,
      status: "Quote expired",
      detail:
        "The quote we sent has now run out. Nothing has been charged and nothing has been cancelled — if you would still like to go ahead, reply and we will re-quote at current prices.",
    },
  });

  const handled = fromSend(result, `Told the customer the quote on ${label} expired.`);
  if (handled.outcome === "sent") {
    // The order's own history is where "what happened to this order, and when"
    // lives. `changed_by` is null because nobody changed it — time did.
    await db()
      .from("order_status_history")
      .insert({
        order_id: order.id,
        from_status: order.status,
        to_status: order.status,
        changed_by: null,
        note: "Quote expired automatically.",
      })
      .then(undefined, () => undefined);
    await auditReminder(context.job, label, `Quote expiry recorded for ${label}.`);
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Orders waiting on the customer
// ---------------------------------------------------------------------------

const CUSTOMER_ACTION_DETAIL: Readonly<Record<string, string>> = {
  needs_information: "We need some more detail from you before we can carry on.",
  awaiting_payment: "Payment is outstanding, and work starts once it is settled.",
  customer_review: "There is something waiting for you to look over and approve.",
};

async function handleOrderActionRequired(context: HandlerContext): Promise<HandlerResult> {
  const order = await loadOrder(context.job.entity_id);
  if (!order) return { outcome: "ineligible", reason: "The order no longer exists." };
  if (order.cancelled_at) return { outcome: "ineligible", reason: "The order was cancelled." };
  if (!CUSTOMER_ACTION_DETAIL[order.status]) {
    return { outcome: "ineligible", reason: `The order moved on to ${order.status}.` };
  }
  if (order.status === "awaiting_payment" && ["paid", "partial"].includes(order.payment_status)) {
    return { outcome: "ineligible", reason: "The order was paid." };
  }
  if (await capReached("order_action_required", order.id)) {
    return { outcome: "skipped", summary: "This order has had every follow-up it is allowed." };
  }

  const { recipient, displayName } = await resolveOrderRecipient(order);
  if (!recipient) return { outcome: "failed", category: "invalid_recipient", error: "No address on the order." };

  const stage = Number(context.job.metadata?.stage ?? 1);
  const label = order.order_number || "your KeyMoura order";
  const result = await sendCommerceEmail({
    to: recipient,
    orderId: order.id,
    templateKey: "customer_action_required_reminder",
    eventKey: `automation-action-required-${order.id}-n${stage}`,
    variables: {
      customer_name: displayName,
      product_name: order.product_name,
      order_label: label,
      status: "Waiting on you",
      detail: CUSTOMER_ACTION_DETAIL[order.status],
    },
  });

  const handled = fromSend(result, `Follow-up ${stage} sent on ${label}.`);
  if (handled.outcome === "sent") {
    await notifyCustomer(context.job, order.id, "We are waiting on you", CUSTOMER_ACTION_DETAIL[order.status]);
    await auditReminder(context.job, label, `Customer action follow-up ${stage} sent for ${label}.`);
  }
  return handled;
}

// ---------------------------------------------------------------------------
// Pickup
// ---------------------------------------------------------------------------

async function handlePickupReminder(context: HandlerContext): Promise<HandlerResult> {
  const order = await loadOrder(context.job.entity_id);
  if (!order) return { outcome: "ineligible", reason: "The order no longer exists." };
  if (order.cancelled_at) return { outcome: "ineligible", reason: "The order was cancelled." };
  if (order.picked_up_at) return { outcome: "ineligible", reason: "The order was collected." };
  if (order.fulfillment_status !== "ready_for_pickup") {
    return { outcome: "ineligible", reason: `Fulfillment moved to ${order.fulfillment_status}.` };
  }
  if (!order.ready_at) return { outcome: "ineligible", reason: "The order is no longer marked ready." };

  const { recipient, displayName } = await resolveOrderRecipient(order);
  if (!recipient) return { outcome: "failed", category: "invalid_recipient", error: "No address on the order." };

  const day = Number(context.job.metadata?.day ?? 0);
  const label = order.order_number || "your KeyMoura order";
  const pickup = (order.pickup_location_snapshot ?? {}) as Record<string, unknown>;

  const result = await sendCommerceEmail({
    to: recipient,
    orderId: order.id,
    templateKey: "pickup_reminder",
    eventKey: `automation-pickup-reminder-${order.id}-day${day}`,
    variables: {
      customer_name: displayName,
      product_name: order.product_name,
      order_label: label,
      status: "Ready for collection",
      // The snapshot taken when the order was made ready, which is the address
      // the customer was already told to come to. Never the shipping origin.
      pickup_location: String(pickup.locationName ?? pickup.name ?? ""),
      pickup_instructions: String(pickup.instructions ?? ""),
      date: readableDate(order.ready_at, context.timezone),
    },
  });

  const handled = fromSend(result, `Day-${day} pickup reminder sent on ${label}.`);
  if (handled.outcome === "sent") {
    await notifyCustomer(context.job, order.id, "Your order is waiting", `${order.product_name} is ready to collect.`);
    await auditReminder(context.job, label, `Pickup reminder (day ${day}) sent for ${label}.`);
  }
  return handled;
}

/**
 * Staff-side: something has been sitting on the shelf too long.
 *
 * A notification, never an email. The people who need to know are the people
 * with `fulfillment.view`, and they read the bell all day; emailing them about
 * an internal delay is how a shop ends up with a rule that files KeyMoura mail
 * into a folder nobody opens.
 */
async function handlePickupStaleStaff(context: HandlerContext): Promise<HandlerResult> {
  const order = await loadOrder(context.job.entity_id);
  if (!order) return { outcome: "ineligible", reason: "The order no longer exists." };
  if (order.picked_up_at) return { outcome: "ineligible", reason: "The order was collected." };
  if (order.cancelled_at) return { outcome: "ineligible", reason: "The order was cancelled." };
  if (order.fulfillment_status !== "ready_for_pickup") {
    return { outcome: "ineligible", reason: `Fulfillment moved to ${order.fulfillment_status}.` };
  }

  const days = order.ready_at ? daysBetween(order.ready_at, new Date()) : 0;
  const label = order.order_number || "an order";
  await raiseOperationalAlert({
    kind: "fulfillment.pickup_uncollected",
    subjectId: order.id,
    discriminator: String(context.job.metadata?.waiting_days ?? days),
    message: `${label} has been ready for collection for ${days} days and has not been picked up.`,
  });
  return { outcome: "sent", summary: `Flagged ${label} as uncollected after ${days} days.` };
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

type ConversationRow = {
  id: string;
  reference: string;
  subject: string;
  status: string;
  requester_email: string | null;
  requester_label: string;
  customer_id: string | null;
  last_customer_message_at: string | null;
  last_staff_message_at: string | null;
  resolved_at: string | null;
  closed_at: string | null;
};

async function loadConversation(id: string | null): Promise<ConversationRow | null> {
  if (!id) return null;
  const { data } = await db()
    .from("support_conversations")
    .select(
      "id,reference,subject,status,requester_email,requester_label,customer_id," +
        "last_customer_message_at,last_staff_message_at,resolved_at,closed_at"
    )
    .eq("id", id)
    .maybeSingle();
  return (data as ConversationRow | null) ?? null;
}

async function handleSupportWaitingCustomer(context: HandlerContext): Promise<HandlerResult> {
  const conversation = await loadConversation(context.job.entity_id);
  if (!conversation) return { outcome: "ineligible", reason: "The conversation no longer exists." };
  if (conversation.status !== "waiting_on_customer") {
    return { outcome: "ineligible", reason: `The conversation moved to ${conversation.status}.` };
  }
  /*
   * The load-bearing check. If the customer replied after our last message, the
   * ball is back with us and reminding them to reply would be both wrong and
   * slightly insulting.
   */
  if (
    conversation.last_customer_message_at &&
    conversation.last_staff_message_at &&
    Date.parse(conversation.last_customer_message_at) > Date.parse(conversation.last_staff_message_at)
  ) {
    return { outcome: "ineligible", reason: "The customer has replied." };
  }
  if (!conversation.requester_email) {
    return { outcome: "failed", category: "invalid_recipient", error: "No address on the conversation." };
  }

  const days = context.settings.support.waitingOnCustomerDays;
  const result = await sendCommerceEmail({
    to: conversation.requester_email,
    orderId: null,
    templateKey: "support_waiting_customer",
    eventKey: `automation-support-waiting-${conversation.id}-day${days}`,
    href: `/support`,
    variables: {
      customer_name: conversation.requester_label,
      order_label: conversation.reference,
      // The customer's own subject line, returned to the customer who wrote it.
      support_reference: conversation.reference,
      support_subject: conversation.subject,
      status: "Waiting on you",
    },
  });

  const handled = fromSend(result, `Nudged ${conversation.reference} after ${days} days.`);
  if (handled.outcome === "sent") {
    await auditReminder(context.job, conversation.reference, `Support follow-up sent for ${conversation.reference}.`);
  }
  return handled;
}

async function handleSupportWaitingStaff(context: HandlerContext): Promise<HandlerResult> {
  const conversation = await loadConversation(context.job.entity_id);
  if (!conversation) return { outcome: "ineligible", reason: "The conversation no longer exists." };
  if (["resolved", "closed"].includes(conversation.status)) {
    return { outcome: "ineligible", reason: `The conversation is ${conversation.status}.` };
  }
  if (!["open", "waiting_on_staff"].includes(conversation.status)) {
    return { outcome: "ineligible", reason: `The conversation moved to ${conversation.status}.` };
  }
  if (
    conversation.last_staff_message_at &&
    conversation.last_customer_message_at &&
    Date.parse(conversation.last_staff_message_at) > Date.parse(conversation.last_customer_message_at)
  ) {
    return { outcome: "ineligible", reason: "A staff member has replied." };
  }

  const hours = conversation.last_customer_message_at
    ? hoursBetween(conversation.last_customer_message_at, new Date())
    : 0;

  /*
   * The reference and the elapsed time, and nothing else. Not the subject and
   * certainly not the body: this fans out to everyone holding `support.view`,
   * and a notification preview is rendered in a list, in a bell, and in any
   * screenshot of either.
   */
  await raiseOperationalAlert({
    kind: "support.waiting_on_staff",
    subjectId: conversation.id,
    discriminator: String(context.job.metadata?.waiting_since ?? hours),
    message: `${conversation.reference} has been waiting on a reply for ${hours} hours.`,
  });
  return { outcome: "sent", summary: `Flagged ${conversation.reference} as waiting ${hours} hours.` };
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

type ProductionRow = {
  id: string;
  job_number: string;
  status: string;
  due_date: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  updated_at: string;
};

async function loadProductionJob(id: string | null): Promise<ProductionRow | null> {
  if (!id) return null;
  const { data } = await db()
    .from("production_jobs")
    .select("id,job_number,status,due_date,completed_at,cancelled_at,updated_at")
    .eq("id", id)
    .maybeSingle();
  return (data as ProductionRow | null) ?? null;
}

/**
 * The three production alerts share their eligibility rules.
 *
 * All three are staff-only, and none of them tells a customer anything. A job
 * running late is an internal fact until somebody decides what to say about it;
 * automatically informing a customer that their order is late is a commitment
 * the shop has not made, and the brief is explicit that it needs a customer-facing
 * policy this project does not have.
 */
function productionEligibility(job: ProductionRow | null, scheduledDueDate: unknown): string | null {
  if (!job) return "The production job no longer exists.";
  if (job.completed_at || job.status === "completed") return "The job was completed.";
  if (job.cancelled_at || job.status === "cancelled") return "The job was cancelled.";
  if (typeof scheduledDueDate === "string" && job.due_date !== scheduledDueDate) {
    return "The due date was changed after this alert was scheduled.";
  }
  return null;
}

async function handleProductionAlert(
  context: HandlerContext,
  kind: "production_due_soon" | "production_overdue" | "production_blocked"
): Promise<HandlerResult> {
  const job = await loadProductionJob(context.job.entity_id);
  const reason = productionEligibility(
    job,
    kind === "production_blocked" ? undefined : context.job.metadata?.due_date
  );
  if (reason) return { outcome: "ineligible", reason };
  if (!job) return { outcome: "ineligible", reason: "The production job no longer exists." };

  let message: string;
  let discriminator: string;

  if (kind === "production_blocked") {
    if (!["waiting_on_customer", "waiting_on_materials", "on_hold"].includes(job.status)) {
      return { outcome: "ineligible", reason: `The job is no longer blocked; it is ${job.status}.` };
    }
    const hours = Number(context.job.metadata?.blocked_hours ?? 0);
    message = `${job.job_number} has been ${job.status.replace(/_/g, " ")} for ${hours} hours.`;
    discriminator = String(context.job.metadata?.status ?? job.status);
  } else if (kind === "production_overdue") {
    const late = Number(context.job.metadata?.days_late ?? 0);
    message =
      late <= 0
        ? `${job.job_number} has passed its due date.`
        : `${job.job_number} is ${late} day${late === 1 ? "" : "s"} overdue.`;
    discriminator = String(job.due_date ?? "");
  } else {
    message = `${job.job_number} is due on ${job.due_date}.`;
    discriminator = String(job.due_date ?? "");
  }

  await raiseOperationalAlert({
    kind:
      kind === "production_blocked"
        ? "production.blocked"
        : kind === "production_overdue"
          ? "production.overdue"
          : "production.due_soon",
    subjectId: job.id,
    discriminator,
    message,
  });
  return { outcome: "sent", summary: message };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * The one place a job type becomes an action.
 *
 * A `Record` keyed by the type rather than a `switch` with a `default`, so
 * adding a type to the catalogue without writing its handler is a type error
 * rather than a job that silently completes having done nothing.
 */
const HANDLERS: Readonly<Record<AutomationJobType, (context: HandlerContext) => Promise<HandlerResult>>> = {
  quote_expiry_warning: handleQuoteExpiryWarning,
  quote_expired: handleQuoteExpired,
  order_action_required: handleOrderActionRequired,
  pickup_reminder: handlePickupReminder,
  pickup_stale_staff: handlePickupStaleStaff,
  support_waiting_customer: handleSupportWaitingCustomer,
  support_waiting_staff: handleSupportWaitingStaff,
  production_due_soon: (context) => handleProductionAlert(context, "production_due_soon"),
  production_overdue: (context) => handleProductionAlert(context, "production_overdue"),
  production_blocked: (context) => handleProductionAlert(context, "production_blocked"),
};

export function handlerFor(
  type: string
): ((context: HandlerContext) => Promise<HandlerResult>) | null {
  return HANDLERS[type as AutomationJobType] ?? null;
}
