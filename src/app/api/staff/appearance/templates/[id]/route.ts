import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import {
  normalizeAppearanceTemplateConfig,
  normalizeTemplateName,
  templateNameError,
} from "@/theme/templates";

/** Rename and delete for a single saved Appearance template. */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Unknown template." }, { status: 404 });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = normalizeTemplateName(body?.name);
  const nameError = templateNameError(name);
  if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("site_appearance_templates")
    .update({ name, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id,name,config,updated_at")
    .maybeSingle();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `A template named “${name}” already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: "Could not rename the template." }, { status: 500 });
  }
  if (!data) return NextResponse.json({ error: "Unknown template." }, { status: 404 });

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.appearance.template.rename",
    targetTable: "site_appearance_templates",
    targetId: id,
    metadata: { name },
  });

  return NextResponse.json({
    template: { id: data.id, name: data.name, updatedAt: data.updated_at, ...normalizeAppearanceTemplateConfig(data.config) },
  });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  if (!UUID.test(id)) return NextResponse.json({ error: "Unknown template." }, { status: 404 });

  const { data, error } = await routeServiceClient
    .from("site_appearance_templates")
    .delete()
    .eq("id", id)
    .select("id,name")
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Could not delete the template." }, { status: 500 });
  if (!data) return NextResponse.json({ error: "Unknown template." }, { status: 404 });

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.appearance.template.delete",
    targetTable: "site_appearance_templates",
    targetId: id,
    metadata: { name: data.name },
  });

  return NextResponse.json({ ok: true });
}
