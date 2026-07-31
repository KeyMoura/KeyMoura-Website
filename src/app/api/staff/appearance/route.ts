import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { normalizeSiteTheme } from "@/theme/runtime";
import { logAuditEvent } from "@/lib/audit";

export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { data, error } = await routeServiceClient.from("site_settings")
    .select("primary_color,accent_color,theme_config").eq("singleton", true).maybeSingle();
  if (error || !data) return NextResponse.json({ error: "Could not load appearance." }, { status: 500 });
  return NextResponse.json({ primaryColor: data.primary_color, accentColor: data.accent_color, theme: normalizeSiteTheme(data.theme_config) });
}

export async function PATCH(req: NextRequest) {
  const actor = await requirePermission(req, "appearance.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  const hex = /^#[0-9a-f]{6}$/i;
  if (!body || typeof body.primaryColor !== "string" || !hex.test(body.primaryColor) ||
      typeof body.accentColor !== "string" || !hex.test(body.accentColor)) {
    return NextResponse.json({ error: "Colors must be six-digit hex values." }, { status: 400 });
  }
  const theme = normalizeSiteTheme(body.theme);
  const { error } = await routeServiceClient.from("site_settings").update({
    primary_color: body.primaryColor.toLowerCase(), accent_color: body.accentColor.toLowerCase(),
    theme_config: theme, updated_at: new Date().toISOString(),
  }).eq("singleton", true);
  if (error) return NextResponse.json({ error: "Could not save appearance." }, { status: 500 });
  await logAuditEvent({ actorUserId: actor.userId, actorRole: actor.role, eventType: "staff.appearance.update", targetTable: "site_settings", targetId: "singleton", metadata: { primaryColor: body.primaryColor, accentColor: body.accentColor } });
  revalidatePath("/", "layout");
  return NextResponse.json({ ok: true, primaryColor: body.primaryColor, accentColor: body.accentColor, theme });
}
