import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

// Service-role backed helper to read the viewer's role.
// This avoids client-side RLS edge-cases where `user_roles` may not be readable,
// which can break staff bypass logic for blocks.

export async function GET(req: Request) {
  const authHeader = req.headers.get("authorization") || req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;

  if (!token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(token);
  const user = userData?.user ?? null;
  if (userErr || !user || !(await isUserAdmitted(user.id))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: roleRow, error: roleErr } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle<{ role: string }>();

  const roleLower = !roleErr && roleRow?.role ? String(roleRow.role).toLowerCase() : "member";
  const isStaff = roleLower === "admin" || roleLower === "support" || roleLower === "moderator" || roleLower === "mod";

  return NextResponse.json({ ok: true, user_id: user.id, role: roleLower, is_staff: isStaff });
}
