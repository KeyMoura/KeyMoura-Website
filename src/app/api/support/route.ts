import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { consumeRateLimit, RATE_LIMITS, rateLimitMessage } from "@/lib/commerce/rateLimit";
import { authorizeGuestOrderWrite, guestOrderTokenFromRequest } from "@/lib/commerce/guestOrderAccess";
import {
  checkEmail,
  checkMessage,
  checkSubject,
  isSupportCategory,
  MAX_SUPPORT_NAME_LENGTH,
  normalizeSingleLine,
  type SupportCategory,
} from "@/lib/support/domain";
import {
  alertStaffOfNewConversation,
  appendSupportMessage,
  CONVERSATION_COLUMNS,
  logSupportFailure,
  notifyNewConversation,
  type ConversationRow,
} from "@/lib/support/server";
import { recordAuditEvent } from "@/lib/audit/events";

/**
 * Opening a support conversation. The public front door.
 *
 * This route **replaces** `/api/contact`, which built its own `new Resend(...)`,
 * sent one email and stored nothing — so every question a customer had ever
 * asked existed only in a mailbox, with no status, no owner and no history.
 *
 * ## The two things that are genuinely load-bearing here
 *
 * **1. Ownership of an attached order is proved, never claimed.** An account
 * holder may attach an order only when `orders.customer_id` equals their own id.
 * A guest may attach one only when their httpOnly guest-order cookie opens that
 * order — the same `authorizeGuestOrderWrite` the guest message route uses, so a
 * guest who may reply to an order and a guest who may attach it are the same
 * guest by construction. Email equality is never accepted: it is a claim anybody
 * who can type can make, and honouring it would turn this form into a way to
 * bind yourself to a stranger's order.
 *
 * **2. The request body cannot set anything a customer should not.** Priority,
 * status, assignment and the reference are not read from the body at all. They
 * are not validated-and-rejected; they are simply never looked at, which is the
 * version that stays true when somebody adds a field later.
 */

export const runtime = "nodejs";

const bad = (error: string, status = 400) => NextResponse.json({ error }, { status });

function requestIdentity(req: NextRequest, userId: string | null): string {
  if (userId) return `user:${userId}`;
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${forwarded || req.headers.get("x-real-ip") || "unknown"}`;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return bad("Invalid request.");

  /*
   * The honeypot, kept from the form this route replaces.
   *
   * Answering `ok` rather than refusing is the point: a bot that is told it
   * failed learns to try again without the field. Nothing is written.
   */
  if (normalizeSingleLine(body.website, 200)) {
    return NextResponse.json({ ok: true, reference: null, id: null });
  }

  const actor = await getActorAccessFromRequest(req);

  const limit = await consumeRateLimit(RATE_LIMITS.supportRequest, requestIdentity(req, actor?.userId ?? null));
  if (!limit.allowed) {
    return NextResponse.json({ error: rateLimitMessage(limit) }, { status: 429 });
  }

  const subject = checkSubject(body.subject);
  if (!subject.ok) return bad(subject.error);

  const message = checkMessage(body.message);
  if (!message.ok) return bad(message.error);

  const category: SupportCategory = isSupportCategory(body.category) ? body.category : "general";

  // --- who is asking ---------------------------------------------------------
  //
  // An account holder's identity comes from their session and nothing else. A
  // `customerId` in the body is not validated — it is never read.
  let customerId: string | null = null;
  let guestEmail: string | null = null;
  let guestName: string | null = null;
  let requesterLabel = "";
  let requesterEmail: string | null = null;

  if (actor) {
    customerId = actor.userId;
    const { data: account } = await routeServiceClient.auth.admin.getUserById(actor.userId);
    requesterEmail = account.user?.email ?? null;
    requesterLabel =
      normalizeSingleLine(account.user?.user_metadata?.display_name, MAX_SUPPORT_NAME_LENGTH) ||
      requesterEmail?.split("@")[0] ||
      "Customer";
  } else {
    const email = checkEmail(body.email);
    if (!email.ok) return bad(email.error);
    const name = normalizeSingleLine(body.name, MAX_SUPPORT_NAME_LENGTH);
    if (!name) return bad("Tell us your name so we know who we are replying to.");
    guestEmail = email.value;
    guestName = name;
    requesterLabel = name;
    requesterEmail = email.value;
  }

  // --- the optional order ----------------------------------------------------
  let relatedOrderId: string | null = null;
  const requestedOrderId = typeof body.orderId === "string" ? body.orderId.trim() : "";

  if (requestedOrderId) {
    if (actor) {
      const { data: order } = await routeServiceClient
        .from("orders")
        .select("id,customer_id")
        .eq("id", requestedOrderId)
        .maybeSingle<{ id: string; customer_id: string | null }>();
      // Not found and not-yours are answered identically. Distinguishing them
      // turns this field into an oracle for whether an order id exists.
      if (!order || order.customer_id !== actor.userId) {
        return bad("That order is not on your account.", 403);
      }
      relatedOrderId = order.id;
    } else {
      const guestToken = guestOrderTokenFromRequest(req);
      const authorized = await authorizeGuestOrderWrite(guestToken, requestedOrderId);
      if (!authorized.ok) {
        return bad("We could not confirm that order is yours. Open it from your order link first.", 403);
      }
      relatedOrderId = requestedOrderId;
    }
  }

  // --- write it --------------------------------------------------------------
  //
  // `reference` is absent from the insert: a `BEFORE INSERT` trigger takes a
  // `nextval` and fills it in. Two simultaneous submissions take two values, and
  // nothing anywhere reads a maximum and adds one.
  const clientToken =
    typeof body.clientToken === "string" ? body.clientToken.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) : "";

  const { data, error } = await routeServiceClient
    .from("support_conversations")
    .insert({
      subject: subject.value,
      category,
      customer_id: customerId,
      guest_email: guestEmail,
      guest_name: guestName,
      requester_label: requesterLabel,
      requester_email: requesterEmail,
      related_order_id: relatedOrderId,
      source: "web",
      client_token: clientToken || null,
    })
    .select(CONVERSATION_COLUMNS)
    .single();

  if (error) {
    // A repeated submission of the same composed form is answered with the
    // conversation it already created, not with a second one.
    if (clientToken && (error as { code?: string }).code === "23505") {
      const { data: original } = await routeServiceClient
        .from("support_conversations")
        .select("id,reference")
        .eq("client_token", clientToken)
        .maybeSingle<{ id: string; reference: string }>();
      if (original) {
        return NextResponse.json({ ok: true, id: original.id, reference: original.reference, duplicate: true });
      }
    }
    logSupportFailure("conversation.create", error);
    return bad("Could not send your message. Please try again.", 500);
  }

  const conversation = data as unknown as ConversationRow;

  // The opening message is a message, not a column on the conversation. Storing
  // it separately would mean the first thing the customer said lived somewhere
  // different from everything they said afterwards, and every reader would have
  // to know that.
  const first = await appendSupportMessage({
    conversationId: conversation.id,
    authorType: "customer",
    authorUserId: customerId,
    authorLabel: requesterLabel,
    visibility: "customer",
    body: message.value,
  });

  if (!first.ok) {
    // The conversation exists and is reachable by staff; the customer is told
    // plainly rather than shown a success for a thread with nothing in it.
    return bad("We saved your request but could not attach your message. Please reply to it.", 500);
  }

  /*
   * The audit actor is the **customer**, not staff.
   *
   * `recordAuditEvent` has a `customer` actor kind for exactly this: attributing
   * a customer's own action to "System" would make the log say nobody opened it.
   * A guest has no user id and gets `null` with a label, which is the same shape
   * the provider actor uses.
   */
  await recordAuditEvent({
    action: "support.created",
    actor: { kind: "customer", userId: customerId, label: requesterLabel },
    entity: { type: "support_conversation", id: conversation.id, label: conversation.reference },
    related: { orderId: relatedOrderId },
    summary: `Opened ${conversation.reference}`,
    // Facts about the request, never its words. The message is the record.
    metadata: {
      category,
      guest: customerId === null,
      order_linked: relatedOrderId !== null,
      message_length: message.value.length,
    },
    source: "api",
  });

  // Neither of these may take the submission down with it: the customer's
  // request is saved, and a bell that did not ring is not a reason to tell them
  // it failed.
  await Promise.all([
    notifyNewConversation(conversation).catch((error: unknown) => logSupportFailure("conversation.email", error)),
    alertStaffOfNewConversation(conversation).catch((error: unknown) =>
      logSupportFailure("conversation.alert", error)
    ),
  ]);

  return NextResponse.json({
    ok: true,
    id: conversation.id,
    reference: conversation.reference,
    // Only an account holder has somewhere to be sent. A guest is given the
    // reference and told to expect an email, which is the truth.
    href: customerId ? `/account/support/${conversation.id}` : null,
  });
}
