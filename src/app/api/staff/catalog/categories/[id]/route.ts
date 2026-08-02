import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import {
  categoryNameProblem,
  categorySlug,
  deletionProblem,
  normalizeCategoryName,
  parentProblem,
  uniqueCategorySlug,
  type CategoryRow,
} from "@/lib/commerce/categories";

/**
 * Edit, archive, and delete a single category.
 *
 * Deleting is refused while any product or subcategory still points at the
 * category, so nothing can be orphaned by a careless click. Archiving is the
 * always-available alternative and hides the category from the storefront
 * without touching the products in it.
 */

const CATEGORY_COLUMNS = "id,name,slug,description,parent_id,image_url,display_order,is_active,archived_at";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const notFound = () => NextResponse.json({ error: "Unknown category." }, { status: 404 });

const cleanText = (value: unknown, max: number): string | null => {
  if (typeof value !== "string") return null;
  const text = value.trim().slice(0, max);
  return text || null;
};

const cleanAsset = (value: unknown): string | null | undefined => {
  if (value == null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, 1000);
  if (!text) return null;
  return text.startsWith("/") || /^https:\/\//i.test(text) ? text : undefined;
};

async function loadAll(): Promise<CategoryRow[]> {
  const { data } = await routeServiceClient.from("product_categories").select(CATEGORY_COLUMNS);
  return (data ?? []) as CategoryRow[];
}

async function directProductCount(categoryId: string): Promise<number> {
  const { count } = await routeServiceClient
    .from("products")
    .select("id", { count: "exact", head: true })
    .eq("category_id", categoryId);
  return count ?? 0;
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "catalog.categories.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!UUID.test(id)) return notFound();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Nothing to change." }, { status: 400 });

  const rows = await loadAll();
  const current = rows.find((row) => row.id === id);
  if (!current) return notFound();

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("name" in body) {
    const name = normalizeCategoryName(body.name);
    const parentId = "parentId" in body
      ? (typeof body.parentId === "string" && body.parentId ? body.parentId : null)
      : current.parent_id;
    const problem = categoryNameProblem(name, rows, parentId, id);
    if (problem === "blank") return NextResponse.json({ error: "Give the category a name." }, { status: 400 });
    if (problem === "duplicate") {
      return NextResponse.json({ error: `A category named “${name}” already exists here.` }, { status: 409 });
    }
    patch.name = name;
  }

  if ("slug" in body) {
    const requested = categorySlug(String(body.slug ?? ""));
    // Keep the requested slug when it is free; otherwise suffix rather than
    // silently overwriting somebody else's.
    patch.slug = requested === current.slug
      ? current.slug
      : uniqueCategorySlug(requested, rows.filter((row) => row.id !== id).map((row) => row.slug));
  }

  if ("parentId" in body) {
    const parentId = typeof body.parentId === "string" && body.parentId ? body.parentId : null;
    const problem = parentProblem(id, parentId, rows);
    if (problem) return NextResponse.json({ error: problem }, { status: 400 });
    patch.parent_id = parentId;
  }

  if ("description" in body) patch.description = cleanText(body.description, 500);

  if ("imageUrl" in body) {
    const imageUrl = cleanAsset(body.imageUrl);
    if (imageUrl === undefined) {
      return NextResponse.json({ error: "Image paths must start with / or https://." }, { status: 400 });
    }
    patch.image_url = imageUrl;
  }

  if ("isActive" in body) patch.is_active = Boolean(body.isActive);
  if ("displayOrder" in body) patch.display_order = Math.max(0, Math.trunc(Number(body.displayOrder) || 0));

  if ("archived" in body) {
    patch.archived_at = body.archived ? new Date().toISOString() : null;
    // Archiving also removes it from the storefront; un-archiving does not
    // silently republish it, so staff stay in control of visibility.
    if (body.archived) patch.is_active = false;
  }

  const { data, error } = await routeServiceClient
    .from("product_categories")
    .update(patch)
    .eq("id", id)
    .select(CATEGORY_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === "23505") return NextResponse.json({ error: "That slug is already in use." }, { status: 409 });
    return NextResponse.json({ error: error.message || "Could not save the category." }, { status: 400 });
  }
  if (!data) return notFound();

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.category.update",
    targetTable: "product_categories",
    targetId: id,
    metadata: { fields: Object.keys(patch).filter((key) => key !== "updated_at") },
  });

  return NextResponse.json({ category: data });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "catalog.categories.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!UUID.test(id)) return notFound();

  const rows = await loadAll();
  const current = rows.find((row) => row.id === id);
  if (!current) return notFound();

  const productCount = await directProductCount(id);
  const problem = deletionProblem(current, rows, productCount);
  if (problem) {
    return NextResponse.json({ error: problem, canArchive: true }, { status: 409 });
  }

  const { error } = await routeServiceClient.from("product_categories").delete().eq("id", id);
  if (error) return NextResponse.json({ error: "Could not delete the category." }, { status: 500 });

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.category.delete",
    targetTable: "product_categories",
    targetId: id,
    metadata: { name: current.name, slug: current.slug },
  });

  return NextResponse.json({ ok: true });
}

/** Moves every product out of this category, so it can then be deleted. */
export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "catalog.categories.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!UUID.test(id)) return notFound();

  const body = (await req.json().catch(() => null)) as { targetCategoryId?: unknown } | null;
  const target = typeof body?.targetCategoryId === "string" && body.targetCategoryId ? body.targetCategoryId : null;
  if (target !== null && !UUID.test(target)) {
    return NextResponse.json({ error: "Choose a category to move these products into." }, { status: 400 });
  }

  const rows = await loadAll();
  if (!rows.some((row) => row.id === id)) return notFound();
  if (target && !rows.some((row) => row.id === target)) {
    return NextResponse.json({ error: "That destination category no longer exists." }, { status: 400 });
  }

  const { error, count } = await routeServiceClient
    .from("products")
    .update({ category_id: target, updated_at: new Date().toISOString() }, { count: "exact" })
    .eq("category_id", id);

  if (error) return NextResponse.json({ error: "Could not move those products." }, { status: 500 });

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.catalog.category.move_products",
    targetTable: "products",
    targetId: id,
    metadata: { from: id, to: target, moved: count ?? 0 },
  });

  return NextResponse.json({ ok: true, moved: count ?? 0 });
}
