import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

export async function POST(req: NextRequest) {
  try {
    // 1) Auth from Authorization: Bearer <access_token>
    const authHeader = req.headers.get("authorization");
    const token =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser(token);

    if (userError || !user || !(await isUserAdmitted(user.id))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // 2) Check admin
    const { data: roleRow, error: roleErr } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (roleErr || !roleRow || roleRow.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 3) Parse body
    const body = await req.json();
    const {
      infoPageId,
      action,
      notes,
      previousStatus,
      newStatus,
      title,
    } = body as {
      infoPageId: string;
      action: "approve" | "deny" | "forward";
      notes?: string | null;
      previousStatus?: string | null;
      newStatus?: string | null;
      title?: string | null;
    };

    if (!infoPageId || !action) {
      return NextResponse.json(
        { error: "infoPageId and action are required." },
        { status: 400 }
      );
    }

    let eventType: string;
    if (action === "approve") eventType = "info_page.approve";
    else if (action === "deny") eventType = "info_page.deny";
    else eventType = "info_page.forward";

    // 4) Fire-and-forget audit log
    void logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType,
      targetTable: "info_pages",
      targetId: infoPageId,
      metadata: {
        previousStatus: previousStatus ?? null,
        newStatus: newStatus ?? null,
        notes: notes ?? null,
        title: title ?? null,
      },
    });

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("audit-info-action error", err);
    return NextResponse.json(
      { error: "Unexpected error." },
      { status: 500 }
    );
  }
}
