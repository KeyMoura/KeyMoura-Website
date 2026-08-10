import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { ownsConversation } from "@/lib/support/domain";
import { isConversationId, loadConversation, logSupportFailure } from "@/lib/support/server";

/**
 * One conversation, as its owner sees it.
 *
 * ## The internal-note filter is in the query
 *
 * `.eq("visibility", "customer")` runs in Postgres. An internal note is never
 * loaded into this process, never serialized, and never one refactor away from
 * being rendered — as opposed to fetching the thread and filtering it in
 * JavaScript, which is the version that works until somebody adds a `.map` above
 * the filter.
 *
 * ## What a customer is not told
 *
 * The staff author's user id and their real name. A reply is from **KeyMoura**;
 * which member of staff typed it is internal routing, and putting a named person
 * on a refund refusal invites a customer to direct their next message at them
 * personally. Priority and assignment are absent for the same reason.
 *
 * Guests are answered 401 here rather than given a path. A guest has no durable
 * credential for a conversation — the guest-order cookie authorises *an order*,
 * and most support conversations have no order — so there is nothing to check.
 * That is a stated gap, not an oversight: guests are replied to by email.
 */

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await context.params;
  if (!isConversationId(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const conversation = await loadConversation(id);

  /*
   * Not-found and not-yours are answered identically, and deliberately.
   *
   * A 403 on somebody else's conversation confirms that conversation exists,
   * which turns this endpoint into a way to enumerate them by trying ids.
   */
  if (!conversation || !ownsConversation(conversation, actor.userId)) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const { data: messages, error } = await routeServiceClient
    .from("support_messages")
    .select("id,author_type,author_label,body,created_at")
    .eq("conversation_id", id)
    .eq("visibility", "customer")
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(500);

  if (error) {
    logSupportFailure("customer.thread", error);
    return NextResponse.json({ error: "Could not load this conversation." }, { status: 500 });
  }

  let relatedOrder: { id: string; orderNumber: string | null } | null = null;
  if (conversation.related_order_id) {
    // Re-checked against this customer, not taken on trust from the link. A
    // staff member linking the wrong order must not put its number on somebody
    // else's screen.
    const { data: order } = await routeServiceClient
      .from("orders")
      .select("id,order_number")
      .eq("id", conversation.related_order_id)
      .eq("customer_id", actor.userId)
      .maybeSingle<{ id: string; order_number: string | null }>();
    if (order) relatedOrder = { id: order.id, orderNumber: order.order_number };
  }

  return NextResponse.json({
    conversation: {
      id: conversation.id,
      reference: conversation.reference,
      subject: conversation.subject,
      category: conversation.category,
      status: conversation.status,
      createdAt: conversation.created_at,
      lastMessageAt: conversation.last_message_at,
      relatedOrder,
      // True when the customer can still add to it. A closed conversation is
      // readable forever; it just does not take new messages.
      canReply: conversation.status !== "closed",
    },
    messages: (
      (messages ?? []) as { id: string; author_type: string; author_label: string; body: string; created_at: string }[]
    ).map((row) => ({
      id: row.id,
      authorType: row.author_type,
      // The shop speaks with one voice. `author_label` is the staff member's
      // real name and is not sent.
      authorLabel: row.author_type === "customer" ? row.author_label : "KeyMoura",
      body: row.body,
      createdAt: row.created_at,
    })),
  });
}
