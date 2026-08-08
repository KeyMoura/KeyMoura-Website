import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { readJson, asRecord } from "@/lib/json";
import { isBoolean, isNumber, isString } from "@/lib/typeGuards";
import { isRoleBadgeIcon, normalizeBadgeIcon, toRoleDbColumns } from "@/lib/staff/roleSchema";

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

function parseUpdatePayload(v: unknown): { value: Record<string, unknown> } | { error: string } {
  const r = asRecord(v);
  if (!r) return { error: "Send the fields to change." };

  // Built in the wire vocabulary, then translated once by `toRoleDbColumns`.
  // Nothing here may name a database column directly — that is what let
  // `label`, `priority` and `badge_icon` reach the table unchecked.
  const wire: Record<string, unknown> = {};

  if (isString(r.label)) {
    const label = r.label.trim();
    if (!label) return { error: "A role label cannot be empty." };
    if (label.length > 60) return { error: "A role label is at most 60 characters." };
    wire.label = label;
  }
  if (isString(r.description)) wire.description = r.description;
  if (r.description === null) wire.description = null;
  if (isNumber(r.priority)) wire.priority = Math.trunc(r.priority);
  if (isBoolean(r.is_staff)) wire.is_staff = r.is_staff;

  for (const field of ["badge_bg", "badge_border", "badge_text"] as const) {
    const value = r[field];
    if (value === undefined) continue;
    if (!isString(value) || !HEX.test(value.trim())) {
      return { error: "A badge colour has to be a hex value such as #1F2937." };
    }
    wire[field] = value.trim();
  }

  if (r.badge_icon === null || r.badge_icon === "") {
    wire.badge_icon = null;
  } else if (r.badge_icon !== undefined) {
    if (!isRoleBadgeIcon(r.badge_icon)) return { error: "That is not one of the available badge icons." };
    wire.badge_icon = normalizeBadgeIcon(r.badge_icon);
  }

  const updates = toRoleDbColumns(wire);
  if (!Object.keys(updates).length) return { error: "Nothing to change." };
  return { value: updates };
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission(req, "roles.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const roleKey = String(key ?? "").trim().toLowerCase();
  if (!roleKey) return NextResponse.json({ error: "Invalid role key" }, { status: 400 });

  const payload = await readJson(req);
  const parsed = parseUpdatePayload(payload);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { data, error } = await routeServiceClient
    .from("roles")
    .update(parsed.value)
    .eq("key", roleKey)
    .select("key");
  if (error) return NextResponse.json({ error: "Could not update the role." }, { status: 400 });
  if (!data?.length) return NextResponse.json({ error: "That role no longer exists." }, { status: 404 });

  return NextResponse.json({ ok: true }, { status: 200 });
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const actor = await requirePermission(req, "roles.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const roleKey = String(key ?? "").trim().toLowerCase();
  if (!roleKey) return NextResponse.json({ error: "Invalid role key" }, { status: 400 });

  // Two guards the route did not have. `admin`, `moderator`, `support` and
  // `member` are all `is_system`, and deleting `admin` would remove the only
  // role that carries every permission — from inside the page that requires it.
  const { data: role, error: readError } = await routeServiceClient
    .from("roles")
    .select("key,is_system")
    .eq("key", roleKey)
    .maybeSingle();
  if (readError) return NextResponse.json({ error: "Could not read the role." }, { status: 400 });
  if (!role) return NextResponse.json({ error: "That role no longer exists." }, { status: 404 });
  if (role.is_system) {
    return NextResponse.json({ error: "Built-in roles cannot be deleted." }, { status: 409 });
  }

  // Deleting a role that people still hold would leave `profiles.role` naming
  // something that no longer exists, and those accounts would resolve to no
  // permissions at all. Move them first.
  const { count, error: countError } = await routeServiceClient
    .from("profiles")
    .select("id", { count: "exact", head: true })
    .eq("role", roleKey);
  if (countError) return NextResponse.json({ error: "Could not check the role." }, { status: 400 });
  if (count && count > 0) {
    return NextResponse.json(
      { error: `${count} ${count === 1 ? "account still holds" : "accounts still hold"} this role. Move them first.` },
      { status: 409 }
    );
  }

  const { error } = await routeServiceClient.from("roles").delete().eq("key", roleKey);
  if (error) return NextResponse.json({ error: "Could not delete the role." }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
