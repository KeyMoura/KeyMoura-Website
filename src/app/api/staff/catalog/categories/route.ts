import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import {
  categoryNameProblem,
  normalizeCategoryName,
  uniqueCategorySlug,
  type CategoryRow,
} from "@/lib/commerce/categories";

/**
 * Category listing and creation.
 *
 * Every handler requires `catalog.categories.manage`. Reads come back with
 * product counts so staff can see what a category is actually holding before
 * they reorder, archive, or try to delete it.
 */

const CATEGORY_COLUMNS = "id,name,slug,description,parent_id,image_url,display_order,is_active,archived_at";

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

const cleanText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text || null;
};

/** Asset paths must be site-relative or https, matching the Appearance rules. */
const cleanAsset = (value: unknown): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, 1000);
  if (!text) return null;
  return text.startsWith("/") || /^https:\/\//i.test(text) ? text : undefined;
};

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "catalog.categories.manage");
  if (!actor) return forbidden();

  const [{ data: categories, error }, { data: products }] = await Promise.all([
    routeServiceClient.from("product_categories").select(CATEGORY_COLUMNS).order("display_order").order("name"),
    routeServiceClient.from("products").select("id,category_id").is("archived_at", null),
  ]);

  if (error) return NextResponse.json({ error: "Could not load categories." }, { status: 500 });

  const counts: Record<string, number> = {};
  let uncategorized = 0;
  for (const product of products ?? []) {
    const id = product.category_id as string | null;
    if (!id) uncategorized += 1;
    else counts[id] = (counts[id] ?? 0) + 1;
  }

  return NextResponse.json({ categories: categories ?? [], productCounts: counts, uncategorized });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "catalog.categories.manage");
  if (!actor) return forbidden();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = normalizeCategoryName(body?.name);
  const parentId = typeof body?.parentId === "string" && body.parentId ? body.parentId : null;

  const { data: existing } = await routeServiceClient.from("product_categories").select(CATEGORY_COLUMNS);
  const rows = (existing ?? []) as CategoryRow[];

  const nameProblem = categoryNameProblem(name, rows, parentId);
  if (nameProblem === "blank") return NextResponse.json({ error: "Give the category a name." }, { status: 400 });
  if (nameProblem === "duplicate") {
    return NextResponse.json({ error: `A category named “${name}” already exists here.` }, { status: 409 });
  }

  // The database trigger is the real guard; checking here turns a raw
  // exception into a message staff can act on.
  if (parentId) {
    const parent = rows.find((row) => row.id === parentId);
    if (!parent) return NextResponse.json({ error: "That parent category no longer exists." }, { status: 400 });
    if (parent.parent_id) {
      return NextResponse.json({ error: "Categories support one level of subcategory only." }, { status: 400 });
    }
  }

  const imageUrl = cleanAsset(body?.imageUrl);
  if (imageUrl === undefined) {
    return NextResponse.json({ error: "Image paths must start with / or https://." }, { status: 400 });
  }

  const siblings = rows.filter((row) => row.parent_id === parentId);
  const displayOrder = siblings.reduce((highest, row) => Math.max(highest, row.display_order), -1) + 1;

  const { data, error } = await routeServiceClient
    .from("product_categories")
    .insert({
      name,
      slug: uniqueCategorySlug(name, rows.map((row) => row.slug)),
      description: cleanText(body?.description, 500),
      parent_id: parentId,
      image_url: imageUrl,
      display_order: displayOrder,
    })
    .select(CATEGORY_COLUMNS)
    .single();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "That slug is already in use." }, { status: 409 });
    return NextResponse.json({ error: error.message || "Could not create the category." }, { status: 400 });
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.category.create",
    targetTable: "product_categories",
    targetId: data.id,
    metadata: { name, parentId },
  });

  return NextResponse.json({ category: data }, { status: 201 });
}

/** Bulk reorder. Sent as an ordered list of ids per parent. */
export async function PUT(req: NextRequest) {
  const actor = await requirePermission(req, "catalog.categories.manage");
  if (!actor) return forbidden();

  const body = (await req.json().catch(() => null)) as { order?: unknown } | null;
  if (!Array.isArray(body?.order)) return NextResponse.json({ error: "Nothing to reorder." }, { status: 400 });

  const updates = body.order
    .filter((entry): entry is { id: string; displayOrder: number } =>
      Boolean(entry) && typeof entry === "object" && typeof (entry as { id?: unknown }).id === "string"
    )
    .slice(0, 500)
    .map((entry) => ({ id: entry.id, display_order: Math.max(0, Math.trunc(Number(entry.displayOrder) || 0)) }));

  if (!updates.length) return NextResponse.json({ error: "Nothing to reorder." }, { status: 400 });

  for (const update of updates) {
    const { error } = await routeServiceClient
      .from("product_categories")
      .update({ display_order: update.display_order, updated_at: new Date().toISOString() })
      .eq("id", update.id);
    if (error) return NextResponse.json({ error: "Could not save the new order." }, { status: 500 });
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.category.reorder",
    targetTable: "product_categories",
    targetId: "bulk",
    metadata: { count: updates.length },
  });

  return NextResponse.json({ ok: true });
}
