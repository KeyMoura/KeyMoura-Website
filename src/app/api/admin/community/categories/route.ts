import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!actor.permissions.has("community.categories.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { data, error } = await routeServiceClient
    .from("forum_categories")
    .select("id, slug, name, description, is_archived, created_at")
    .order("created_at", { ascending: true });

  if (error) return NextResponse.json({ error: "Failed to load categories." }, { status: 500 });

  return NextResponse.json({ ok: true, categories: data ?? [] }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!actor.permissions.has("community.categories.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { slug?: string; name?: string; description?: string | null };

  const slug = (body.slug ?? "").trim();
  const name = (body.name ?? "").trim();
  const description = body.description ?? null;

  if (!slug || !name) return NextResponse.json({ error: "Slug and name are required." }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("forum_categories")
    .insert({ slug, name, description, is_archived: false })
    .select("id, slug, name, description, is_archived, created_at")
    .single();

  if (error) return NextResponse.json({ error: "Failed to create category." }, { status: 500 });

  void logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "community.category_create",
    targetTable: "forum_categories",
    targetId: String((data as any)?.id),
    metadata: { slug, name },
  });

  return NextResponse.json({ ok: true, category: data }, { status: 200 });
}
