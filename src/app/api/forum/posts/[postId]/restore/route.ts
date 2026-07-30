import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

// Allow "Undo" within this window for authors. Staff can restore anytime (within recycle retention).
const UNDO_WINDOW_MS = 5 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    // Expected: ["api","forum","posts",":postId","restore"]
    if (segments.length < 5) {
      return NextResponse.json({ error: `Unexpected path: ${url.pathname}` }, { status: 400 });
    }

    const last = segments[segments.length - 1];
    const idSegment = last.toLowerCase() === "restore" ? segments[segments.length - 2] : last;

    const postIdNum = Number.parseInt(idSegment, 10);
    if (!Number.isFinite(postIdNum) || postIdNum <= 0) {
      return NextResponse.json({ error: `Invalid postId in path: "${idSegment}"` }, { status: 400 });
    }

    const authHeader = req.headers.get("authorization");
    const token =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

    if (!token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser(token);

    if (userError || !user || !(await isUserAdmitted(user.id))) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actorUserId = user.id;

    const { data: postRow, error: postErr } = await serviceClient
      .from("forum_posts")
      .select("id, created_by, is_deleted, updated_at")
      .eq("id", postIdNum)
      .maybeSingle<{
        id: number;
        created_by: string;
        is_deleted: boolean;
        updated_at: string | null;
      }>();

    if (postErr) {
      console.error("Error loading post for restore", postErr);
      return NextResponse.json({ error: "Failed to load post." }, { status: 500 });
    }

    if (!postRow) return NextResponse.json({ error: "Post not found." }, { status: 404 });
    if (!postRow.is_deleted) return NextResponse.json({ ok: true, already_restored: true }, { status: 200 });

    const { data: roleRow } = await serviceClient
      .from("user_roles")
      .select("role")
      .eq("user_id", actorUserId)
      .maybeSingle<{ role: string }>();

    const actorRole = roleRow?.role ?? null;
    const isStaff = actorRole === "admin" || actorRole === "moderator" || actorRole === "support";

    const isAuthor = postRow.created_by === actorUserId;

    if (!isStaff && !isAuthor) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    if (!isStaff) {
      const updatedAt = postRow.updated_at ? new Date(postRow.updated_at).getTime() : 0;
      const age = Date.now() - updatedAt;
      if (!Number.isFinite(updatedAt) || age > UNDO_WINDOW_MS) {
        return NextResponse.json({ error: "Undo window expired." }, { status: 403 });
      }
    }

    const now = new Date().toISOString();
    const { data: updated, error: updateErr } = await serviceClient
      .from("forum_posts")
      .update({ is_deleted: false, updated_at: now, edit_reason: null })
      .eq("id", postRow.id)
      .select("id, thread_id, parent_post_id, created_at, updated_at, created_by, body_markdown, is_deleted, edit_reason")
      .maybeSingle();

    if (updateErr || !updated) {
      console.error("Error restoring post", updateErr);
      return NextResponse.json({ error: "Failed to restore post." }, { status: 500 });
    }

    return NextResponse.json({ ok: true, post: updated }, { status: 200 });
  } catch (err) {
    console.error("Unexpected error in post restore route", err);
    return NextResponse.json({ error: "Unexpected error restoring post." }, { status: 500 });
  }
}
