import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { buildDiscountDraft, buildTargetDrafts } from "@/lib/commerce/discountAdmin";

/**
 * Editing, archiving, and inspecting one discount code.
 *
 * A code that has been redeemed is never deleted. Redemption rows reference it,
 * and an order's discount has to stay explainable years later — so the
 * destructive action is an archive, which `evaluateDiscount` already treats as
 * inactive.
 */

export const dynamic = "force-dynamic";

const DISCOUNT_COLUMNS =
  "id,code,description,discount_type,discount_value,max_discount_cents,minimum_subtotal_cents,starts_at,ends_at,is_active,max_total_uses,max_uses_per_customer,first_order_only,is_stackable,total_uses,archived_at,created_at,updated_at";

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

/** Redemption history for one code, for the staff usage report. */
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "catalog.discounts.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;

  const [{ data: code }, { data: targets }, { data: redemptions }] = await Promise.all([
    routeServiceClient.from("discount_codes").select(DISCOUNT_COLUMNS).eq("id", id).maybeSingle(),
    routeServiceClient
      .from("discount_code_targets")
      .select("target_type,target_id,is_exclusion")
      .eq("discount_code_id", id),
    routeServiceClient
      .from("discount_redemptions")
      .select("id,order_id,amount_cents,created_at")
      .eq("discount_code_id", id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  if (!code) return NextResponse.json({ error: "That code no longer exists." }, { status: 404 });

  // Order numbers, not customer identities: a usage report answers "where did
  // this discount go", and staff can open the order for anything more.
  const orderIds = Array.from(new Set((redemptions ?? []).map((row) => row.order_id as string))).filter(Boolean);
  const { data: orders } = orderIds.length
    ? await routeServiceClient.from("orders").select("id,order_number,status,payment_status").in("id", orderIds)
    : { data: [] as Record<string, unknown>[] };

  const orderById = new Map((orders ?? []).map((order) => [order.id as string, order]));

  return NextResponse.json({
    code,
    targets: targets ?? [],
    redemptions: (redemptions ?? []).map((row) => {
      const order = orderById.get(row.order_id as string);
      return {
        id: row.id as string,
        amountCents: Number(row.amount_cents ?? 0),
        createdAt: row.created_at as string,
        orderId: row.order_id as string,
        orderNumber: (order?.order_number as string | null) ?? null,
        orderStatus: (order?.status as string | null) ?? null,
        paymentStatus: (order?.payment_status as string | null) ?? null,
      };
    }),
  });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "catalog.discounts.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const { data: existing } = await routeServiceClient
    .from("discount_codes")
    .select("id,code,total_uses")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "That code no longer exists." }, { status: 404 });

  // A quick activate/deactivate toggle, without re-sending the whole form.
  if (Object.keys(body).length === 1 && typeof body.isActive === "boolean") {
    const { data, error } = await routeServiceClient
      .from("discount_codes")
      .update({ is_active: body.isActive, updated_at: new Date().toISOString() })
      .eq("id", id)
      .select(DISCOUNT_COLUMNS)
      .single();

    if (error) return NextResponse.json({ error: "Could not update the code." }, { status: 500 });

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: body.isActive ? "staff.catalog.discount.activate" : "staff.catalog.discount.deactivate",
      targetTable: "discount_codes",
      targetId: id,
      metadata: { code: existing.code },
    });

    return NextResponse.json({ code: data });
  }

  const result = buildDiscountDraft(body);
  if (!result.ok) return NextResponse.json({ error: result.problem }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("discount_codes")
    .update({ ...result.draft, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select(DISCOUNT_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "That code already exists." }, { status: 409 });
    return NextResponse.json({ error: error.message || "Could not update the code." }, { status: 400 });
  }

  // Targeting is replaced wholesale when the field is sent, and left alone when
  // it is not — so a partial edit cannot silently strip a code's restrictions.
  if (body.targets !== undefined) {
    const targets = buildTargetDrafts(body.targets);
    await routeServiceClient.from("discount_code_targets").delete().eq("discount_code_id", id);
    if (targets.length) {
      await routeServiceClient
        .from("discount_code_targets")
        .insert(targets.map((target) => ({ ...target, discount_code_id: id })));
    }
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.discount.update",
    targetTable: "discount_codes",
    targetId: id,
    metadata: {
      code: result.draft.code,
      discountType: result.draft.discount_type,
      discountValue: result.draft.discount_value,
      isActive: result.draft.is_active,
      retargeted: body.targets !== undefined,
    },
  });

  return NextResponse.json({ code: data });
}

/**
 * Archives a code.
 *
 * Never a delete: `discount_redemptions` references it, and an order's discount
 * has to stay explainable long after the code stops being offered.
 */
export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "catalog.discounts.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const { data: existing } = await routeServiceClient
    .from("discount_codes")
    .select("id,code")
    .eq("id", id)
    .maybeSingle();
  if (!existing) return NextResponse.json({ error: "That code no longer exists." }, { status: 404 });

  const { error } = await routeServiceClient
    .from("discount_codes")
    .update({ archived_at: new Date().toISOString(), is_active: false, updated_at: new Date().toISOString() })
    .eq("id", id);

  if (error) return NextResponse.json({ error: "Could not archive the code." }, { status: 500 });

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.discount.archive",
    targetTable: "discount_codes",
    targetId: id,
    metadata: { code: existing.code },
  });

  return NextResponse.json({ ok: true });
}
