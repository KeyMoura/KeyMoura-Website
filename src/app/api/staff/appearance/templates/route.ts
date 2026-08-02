import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import {
  normalizeAppearanceTemplateConfig,
  normalizeTemplateName,
  templateNameError,
  type AppearanceTemplate,
} from "@/theme/templates";

/**
 * Saved Appearance templates.
 *
 * Every request requires the same `appearance.manage` permission that guards
 * publishing, and all storage access uses the service role behind that check —
 * the table itself has row level security enabled with no anon or authenticated
 * policy, so it is unreachable from the browser client.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

type TemplateRow = { id: string; name: string; config: unknown; updated_at: string | null };

function toTemplate(row: TemplateRow): AppearanceTemplate {
  return {
    id: row.id,
    name: row.name,
    updatedAt: row.updated_at,
    ...normalizeAppearanceTemplateConfig(row.config),
  };
}

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return forbidden();

  const { data, error } = await routeServiceClient
    .from("site_appearance_templates")
    .select("id,name,config,updated_at")
    .order("name");

  if (error) return NextResponse.json({ error: "Could not load templates." }, { status: 500 });
  return NextResponse.json({ templates: ((data ?? []) as TemplateRow[]).map(toTemplate) });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return forbidden();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = normalizeTemplateName(body?.name);
  const nameError = templateNameError(name);
  if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

  // Normalizing before storage means a template is always a complete,
  // valid configuration regardless of what the client sent.
  const config = normalizeAppearanceTemplateConfig(body?.config);

  const { data, error } = await routeServiceClient
    .from("site_appearance_templates")
    .insert({ name, config, created_by: actor.userId })
    .select("id,name,config,updated_at")
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: `A template named “${name}” already exists.` }, { status: 409 });
    }
    return NextResponse.json({ error: "Could not save the template." }, { status: 500 });
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.appearance.template.create",
    targetTable: "site_appearance_templates",
    targetId: data.id,
    metadata: { name },
  });

  return NextResponse.json({ template: toTemplate(data as TemplateRow) }, { status: 201 });
}
