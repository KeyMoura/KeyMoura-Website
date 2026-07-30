import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";

type Ctx = { params: Promise<{ key: string }> };

/**
 * Deletes a permission key and removes it from roles/users.
 */
export async function DELETE(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "permissions.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await ctx.params;
  const permissionKey = (key ?? "").trim();
  if (!permissionKey) return NextResponse.json({ error: "Invalid key" }, { status: 400 });

  await routeServiceClient.from("role_permissions").delete().eq("permission_key", permissionKey);
  await routeServiceClient.from("user_permissions").delete().eq("permission_key", permissionKey);

  const { error } = await routeServiceClient.from("permissions").delete().eq("key", permissionKey);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
