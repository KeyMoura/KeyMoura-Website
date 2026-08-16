import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { notifyOrderStaff } from "@/lib/orderNotifications";
import { recordAuditEventStrict } from "@/lib/audit/events";
import {
  acceptanceProblem,
  acceptanceProblemMessage,
  TERMS_ACCEPTED_EVENT,
  TERMS_VERSION,
} from "@/lib/legal/terms";

/**
 * Approving a quote — the point where a customer commits to custom work.
 *
 * ## Why the agreement is enforced *here* and not only in the browser
 *
 * This route is the authoritative contract-formation point for made-to-order
 * work: after it, the order moves to `awaiting_payment` and the shop begins
 * treating the job as real. A checkbox in the page is how the customer
 * expresses agreement; it is not how it is checked. A stale tab, a direct
 * `fetch`, or a client with the state edited would all have approved a quote
 * without one, so the check lives on the server and the request is refused with
 * 422 when it is absent.
 *
 * The Terms *version* is required too, not just a boolean. A client holding
 * last month's page is refused rather than silently accepted, which is the only
 * thing that makes recording a version meaningful — otherwise the field is
 * decoration and the server is trusting a checkbox it never saw.
 *
 * ## Why the audit write is strict
 *
 * `recordAuditEventStrict` throws when the row cannot be written, and that
 * throw is deliberately allowed to fail the request *before* the order moves.
 * Everywhere else in this codebase an audit failure is swallowed, because
 * losing the record of a status change is worse than blocking the change. This
 * is the one place where the opposite holds: an approval whose acceptance was
 * not recorded is an approval nobody can later evidence, and the customer can
 * simply press the button again.
 *
 * The record carries the account, the order, the quote revision, the Terms
 * version and the timestamp. It does not carry a device fingerprint — see
 * `lib/legal/terms.ts` for why.
 */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const problem = acceptanceProblem({ agreed: body?.agreedToTerms, termsVersion: body?.termsVersion });
  if (problem) {
    return NextResponse.json({ error: acceptanceProblemMessage(problem), field: "agreedToTerms" }, { status: 422 });
  }

  const { id } = await context.params;
  const { data: order } = await routeServiceClient.from("orders").select("id,order_number,customer_id,status,quote_revision,quote_accepted_at,agreed_price_cents,quote_expires_at").eq("id", id).eq("customer_id", user.id).maybeSingle();
  if (!order || order.status !== "customer_review" || order.quote_accepted_at || !order.agreed_price_cents) return NextResponse.json({ error: "This quote is not ready for approval." }, { status: 409 });
  if (order.quote_expires_at && new Date(order.quote_expires_at).getTime() <= Date.now()) return NextResponse.json({ error: "This quote has expired. Message KeyMoura to request an updated quote." }, { status: 409 });

  const acceptedAt = new Date().toISOString();

  // Recorded before the order moves, and allowed to throw. See above.
  await recordAuditEventStrict({
    action: TERMS_ACCEPTED_EVENT,
    actor: { kind: "customer", userId: user.id },
    entity: { type: "order", id, label: order.order_number ?? null },
    related: { orderId: id },
    source: "api",
    occurredAt: acceptedAt,
    summary: `Customer accepted Terms ${TERMS_VERSION} approving quote revision ${order.quote_revision}`,
    metadata: {
      context: "quote_approval",
      termsVersion: TERMS_VERSION,
      quoteRevision: order.quote_revision,
      agreedPriceCents: order.agreed_price_cents,
    },
  });

  const { error } = await routeServiceClient.from("orders").update({ status:"awaiting_payment", quote_accepted_at:acceptedAt, payment_status:"unpaid" }).eq("id", id).eq("quote_revision", order.quote_revision);
  if (error) return NextResponse.json({ error: "Could not approve quote." }, { status: 500 });
  await routeServiceClient.from("order_quotes").update({ accepted_at:acceptedAt }).eq("order_id", id).eq("revision", order.quote_revision);
  await routeServiceClient.from("order_status_history").insert({ order_id:id, from_status:"customer_review", to_status:"awaiting_payment", changed_by:user.id, note:`Quote revision ${order.quote_revision} approved by customer under Terms ${TERMS_VERSION}` });
  await notifyOrderStaff({ orderId:id, actorUserId:user.id, title:"Quote approved", message:`The customer approved quote revision ${order.quote_revision} and can now pay.` });
  return NextResponse.json({ ok:true });
}
