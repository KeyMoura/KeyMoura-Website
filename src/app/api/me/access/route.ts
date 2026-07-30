import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { normalizeRole } from "@/lib/roles";
import { isBoolean, isRecord } from "@/lib/typeGuards";

type RoleMetaRow = {
  is_staff: boolean;
  badge_bg?: string | null;
  badge_border?: string | null;
  badge_text?: string | null;
};

async function getRoleIsStaff(roleKey: string): Promise<boolean> {
  try {
    const { data } = await routeServiceClient
      .from("roles")
      .select("is_staff")
      .eq("key", roleKey)
      .maybeSingle<RoleMetaRow>();
    if (isRecord(data) && isBoolean((data as RoleMetaRow).is_staff)) return (data as RoleMetaRow).is_staff;
  } catch {
  }
  return false;
}

async function getRoleStyle(
  roleKey: string
): Promise<{ badge_bg: string | null; badge_border: string | null; badge_text: string | null } | null> {
  try {
    const { data } = await routeServiceClient
      .from("roles")
      .select("badge_bg,badge_border,badge_text")
      .eq("key", roleKey)
      .maybeSingle<RoleMetaRow>();
    if (!isRecord(data)) return null;
    return {
      badge_bg: typeof (data as any).badge_bg === "string" ? (data as any).badge_bg : null,
      badge_border: typeof (data as any).badge_border === "string" ? (data as any).badge_border : null,
      badge_text: typeof (data as any).badge_text === "string" ? (data as any).badge_text : null,
    };
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const roleKey = normalizeRole(actor.role);
  const isStaff = await getRoleIsStaff(roleKey);
  const roleStyle = await getRoleStyle(roleKey);

  return NextResponse.json(
    {
      role: actor.role,
      permissions: Array.from(actor.permissions),
      isStaff,
      roleStyle,
      isOp: Boolean(actor.isOp),
    },
    { status: 200 }
  );
}
