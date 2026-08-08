import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { JOB_COLUMNS, logProductionFailure, recordJobAction, type JobRow } from "@/lib/production/server";

/**
 * Attach a production job to an order, move it to a different one, or detach it.
 *
 * This exists as its own endpoint for the reason `./status` does: changing what
 * a job *is attached to* is a different kind of act from editing its fields, and
 * giving it its own route is what lets it carry its own rules. Before this, the
 * link was a side effect of the details form — and a destructive one, because
 * the form never sent the link fields and `parseJobDraft` reads a missing key as
 * `null`. Every save detached the job.
 *
 * The rules, and why each is here:
 *
 * 1. **The order must exist.** An id is accepted only after it resolves to a
 *    real row. A job pointing at a deleted or mistyped order looks linked, opens
 *    nothing, and cannot be found from the order side.
 * 2. **A relink must say what it is replacing.** `expectedOrderId` is compared
 *    to the stored value, so a second tab — or a colleague — cannot have moved
 *    the job since the page was drawn. The answer is a 409 naming where the job
 *    actually is, never a silent overwrite.
 * 3. **Detaching is explicit.** `orderId: null` is a decision the caller states,
 *    not something inferred from an absent field. That distinction is precisely
 *    what was missing.
 * 4. **Product and customer follow the order, and only the order.** They are
 *    derived from the row that was just verified rather than accepted from the
 *    request, so the three columns cannot disagree about whose work this is.
 * 5. **Both records are written to.** The job timeline gets the operational
 *    entry staff read; `audit_logs` gets the security entry. Consequential
 *    actions in this system write both.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderRow = {
  id: string;
  order_number: string | null;
  product_id: string | null;
  customer_id: string | null;
};

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send an order to link." }, { status: 400 });

  // `null` means detach and must be written explicitly; `undefined` is a
  // malformed request rather than an instruction.
  const raw = body.orderId;
  if (raw !== null && typeof raw !== "string") {
    return NextResponse.json({ error: "Send an order id, or null to unlink." }, { status: 400 });
  }
  const nextOrderId = raw === null || raw.trim() === "" ? null : raw.trim();
  if (nextOrderId && !UUID.test(nextOrderId)) {
    return NextResponse.json({ error: "That is not a valid order reference." }, { status: 400 });
  }

  const { data: job, error: jobError } = await routeServiceClient
    .from("production_jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle<JobRow>();

  if (jobError) {
    logProductionFailure("job.link.read", jobError);
    return NextResponse.json({ error: "Could not load the job." }, { status: 500 });
  }
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  // Stale-state guard. The browser sends what it was showing; if the job has
  // been linked elsewhere since, the request is refused rather than applied on
  // top of somebody else's decision.
  if (Object.prototype.hasOwnProperty.call(body, "expectedOrderId")) {
    const expected = body.expectedOrderId === null ? null : String(body.expectedOrderId);
    if (expected !== job.order_id) {
      return NextResponse.json(
        {
          error: job.order_id
            ? "This job was linked to a different order while you were looking at it. Reload before changing it."
            : "This job was unlinked while you were looking at it. Reload before changing it.",
          conflict: true,
        },
        { status: 409 }
      );
    }
  }

  if (nextOrderId === job.order_id) {
    // Not an error, and deliberately not a write: re-confirming the current
    // link should not produce an audit entry saying something changed.
    return NextResponse.json({ job, changed: false });
  }

  let order: OrderRow | null = null;
  if (nextOrderId) {
    const { data, error } = await routeServiceClient
      .from("orders")
      .select("id,order_number,product_id,customer_id")
      .eq("id", nextOrderId)
      .maybeSingle<OrderRow>();

    if (error) {
      logProductionFailure("job.link.order", error);
      return NextResponse.json({ error: "Could not check that order." }, { status: 500 });
    }
    // The guard against linking to the wrong order: an id that resolves to
    // nothing is refused here rather than stored and discovered later.
    if (!data) return NextResponse.json({ error: "No order with that reference exists." }, { status: 404 });
    order = data;
  }

  const update = {
    order_id: nextOrderId,
    // A job carried to a different order keeps nothing from the previous one.
    // `order_item_id` is cleared because an item id belongs to exactly one
    // order and would otherwise point across the new link at a stranger's line.
    order_item_id: null,
    product_id: order?.product_id ?? null,
    customer_id: order?.customer_id ?? null,
  };

  // Re-asserting the previous link makes the write itself the race check: if
  // the job was relinked between the read above and here, this matches no rows
  // instead of overwriting the decision that landed first. `null` needs `.is`
  // rather than `.eq`, because SQL equality against NULL is never true.
  const guarded = routeServiceClient.from("production_jobs").update(update).eq("id", id);
  const scoped = job.order_id === null ? guarded.is("order_id", null) : guarded.eq("order_id", job.order_id);

  const { data: updated, error } = await scoped.select(JOB_COLUMNS).maybeSingle<JobRow>();

  if (error) {
    logProductionFailure("job.link.write", error);
    return NextResponse.json({ error: "Could not change the link." }, { status: 400 });
  }
  if (!updated) {
    return NextResponse.json(
      { error: "This job changed while you were looking at it. Reload before changing it.", conflict: true },
      { status: 409 }
    );
  }

  await recordJobAction({
    actor,
    jobId: updated.id,
    jobNumber: updated.job_number,
    eventType: nextOrderId ? "job.linked" : "job.unlinked",
    auditType: "staff.production.job.link",
    // Order numbers, never customer details: the audit log is read more widely
    // than the job page.
    metadata: {
      from: job.order_id,
      to: nextOrderId,
      orderNumber: order?.order_number ?? null,
    },
    note: nextOrderId
      ? `Linked to order ${order?.order_number ?? nextOrderId}`
      : "Unlinked from its order",
  });

  return NextResponse.json({ job: updated, changed: true, orderNumber: order?.order_number ?? null });
}

export const dynamic = "force-dynamic";
