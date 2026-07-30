import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { readJson, asRecord } from "@/lib/json";
import { isBoolean, isNumber, isString } from "@/lib/typeGuards";

function parseUpdatePayload(v: unknown): Record<string, unknown> | null {
  const r = asRecord(v);
  if (!r) return null;

  const updates: Record<string, unknown> = {};
  if (isString(r.label)) updates.label = r.label.trim();
  if (isString(r.description)) updates.description = r.description;
  if (r.description === null) updates.description = null;
  if (isNumber(r.priority)) updates.priority = r.priority;
  if (isBoolean(r.is_staff)) updates.is_staff = r.is_staff;
  if (isString(r.badge_bg)) updates.badge_bg = r.badge_bg;
  if (isString(r.badge_border)) updates.badge_border = r.badge_border;
  if (isString(r.badge_text)) updates.badge_text = r.badge_text;
  if (isString(r.badge_icon)) updates.badge_icon = r.badge_icon;
  if (r.badge_icon === null) updates.badge_icon = null;
  return Object.keys(updates).length ? updates : null;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission(req, "roles.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const roleKey = String(key ?? "").trim().toLowerCase();
  if (!roleKey) return NextResponse.json({ error: "Invalid role key" }, { status: 400 });

  const payload = await readJson(req);
  const updates = parseUpdatePayload(payload);
  if (!updates) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { error } = await routeServiceClient.from("roles").update(updates).eq("key", roleKey);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission(req, "roles.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const roleKey = String(key ?? "").trim().toLowerCase();
  if (!roleKey) return NextResponse.json({ error: "Invalid role key" }, { status: 400 });

  const { error } = await routeServiceClient.from("roles").delete().eq("key", roleKey);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
