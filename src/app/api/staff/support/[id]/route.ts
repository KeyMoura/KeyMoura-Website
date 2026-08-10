import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  canChangeStatus,
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  statusTimestamps,
} from "@/lib/support/domain";
import {
  appendSupportMessage,
  isConversationId,
  isUuid,
  loadConversation,
  logSupportFailure,
  MESSAGE_COLUMNS,
  notifyCustomerOfResolution,
  recordSupportAudit,
  type ConversationRow,
} from "@/lib/support/server";

/**
 * One conversation, as staff work it — and the single endpoint that changes its
 * state.
 *
 * ## GET
 *
 * Returns the **whole** thread, internal notes included. That is the difference
 * between this route and `/api/support/conversations/[id]`, and it is why the
 * two are separate files rather than one route with a role branch: a shared
 * handler that decides what to include from who is asking is exactly the shape
 * that leaks a note the day somebody adds a third caller.
 *
 * ## PATCH
 *
 * Status, priority, category and the linked order. Every one is **stale-state
 * guarded**: the request carries what the client believed the value was, and the
 * update is `.eq()`-ed on it. Two staff members deciding at once produce one
 * change and one 409, rather than the second silently overwriting the first
 * without either of them knowing.
 *
 * Each field is a separate decision with a separate audit event. A single
 * `support.updated` carrying a bag of changes would make "who resolved this"
 * a question you answer by reading JSON.
 */

export const runtime = "nodejs";

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const notFound = () => NextResponse.json({ error: "Not found" }, { status: 404 });
const conflict = (error: string) => NextResponse.json({ error, stale: true }, { status: 409 });

// ---------------------------------------------------------------------------
// GET
// ---------------------------------------------------------------------------

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "support.view");
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!isConversationId(id)) return notFound();

  const conversation = await loadConversation(id);
  if (!conversation) return notFound();

  const [{ data: messages, error: messagesError }, related, customer] = await Promise.all([
    routeServiceClient
      .from("support_messages")
      .select(MESSAGE_COLUMNS)
      .eq("conversation_id", id)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(500),
    loadRelatedOrder(conversation.related_order_id),
    loadCustomerSummary(conversation.customer_id),
  ]);

  if (messagesError) {
    logSupportFailure("staff.thread", messagesError);
    return NextResponse.json({ error: "Could not load this conversation." }, { status: 500 });
  }

  return NextResponse.json({
    conversation: {
      ...conversation,
      relatedOrder: related,
      customer,
    },
    messages: messages ?? [],
    // What this particular viewer may do, so the workspace can hide a control
    // rather than offer one that refuses when pressed.
    can: {
      reply: actor.permissions.has("support.reply"),
      manage: actor.permissions.has("support.manage"),
      assign: actor.permissions.has("support.assign"),
    },
  });
}

async function loadRelatedOrder(orderId: string | null) {
  if (!orderId) return null;
  const { data } = await routeServiceClient
    .from("orders")
    .select("id,order_number,product_name,status,payment_status,fulfillment_status,created_at,customer_id,guest_email")
    .eq("id", orderId)
    .maybeSingle();
  return data ?? null;
}

/**
 * Enough about the customer to answer "who is this?" without leaving the page,
 * and no more.
 *
 * Counts and a link, not a second copy of the user workspace. `/staff/users/[id]`
 * is where a customer's full history lives, and duplicating it here would mean
 * two places to keep right.
 */
async function loadCustomerSummary(customerId: string | null) {
  if (!customerId) return null;
  const [{ data: profile }, { count: orderCount }, { count: conversationCount }] = await Promise.all([
    routeServiceClient
      .from("profiles")
      .select("id,display_name,username,avatar_url,is_verified,created_at")
      .eq("id", customerId)
      .maybeSingle(),
    routeServiceClient.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customerId),
    routeServiceClient
      .from("support_conversations")
      .select("id", { count: "exact", head: true })
      .eq("customer_id", customerId),
  ]);
  if (!profile) return null;
  return { ...profile, orderCount: orderCount ?? 0, conversationCount: conversationCount ?? 0 };
}

// ---------------------------------------------------------------------------
// PATCH
// ---------------------------------------------------------------------------

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requireAnyPermission(req, ["support.manage"]);
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!isConversationId(id)) return notFound();

  const conversation = await loadConversation(id);
  if (!conversation) return notFound();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  if ("status" in body) return changeStatus(actor, conversation, body);
  if ("priority" in body) return changePriority(actor, conversation, body);
  if ("category" in body) return changeCategory(actor, conversation, body);
  if ("relatedOrderId" in body) return changeOrder(actor, conversation, body);

  return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
}

type Actor = { userId: string; role: string };

// --- status ----------------------------------------------------------------

async function changeStatus(actor: Actor, conversation: ConversationRow, body: Record<string, unknown>) {
  const next = body.status;
  if (!isSupportStatus(next)) return NextResponse.json({ error: "That is not a status." }, { status: 400 });

  const decision = canChangeStatus(conversation.status, next);
  if (!decision.allowed) return NextResponse.json({ error: decision.error }, { status: 400 });

  if (body.expectedStatus !== conversation.status) {
    return conflict("Somebody else changed this conversation while you were looking at it. Reload and try again.");
  }

  const now = new Date().toISOString();
  const { data, error } = await routeServiceClient
    .from("support_conversations")
    .update({ status: next, ...statusTimestamps(next, now) })
    .eq("id", conversation.id)
    // The guard. Without it two staff members pressing Resolve and Close at the
    // same moment both report success and one of them is wrong.
    .eq("status", conversation.status)
    .select("id")
    .maybeSingle();

  if (error) {
    logSupportFailure("status.change", error);
    return NextResponse.json({ error: "Could not change the status." }, { status: 500 });
  }
  if (!data) {
    return conflict("Somebody else changed this conversation while you were looking at it. Reload and try again.");
  }

  /*
   * Three actions, not one, because they answer different questions.
   *
   * `support.resolved` and `support.reopened` are the two a person looks for;
   * everything else is `support.status_changed`. Filing all of them under one
   * name would mean finding "when was this resolved" by reading change sets.
   */
  const action =
    next === "resolved"
      ? "support.resolved"
      : conversation.status === "resolved" || conversation.status === "closed"
        ? "support.reopened"
        : "support.status_changed";

  const audited = await recordSupportAudit({
    action,
    actorUserId: actor.userId,
    actorRole: actor.role,
    conversation,
    changes: { status: { before: conversation.status, after: next } },
  });

  // A system message, so the customer's own thread records that we closed it
  // rather than the conversation simply going quiet. Only for these two
  // transitions — assignment and priority are internal and are in the audit log.
  if (next === "resolved" || action === "support.reopened") {
    await appendSupportMessage({
      conversationId: conversation.id,
      authorType: "system",
      authorUserId: null,
      authorLabel: "KeyMoura",
      visibility: "customer",
      body:
        next === "resolved"
          ? "This request was marked resolved. Reply here if anything is still outstanding."
          : "This request was reopened.",
    });
  }

  if (next === "resolved") {
    await notifyCustomerOfResolution({ conversation, resolvedAt: now }).catch((error: unknown) =>
      logSupportFailure("resolved.email", error)
    );
  }

  return NextResponse.json({ ok: true, status: next, auditFailed: !audited });
}

// --- priority --------------------------------------------------------------

async function changePriority(actor: Actor, conversation: ConversationRow, body: Record<string, unknown>) {
  const next = body.priority;
  if (!isSupportPriority(next)) return NextResponse.json({ error: "That is not a priority." }, { status: 400 });
  if (next === conversation.priority) {
    return NextResponse.json({ error: `Already ${next}.` }, { status: 400 });
  }
  if (body.expectedPriority !== conversation.priority) {
    return conflict("Somebody else changed the priority while you were looking at it. Reload and try again.");
  }

  const { data, error } = await routeServiceClient
    .from("support_conversations")
    .update({ priority: next })
    .eq("id", conversation.id)
    .eq("priority", conversation.priority)
    .select("id")
    .maybeSingle();

  if (error) {
    logSupportFailure("priority.change", error);
    return NextResponse.json({ error: "Could not change the priority." }, { status: 500 });
  }
  if (!data) return conflict("Somebody else changed the priority while you were looking at it. Reload and try again.");

  const audited = await recordSupportAudit({
    action: "support.priority_changed",
    actorUserId: actor.userId,
    actorRole: actor.role,
    conversation,
    changes: { priority: { before: conversation.priority, after: next } },
  });

  // Deliberately silent to the customer. How urgent we privately think their
  // question is is a routing decision, not news.
  return NextResponse.json({ ok: true, priority: next, auditFailed: !audited });
}

// --- category --------------------------------------------------------------

async function changeCategory(actor: Actor, conversation: ConversationRow, body: Record<string, unknown>) {
  const next = body.category;
  if (!isSupportCategory(next)) return NextResponse.json({ error: "That is not a category." }, { status: 400 });
  if (next === conversation.category) return NextResponse.json({ error: "Already that category." }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("support_conversations")
    .update({ category: next })
    .eq("id", conversation.id)
    .eq("category", conversation.category)
    .select("id")
    .maybeSingle();

  if (error) {
    logSupportFailure("category.change", error);
    return NextResponse.json({ error: "Could not change the category." }, { status: 500 });
  }
  if (!data) return conflict("Somebody else changed the category. Reload and try again.");

  const audited = await recordSupportAudit({
    action: "support.category_changed",
    actorUserId: actor.userId,
    actorRole: actor.role,
    conversation,
    changes: { category: { before: conversation.category, after: next } },
  });

  return NextResponse.json({ ok: true, category: next, auditFailed: !audited });
}

// --- the linked order ------------------------------------------------------

/**
 * Linking or unlinking the related order.
 *
 * A staff member may link **any** order, and that is deliberate: they are the
 * ones who can see both records and decide, and the common case is a guest who
 * described their order in prose because they could not attach it. What they
 * cannot do is link something that does not exist, and what the *customer*
 * cannot do is link an order they do not own — which is enforced in the create
 * route, where it belongs.
 *
 * The audit event carries both ids, so a wrong link is traceable to whoever made
 * it and reversible with the knowledge of what it replaced.
 */
async function changeOrder(actor: Actor, conversation: ConversationRow, body: Record<string, unknown>) {
  const raw = body.relatedOrderId;
  const next = typeof raw === "string" && raw.trim() ? raw.trim() : null;

  if (next === conversation.related_order_id) {
    return NextResponse.json({ error: "That order is already linked." }, { status: 400 });
  }

  let nextNumber: string | null = null;
  if (next) {
    if (!isUuid(next)) return NextResponse.json({ error: "That is not an order." }, { status: 400 });
    const { data: order } = await routeServiceClient
      .from("orders")
      .select("id,order_number")
      .eq("id", next)
      .maybeSingle<{ id: string; order_number: string | null }>();
    if (!order) return NextResponse.json({ error: "That order no longer exists." }, { status: 404 });
    nextNumber = order.order_number;
  }

  const guard = routeServiceClient
    .from("support_conversations")
    .update({ related_order_id: next })
    .eq("id", conversation.id);

  const { data, error } = await (conversation.related_order_id
    ? guard.eq("related_order_id", conversation.related_order_id)
    : guard.is("related_order_id", null)
  )
    .select("id")
    .maybeSingle();

  if (error) {
    logSupportFailure("order.link", error);
    return NextResponse.json({ error: "Could not change the linked order." }, { status: 500 });
  }
  if (!data) return conflict("Somebody else changed the linked order. Reload and try again.");

  const audited = await recordSupportAudit({
    action: next ? "support.order_linked" : "support.order_unlinked",
    actorUserId: actor.userId,
    actorRole: actor.role,
    // The *new* order is what the event relates to, so an audit row about
    // linking shows up beside the order it was linked to.
    conversation: { ...conversation, related_order_id: next ?? conversation.related_order_id },
    changes: { related_order_id: { before: conversation.related_order_id, after: next } },
  });

  return NextResponse.json({ ok: true, relatedOrderId: next, relatedOrderNumber: nextNumber, auditFailed: !audited });
}
