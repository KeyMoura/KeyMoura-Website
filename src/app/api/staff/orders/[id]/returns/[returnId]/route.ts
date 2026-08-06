import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { canTransitionReturn, returnRefundCents } from "@/lib/commerce/orderLifecycle";
import {
  issueOrderRefund,
  loadOrderLifecycleContext,
  logLifecycleAudit,
  logLifecycleFailure,
  moneyText,
  sendLifecycleNotification,
} from "@/lib/commerce/orderLifecycleServer";

/**
 * The staff side of a return: approve, deny, mark in transit, receive, inspect,
 * restock and refund.
 *
 * Each action is its own named verb rather than a status dropdown, and every
 * move is checked against `RETURN_TRANSITIONS` — the same graph the customer
 * page reads — so a return cannot jump from "requested" to "refunded" because
 * someone picked the wrong option.
 *
 * Approving a return does **not** refund it. Inventory comes back only at
 * inspection, and only when staff say the condition warrants it.
 */

export const runtime = "nodejs";

type ActionBody = {
  action?: unknown;
  expected_status?: unknown;
  decision_note?: unknown;
  internal_note?: unknown;
  instructions?: unknown;
  return_address?: unknown;
  items?: unknown;
  carrier?: unknown;
  tracking_number?: unknown;
  tracking_url?: unknown;
  inspection_outcome?: unknown;
  inspection_note?: unknown;
  restock?: unknown;
  refund_mode?: unknown;
  refund_amount_cents?: unknown;
};

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

const INSPECTION_OUTCOMES = new Set([
  "as_described",
  "minor_damage",
  "major_damage",
  "not_as_described",
  "missing_parts",
  "wrong_item_returned",
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string; returnId: string }> }
) {
  const actor = await requirePermission(req, "returns.review");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id, returnId } = await context.params;
  const body = (await req.json().catch(() => null)) as ActionBody | null;
  const action = typeof body?.action === "string" ? body.action : "";

  const lifecycle = await loadOrderLifecycleContext(id);
  if (!lifecycle) return NextResponse.json({ error: "Order not found" }, { status: 404 });

  const { data: record } = await routeServiceClient
    .from("order_returns")
    .select("id,status,reason_code,return_number,refund_decision,restock_decision")
    .eq("id", returnId)
    .eq("order_id", id)
    .maybeSingle();
  if (!record) return NextResponse.json({ error: "Return not found" }, { status: 404 });

  /*
   * The state the browser rendered the buttons from.
   *
   * The graph below already refuses an illegal move, but a *legal* move made
   * from a stale page is the case it cannot see. A return sitting at `approved`
   * that a colleague advances to `awaiting_shipment` still accepts "Mark
   * received" from a page showing `approved` — legal, and wrong, because it
   * skips the step that recorded the parcel was expected. Comparing what the
   * page believed closes that.
   */
  const expected = typeof body?.expected_status === "string" ? body.expected_status : "";
  if (expected && expected !== record.status) {
    return NextResponse.json(
      {
        error: `This return is now “${String(record.status).replaceAll("_", " ")}”, not “${expected.replaceAll("_", " ")}”. Reload the order before deciding.`,
        conflict: true,
        currentStatus: record.status,
      },
      { status: 409 }
    );
  }

  const { data: lines } = await routeServiceClient
    .from("order_return_items")
    .select("id,order_item_id,product_id,product_name,unit_price_cents,requested_quantity,approved_quantity,received_quantity")
    .eq("return_id", returnId);

  const now = new Date().toISOString();

  /** Applies a status move only if the graph allows it and nobody moved it first. */
  const advance = async (to: string, patch: Record<string, unknown>) => {
    if (!canTransitionReturn(record.status, to)) {
      return {
        ok: false as const,
        response: NextResponse.json(
          { error: `A return that is "${record.status}" cannot move to "${to}".` },
          { status: 409 }
        ),
      };
    }
    const { data: moved, error } = await routeServiceClient
      .from("order_returns")
      .update({ ...patch, status: to, updated_at: now })
      .eq("id", returnId)
      .eq("status", record.status)
      .select("id")
      .maybeSingle();
    if (error) {
      logLifecycleFailure("advance_return", error, { orderId: id, returnId });
      return { ok: false as const, response: NextResponse.json({ error: "Could not update the return." }, { status: 500 }) };
    }
    if (!moved) {
      return {
        ok: false as const,
        response: NextResponse.json(
          { error: "This return changed a moment ago. Reload the order." },
          { status: 409 }
        ),
      };
    }
    await routeServiceClient.from("orders").update({ return_status: to, updated_at: now }).eq("id", id);
    return { ok: true as const };
  };

  // ---- Approve -----------------------------------------------------------
  if (action === "approve") {
    const instructions = text(body?.instructions, 4000);
    const decisionNote = text(body?.decision_note, 2000);

    // Per-line approved quantities, clamped to what was actually requested.
    const requestedMap = new Map((lines || []).map((line) => [String(line.id), line]));
    const approvals = Array.isArray(body?.items) ? body.items : [];
    for (const entry of approvals) {
      const row = entry as { id?: unknown; approved_quantity?: unknown };
      const line = requestedMap.get(String(row.id));
      if (!line) continue;
      const quantity = Number.isInteger(row.approved_quantity)
        ? Math.max(0, Math.min(Number(row.approved_quantity), Number(line.requested_quantity)))
        : Number(line.requested_quantity);
      await routeServiceClient
        .from("order_return_items")
        .update({ approved_quantity: quantity })
        .eq("id", line.id);
    }
    // Anything staff did not touch is approved at the requested quantity.
    for (const line of lines || []) {
      if (line.approved_quantity == null && !approvals.some((entry) => String((entry as { id?: unknown }).id) === String(line.id))) {
        await routeServiceClient
          .from("order_return_items")
          .update({ approved_quantity: line.requested_quantity })
          .eq("id", line.id);
      }
    }

    const address =
      body?.return_address && typeof body.return_address === "object" && !Array.isArray(body.return_address)
        ? (body.return_address as Record<string, unknown>)
        : lifecycle.policy.returns.returnAddress;

    const moved = await advance("approved", {
      decided_by: actor.userId,
      decided_at: now,
      decision_note: decisionNote || null,
      internal_note: text(body?.internal_note, 2000) || null,
      return_instructions: instructions || lifecycle.policy.returns.instructions || null,
      // Snapshotted now. A later change to the shop's address must not redirect
      // a parcel that is already in the post.
      return_address: address ?? null,
    });
    if (!moved.ok) return moved.response;

    await Promise.all([
      sendLifecycleNotification({
        orderId: id,
        order: lifecycle.order,
        actorUserId: actor.userId,
        templateKey: "return_approved",
        eventKey: `return-approved-${returnId}`,
        title: "Return approved",
        message: `Your return ${record.return_number} is approved. Open the order for the return instructions.`,
        detail: [decisionNote, instructions || lifecycle.policy.returns.instructions].filter(Boolean).join(" "),
        href: `/orders/${id}`,
      }),
      logLifecycleAudit({
        eventType: "staff.order.return_approved",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        metadata: { return_id: returnId, return_number: record.return_number },
      }),
    ]);
    return NextResponse.json({ ok: true, status: "approved" });
  }

  // ---- Deny --------------------------------------------------------------
  if (action === "deny") {
    const decisionNote = text(body?.decision_note, 2000);
    if (decisionNote.length < 5) {
      return NextResponse.json(
        { error: "Give the customer a reason. They will see exactly what you write here." },
        { status: 400 }
      );
    }
    const moved = await advance("denied", {
      decided_by: actor.userId,
      decided_at: now,
      decision_note: decisionNote,
      internal_note: text(body?.internal_note, 2000) || null,
      refund_decision: "none",
      restock_decision: "do_not_restock",
      closed_at: now,
    });
    if (!moved.ok) return moved.response;

    // A denied return releases the quantities it was holding, so the customer
    // can ask again about a different item without being told the order is
    // already fully returned.
    await routeServiceClient.from("orders").update({ return_status: "denied", updated_at: now }).eq("id", id);

    await Promise.all([
      sendLifecycleNotification({
        orderId: id,
        order: lifecycle.order,
        actorUserId: actor.userId,
        templateKey: "return_denied",
        eventKey: `return-denied-${returnId}`,
        title: "Return request declined",
        message: decisionNote,
        detail: decisionNote,
      }),
      logLifecycleAudit({
        eventType: "staff.order.return_denied",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        metadata: { return_id: returnId },
      }),
    ]);
    return NextResponse.json({ ok: true, status: "denied" });
  }

  // ---- Awaiting shipment / in transit ------------------------------------
  if (action === "await_shipment" || action === "mark_in_transit") {
    const to = action === "await_shipment" ? "awaiting_shipment" : "in_transit";
    const trackingUrl = text(body?.tracking_url, 1000);
    if (trackingUrl && !/^https:\/\//i.test(trackingUrl)) {
      return NextResponse.json({ error: "A tracking link must use https://" }, { status: 400 });
    }
    const moved = await advance(to, {
      carrier: text(body?.carrier, 80) || null,
      tracking_number: text(body?.tracking_number, 160) || null,
      tracking_url: trackingUrl || null,
      shipped_at: to === "in_transit" ? now : null,
    });
    if (!moved.ok) return moved.response;
    await logLifecycleAudit({
      eventType: "staff.order.return_approved",
      actorUserId: actor.userId,
      actorRole: actor.role,
      orderId: id,
      metadata: { return_id: returnId, moved_to: to },
    });
    return NextResponse.json({ ok: true, status: to });
  }

  // ---- Receive -----------------------------------------------------------
  if (action === "receive") {
    const receipts = Array.isArray(body?.items) ? body.items : [];
    const lineMap = new Map((lines || []).map((line) => [String(line.id), line]));
    for (const entry of receipts) {
      const row = entry as { id?: unknown; received_quantity?: unknown; item_condition?: unknown };
      const line = lineMap.get(String(row.id));
      if (!line) continue;
      const cap = Number(line.approved_quantity ?? line.requested_quantity);
      const quantity = Number.isInteger(row.received_quantity)
        ? Math.max(0, Math.min(Number(row.received_quantity), cap))
        : cap;
      await routeServiceClient
        .from("order_return_items")
        .update({
          received_quantity: quantity,
          item_condition: typeof row.item_condition === "string" ? row.item_condition : null,
        })
        .eq("id", line.id);
    }

    const moved = await advance("received", { received_at: now, received_by: actor.userId });
    if (!moved.ok) return moved.response;

    await Promise.all([
      sendLifecycleNotification({
        orderId: id,
        order: lifecycle.order,
        actorUserId: actor.userId,
        templateKey: "return_received",
        eventKey: `return-received-${returnId}`,
        title: "Return received",
        message: `We received your return ${record.return_number} and will inspect it shortly.`,
      }),
      logLifecycleAudit({
        eventType: "staff.order.return_received",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        metadata: { return_id: returnId },
      }),
    ]);
    return NextResponse.json({ ok: true, status: "received" });
  }

  // ---- Inspect, restock and refund ---------------------------------------
  if (action === "inspect") {
    const outcome = typeof body?.inspection_outcome === "string" ? body.inspection_outcome : "";
    if (!INSPECTION_OUTCOMES.has(outcome)) {
      return NextResponse.json({ error: "Choose an inspection outcome." }, { status: 400 });
    }
    const inspectionNote = text(body?.inspection_note, 2000);
    const restock = body?.restock === true;

    const refundMode =
      body?.refund_mode === "full" ? "full" : body?.refund_mode === "partial" ? "partial" : "none";

    // The value of what actually came back, computed here rather than trusted
    // from the browser. A restocking fee, if the owner has set one, comes off
    // this number.
    const receivedLines = (lines || []).map((line) => ({
      unit_price_cents: Number(line.unit_price_cents || 0),
      quantity: Number(line.received_quantity ?? line.approved_quantity ?? 0),
    }));
    const lineValue = returnRefundCents(receivedLines, lifecycle.policy.returns.restockingFeePercent);

    let refundCents = 0;
    if (refundMode === "full") {
      refundCents = Math.min(lineValue, lifecycle.refundableCents);
    } else if (refundMode === "partial") {
      const requestedAmount = body?.refund_amount_cents;
      if (!Number.isInteger(requestedAmount) || Number(requestedAmount) < 1) {
        return NextResponse.json({ error: "Enter the partial refund amount." }, { status: 400 });
      }
      refundCents = Number(requestedAmount);
      if (refundCents > lifecycle.refundableCents) {
        return NextResponse.json(
          {
            error: `That is more than the ${moneyText(lifecycle.refundableCents)} left to refund on this order.`,
            refundableCents: lifecycle.refundableCents,
          },
          { status: 409 }
        );
      }
    }

    if (refundCents > 0 && !actor.permissions.has("refunds.issue")) {
      return NextResponse.json({ error: "Refunding a return needs the Issue refunds permission." }, { status: 403 });
    }

    const moved = await advance("inspected", {
      inspected_at: now,
      inspected_by: actor.userId,
      inspection_outcome: outcome,
      inspection_note: inspectionNote || null,
      restock_decision: restock ? "restock" : "do_not_restock",
      refund_decision: refundMode,
      refund_amount_cents: refundCents,
    });
    if (!moved.ok) return moved.response;

    // Stock comes back only here, and only on an explicit decision. Restocking
    // at approval would put a part back on the shelf that is still in the post,
    // and restocking damaged goods would oversell the next customer.
    if (restock && lifecycle.policy.inventory.restoreOnReturn) {
      const { error: restockError } = await routeServiceClient.rpc("restock_return_items", {
        p_return_id: returnId,
        p_created_by: actor.userId,
      });
      if (restockError) logLifecycleFailure("restock_return_items", restockError, { orderId: id, returnId });
      else
        await logLifecycleAudit({
          eventType: "staff.inventory.restored",
          actorUserId: actor.userId,
          actorRole: actor.role,
          orderId: id,
          metadata: { return_id: returnId, source: "return_inspection" },
        });
    }

    let refundResult: { settledCents: number; pendingCents: number; failedCents: number } | null = null;
    if (refundCents > 0) {
      const result = await issueOrderRefund({
        orderId: id,
        amountCents: refundCents,
        kind: "return",
        reason: `Return ${record.return_number} (${record.reason_code})`,
        idempotencyKey: `return-${returnId}-${refundCents}`,
        actorUserId: actor.userId,
        customerNote: inspectionNote || null,
        returnId,
      });
      if (!result.ok) {
        await routeServiceClient
          .from("order_returns")
          .update({ status: "refund_pending", updated_at: new Date().toISOString() })
          .eq("id", returnId);
        await logLifecycleAudit({
          eventType: "staff.order.refund_failed",
          actorUserId: actor.userId,
          actorRole: actor.role,
          orderId: id,
          metadata: { return_id: returnId, amount_cents: refundCents },
        });
        return NextResponse.json({ error: result.error, inspected: true, refundFailed: true }, { status: 409 });
      }
      refundResult = result;
      await logLifecycleAudit({
        eventType: result.failedCents > 0 ? "staff.order.refund_failed" : "staff.order.refund_sent",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        metadata: {
          return_id: returnId,
          settled_cents: result.settledCents,
          pending_cents: result.pendingCents,
          failed_cents: result.failedCents,
        },
      });
    }

    const finalStatus =
      refundResult && refundResult.pendingCents > 0 ? "refund_pending" : refundCents > 0 ? "completed" : "completed";

    await routeServiceClient
      .from("order_returns")
      .update({
        status: finalStatus,
        closed_at: finalStatus === "completed" ? now : null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", returnId)
      .eq("status", "inspected");

    // Fulfillment reflects what came back: everything, or only part of it.
    const fullyReturned = (lines || []).every(
      (line) => Number(line.received_quantity ?? 0) >= Number(line.requested_quantity)
    );
    const orderReturned = lifecycle.lines.every((line) => line.returned_quantity >= line.quantity);

    await routeServiceClient
      .from("orders")
      .update({
        return_status: finalStatus,
        fulfillment_status: fullyReturned && orderReturned ? "returned" : "partially_returned",
        updated_at: new Date().toISOString(),
      })
      .eq("id", id);

    await Promise.all([
      sendLifecycleNotification({
        orderId: id,
        order: lifecycle.order,
        actorUserId: actor.userId,
        templateKey: "return_inspected",
        eventKey: `return-inspected-${returnId}`,
        title: "Return inspected",
        message:
          refundCents > 0
            ? `Your return ${record.return_number} was inspected and a ${moneyText(refundCents)} refund is on its way.`
            : `Your return ${record.return_number} was inspected. No refund was issued.`,
        detail: inspectionNote,
        price: refundCents > 0 ? moneyText(refundCents) : "",
      }),
      logLifecycleAudit({
        eventType: "staff.order.return_inspected",
        actorUserId: actor.userId,
        actorRole: actor.role,
        orderId: id,
        metadata: {
          return_id: returnId,
          outcome,
          restocked: restock,
          refund_cents: refundCents,
        },
      }),
    ]);

    return NextResponse.json({ ok: true, status: finalStatus, refund: refundResult });
  }

  // ---- Close -------------------------------------------------------------
  if (action === "close") {
    const moved = await advance("closed", {
      closed_at: now,
      internal_note: text(body?.internal_note, 2000) || null,
    });
    if (!moved.ok) return moved.response;
    await logLifecycleAudit({
      eventType: "staff.order.return_closed",
      actorUserId: actor.userId,
      actorRole: actor.role,
      orderId: id,
      metadata: { return_id: returnId },
    });
    return NextResponse.json({ ok: true, status: "closed" });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
