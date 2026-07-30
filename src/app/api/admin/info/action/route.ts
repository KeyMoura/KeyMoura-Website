import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { createClient as createBrowserClient } from "@supabase/supabase-js";
import { logAuditEvent } from "@/lib/audit";

const bodySchema = z.object({
  infoPageId: z.string().uuid(),
  action: z.enum(["approve", "deny", "forward"]),
  notes: z.string().max(2000).optional(),
});

// helper to get user from the access token cookie
async function getUserFromRequest(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    throw new Error("Missing Supabase URL or anon key");
  }

  // Supabase stores the access token in a cookie named "sb-access-token"
  const accessToken = req.cookies.get("sb-access-token")?.value;

  if (!accessToken) {
    return { user: null, error: "No access token" as const };
  }

  const supabase = createBrowserClient(url, anonKey);

  const {
    data: { user },
    error,
  } = await supabase.auth.getUser(accessToken);

  return { user, error };
}

export async function POST(req: NextRequest) {
  try {
    const json = await req.json();
    const parsed = bodySchema.safeParse(json);

    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid payload", details: parsed.error.flatten() },
        { status: 400 }
      );
    }

    const { infoPageId, action, notes } = parsed.data;

    // 1) Who is calling this?
    const { user, error: userError } = await getUserFromRequest(req);

    if (userError || !user || !(await isUserAdmitted(user.id))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const adminClient = supabaseAdmin();

    // 2) Check if they are admin
    const { data: roleRow, error: roleError } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle();

    if (roleError || !roleRow || roleRow.role !== "admin") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // 3) Load current info_page (for logging before/after)
    const { data: page, error: pageError } = await adminClient
      .from("info_pages")
      .select("id, title, content_markdown, status")
      .eq("id", infoPageId)
      .maybeSingle();

    if (pageError || !page) {
      return NextResponse.json(
        { error: "Info page not found" },
        { status: 404 }
      );
    }

    const previousStatus = page.status;

    let newStatus: string;
    let reviewAction: string;
    let auditEventType: string;

    if (action === "approve") {
      newStatus = "approved";
      reviewAction = "admin_approved";
      auditEventType = "info_page.approve";
    } else if (action === "deny") {
      newStatus = "rejected";
      reviewAction = "admin_denied";
      auditEventType = "info_page.deny";
    } else {
      // forward
      newStatus = "pending";
      reviewAction = "admin_forwarded_for_review";
      auditEventType = "info_page.forward";
    }

    // 4) Update the info_pages row
    const { error: updateError } = await adminClient
      .from("info_pages")
      .update({ status: newStatus })
      .eq("id", infoPageId);

    if (updateError) {
      console.error(updateError);
      return NextResponse.json(
        { error: "Failed to update info page" },
        { status: 500 }
      );
    }

    // 5) Insert review log entry
    const { error: logError } = await adminClient
      .from("info_page_review_events")
      .insert({
        info_page_id: infoPageId,
        action: reviewAction,
        performed_by: user.id,
        previous_title: page.title,
        previous_content_markdown: page.content_markdown,
        new_title: page.title,
        new_content_markdown: page.content_markdown,
        notes: notes ?? null,
      });

    if (logError) {
      console.error("info_page_review_events insert error", logError);
      // Don't fail the whole operation just because logging failed
    }

    // 6) Audit log (admin-only event)
    void logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType: auditEventType,
      targetTable: "info_pages",
      targetId: infoPageId,
      metadata: {
        previousStatus,
        newStatus,
        notes: notes ?? null,
        title: page.title ?? null,
      },
    });

    return NextResponse.json({ success: true });
  } catch (e) {
    console.error(e);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
