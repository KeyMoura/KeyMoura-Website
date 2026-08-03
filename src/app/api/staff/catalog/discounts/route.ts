import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { buildDiscountDraft, buildTargetDrafts } from "@/lib/commerce/discountAdmin";

/**
 * Discount code listing and creation.
 *
 * Every handler requires `catalog.discounts.manage`. Reads carry redemption
 * counts so staff can see what a code has actually done before they change or
 * archive it.
 */

export const dynamic = "force-dynamic";

const DISCOUNT_COLUMNS =
  "id,code,description,discount_type,discount_value,max_discount_cents,minimum_subtotal_cents,starts_at,ends_at,is_active,max_total_uses,max_uses_per_customer,first_order_only,is_stackable,total_uses,archived_at,created_at,updated_at";

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "catalog.discounts.manage");
  if (!actor) return forbidden();

  const [{ data: codes, error }, { data: targets }, { data: redemptions }] = await Promise.all([
    routeServiceClient.from("discount_codes").select(DISCOUNT_COLUMNS).order("created_at", { ascending: false }),
    routeServiceClient.from("discount_code_targets").select("discount_code_id,target_type,target_id,is_exclusion"),
    routeServiceClient.from("discount_redemptions").select("discount_code_id,amount_cents"),
  ]);

  if (error) return NextResponse.json({ error: "Could not load discount codes." }, { status: 500 });

  // Redemption totals are aggregated here rather than trusting `total_uses`
  // alone: that counter is decremented when an unpaid order releases a code, so
  // it answers "how many are still held" and not "how much has this cost us".
  const usage: Record<string, { count: number; amountCents: number }> = {};
  for (const row of redemptions ?? []) {
    const id = row.discount_code_id as string;
    const entry = usage[id] ?? { count: 0, amountCents: 0 };
    entry.count += 1;
    entry.amountCents += Number(row.amount_cents ?? 0);
    usage[id] = entry;
  }

  const targetsByCode: Record<string, Array<{ target_type: string; target_id: string; is_exclusion: boolean }>> = {};
  for (const row of targets ?? []) {
    const id = row.discount_code_id as string;
    (targetsByCode[id] ??= []).push({
      target_type: row.target_type as string,
      target_id: row.target_id as string,
      is_exclusion: Boolean(row.is_exclusion),
    });
  }

  // Names for the targeting picker, so the UI never shows a bare uuid.
  const [{ data: products }, { data: categories }] = await Promise.all([
    routeServiceClient.from("products").select("id,name").is("archived_at", null).order("name"),
    routeServiceClient.from("product_categories").select("id,name").order("name"),
  ]);

  return NextResponse.json({
    codes: codes ?? [],
    targets: targetsByCode,
    usage,
    products: products ?? [],
    categories: categories ?? [],
  });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "catalog.discounts.manage");
  if (!actor) return forbidden();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to create." }, { status: 400 });

  const result = buildDiscountDraft(body);
  if (!result.ok) return NextResponse.json({ error: result.problem }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("discount_codes")
    .insert({ ...result.draft, created_by: actor.userId })
    .select(DISCOUNT_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "That code already exists." }, { status: 409 });
    return NextResponse.json({ error: error.message || "Could not create the code." }, { status: 400 });
  }

  const targets = buildTargetDrafts(body.targets);
  if (targets.length) {
    const { error: targetError } = await routeServiceClient
      .from("discount_code_targets")
      .insert(targets.map((target) => ({ ...target, discount_code_id: data.id })));

    // The code exists but its targeting did not save. Reporting that is far
    // better than leaving staff believing a restricted code is restricted.
    if (targetError) {
      return NextResponse.json(
        { code: data, error: "The code was created but its product and category targeting did not save." },
        { status: 207 }
      );
    }
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.discount.create",
    targetTable: "discount_codes",
    targetId: data.id,
    // The code string, its worth, and its limits — no customer data.
    metadata: {
      code: result.draft.code,
      discountType: result.draft.discount_type,
      discountValue: result.draft.discount_value,
      targetCount: targets.length,
    },
  });

  return NextResponse.json({ code: data }, { status: 201 });
}
