import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { findPaymentDiscrepancies } from "@/lib/ops/evidence";

/**
 * Historical payment discrepancy review.
 *
 * Two orders in this production database record money collected with no
 * payment row behind them: KM-0001 at $25.00 and KM-0002 at $1.00. Both predate
 * the atomic payment accounting added in pass 7, which is what made the order
 * field and the payment rows move together.
 *
 * ## What this route deliberately does not do
 *
 * It does not create a payment row. It does not change `amount_paid_cents`,
 * `amount_refunded_cents`, `agreed_price_cents`, or any status on the order. It
 * does not call Stripe, and it never invents a Stripe identifier to make the
 * numbers agree.
 *
 * The reason is not caution for its own sake. **A missing payment row does not
 * prove no payment was taken.** It is at least as likely that money genuinely
 * changed hands and the record of it was never written — which is exactly the
 * class of bug pass 7 fixed. Writing a synthetic payment row to make a report
 * go green would put a fabricated financial record in the ledger, and it would
 * be indistinguishable from a real one forever after.
 *
 * So the only thing recorded here is a **conclusion**: a person looked, decided
 * what this row is, and wrote down why. The evidence is presented read-only
 * beside it. If a repair is ever wanted it must be a separate, explicit action
 * with its own permission, its own confirmation and its own audit event — not
 * a side effect of reviewing.
 */

const CLASSIFICATIONS = ["test", "manual", "legacy", "unknown"] as const;
type Classification = (typeof CLASSIFICATIONS)[number];

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["payments.discrepancy.review", "launch.readiness.view"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const findings = await findPaymentDiscrepancies();
    if (!findings.length) {
      return NextResponse.json({ discrepancies: [], canReview: actor.permissions.has("payments.discrepancy.review") });
    }

    const orderIds = findings.map((finding) => finding.orderId);
    const [orders, payments, history, reviews, refunds] = await Promise.all([
      routeServiceClient
        .from("orders")
        .select("id,order_number,status,payment_status,order_kind,product_name,agreed_price_cents,amount_paid_cents,amount_refunded_cents,created_at,stripe_checkout_session_id")
        .in("id", orderIds),
      routeServiceClient.from("order_payments").select("order_id,amount_cents,status,created_at").in("order_id", orderIds),
      routeServiceClient
        .from("order_status_history")
        .select("order_id,from_status,to_status,created_at")
        .in("order_id", orderIds)
        .order("created_at", { ascending: true }),
      routeServiceClient
        .from("payment_discrepancy_reviews")
        .select("id,order_id,discrepancy_kind,classification,status,explanation,reviewed_at,reviewed_by,observed_recorded_cents,observed_evidence_cents")
        .in("order_id", orderIds)
        .is("superseded_at", null),
      routeServiceClient.from("order_refunds").select("order_id,amount_cents,status").in("order_id", orderIds),
    ]);

    const byOrder = <T extends { order_id: string }>(rows: T[] | null) => {
      const map = new Map<string, T[]>();
      for (const row of rows ?? []) map.set(row.order_id, [...(map.get(row.order_id) ?? []), row]);
      return map;
    };
    const paymentsBy = byOrder(payments.data as { order_id: string }[] | null);
    const historyBy = byOrder(history.data as { order_id: string }[] | null);
    const refundsBy = byOrder(refunds.data as { order_id: string }[] | null);
    const reviewBy = new Map(
      ((reviews.data ?? []) as { order_id: string; discrepancy_kind: string }[]).map((row) => [
        `${row.order_id}:${row.discrepancy_kind}`,
        row,
      ])
    );

    const orderById = new Map(((orders.data ?? []) as Record<string, unknown>[]).map((row) => [String(row.id), row]));

    return NextResponse.json({
      canReview: actor.permissions.has("payments.discrepancy.review"),
      // Restated in the payload so no consumer can present this as repairable.
      readOnly: true,
      note:
        "This surface records a conclusion about a historical row. It never creates a payment record, changes a total, or contacts Stripe. A missing payment row is not proof that no payment was taken.",
      discrepancies: findings.map((finding) => {
        const order = orderById.get(finding.orderId) ?? {};
        const review = reviewBy.get(`${finding.orderId}:${finding.kind}`) as
          | Record<string, unknown>
          | undefined;
        return {
          ...finding,
          order: {
            id: finding.orderId,
            orderNumber: order.order_number ?? null,
            productName: order.product_name ?? null,
            status: order.status ?? null,
            paymentStatus: order.payment_status ?? null,
            orderKind: order.order_kind ?? null,
            agreedPriceCents: order.agreed_price_cents ?? null,
            amountPaidCents: order.amount_paid_cents ?? null,
            amountRefundedCents: order.amount_refunded_cents ?? null,
            createdAt: order.created_at ?? null,
            // Presence, not the identifier. Whether a Stripe session was ever
            // created is the useful signal; the id itself is an internal handle.
            hadStripeSession: Boolean(order.stripe_checkout_session_id),
          },
          evidence: {
            paymentRows: (paymentsBy.get(finding.orderId) ?? []).length,
            paymentRowTotalCents: finding.evidenceCents,
            refundRows: (refundsBy.get(finding.orderId) ?? []).length,
            statusHistory: (historyBy.get(finding.orderId) ?? []).map((row) => {
              const entry = row as unknown as { from_status: string | null; to_status: string; created_at: string };
              return { from: entry.from_status, to: entry.to_status, at: entry.created_at };
            }),
          },
          review: review
            ? {
                classification: review.classification,
                status: review.status,
                explanation: review.explanation,
                reviewedAt: review.reviewed_at,
                // Stale when the numbers have moved since somebody concluded.
                stale:
                  Number(review.observed_recorded_cents) !== finding.recordedCents ||
                  Number(review.observed_evidence_cents) !== finding.evidenceCents,
              }
            : null,
        };
      }),
    });
  } catch (error) {
    console.error("discrepancy review load failed", { message: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Discrepancies could not be read." }, { status: 502 });
  }
}

type ReviewBody = {
  orderId?: unknown;
  kind?: unknown;
  classification?: unknown;
  explanation?: unknown;
  unresolved?: unknown;
  expectedRecordedCents?: unknown;
  expectedEvidenceCents?: unknown;
};

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "payments.discrepancy.review");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = ((await req.json().catch(() => null)) ?? {}) as ReviewBody;
  const orderId = typeof body.orderId === "string" ? body.orderId : "";
  const kind = body.kind === "refund_total_mismatch" ? "refund_total_mismatch" : "payment_total_mismatch";
  const classification = CLASSIFICATIONS.includes(body.classification as Classification)
    ? (body.classification as Classification)
    : null;
  const explanation = typeof body.explanation === "string" ? body.explanation.trim().slice(0, 4000) : "";

  if (!orderId) return NextResponse.json({ error: "Which order?" }, { status: 400 });
  if (!classification) return NextResponse.json({ error: "Choose how this row is classified." }, { status: 400 });
  // A review with no explanation is a tick, and a tick tells the next reader
  // nothing about why this row is acceptable.
  if (explanation.length < 10) {
    return NextResponse.json({ error: "Write down what you concluded and why. A classification on its own tells the next reader nothing." }, { status: 400 });
  }

  // Recompute from live rows. The amounts recorded on the review are what the
  // reviewer actually saw, so a later reader can tell a current conclusion from
  // one that describes a different set of numbers.
  const findings = await findPaymentDiscrepancies();
  const finding = findings.find((candidate) => candidate.orderId === orderId && candidate.kind === kind);
  if (!finding) {
    return NextResponse.json(
      { error: "That order no longer shows this discrepancy. Reload before recording a conclusion about it.", conflict: true },
      { status: 409 }
    );
  }
  if (
    (typeof body.expectedRecordedCents === "number" && body.expectedRecordedCents !== finding.recordedCents) ||
    (typeof body.expectedEvidenceCents === "number" && body.expectedEvidenceCents !== finding.evidenceCents)
  ) {
    return NextResponse.json(
      { error: "The numbers changed since the page loaded. Reload and read them again.", conflict: true },
      { status: 409 }
    );
  }

  // Supersede rather than overwrite: a review is a dated statement by a person,
  // and the previous one stays readable.
  await routeServiceClient
    .from("payment_discrepancy_reviews")
    .update({ superseded_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .eq("discrepancy_kind", kind)
    .is("superseded_at", null);

  const { error } = await routeServiceClient.from("payment_discrepancy_reviews").insert({
    order_id: orderId,
    discrepancy_kind: kind,
    observed_recorded_cents: finding.recordedCents,
    observed_evidence_cents: finding.evidenceCents,
    classification,
    status: body.unresolved === true ? "unresolved" : "reviewed",
    explanation,
    reviewed_by: actor.userId,
  });

  if (error) {
    console.error("discrepancy review failed", { code: error.code, hint: error.hint });
    return NextResponse.json({ error: "That review could not be recorded." }, { status: 502 });
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.payments.discrepancy_reviewed",
    targetTable: "orders",
    targetId: orderId,
    // The classification and the amounts, never the explanation: that is an
    // internal note and the audit log is read more widely.
    metadata: {
      discrepancy_kind: kind,
      classification,
      recorded_cents: finding.recordedCents,
      evidence_cents: finding.evidenceCents,
      // Stated in the record itself so an auditor reading only the log can see
      // that reviewing moved no money.
      changed_financial_data: false,
    },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
