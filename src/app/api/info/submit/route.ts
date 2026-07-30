import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { hardBlockIfProfane } from "@/lib/profanity";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!supabaseUrl || !serviceRoleKey) {
  console.warn(
    "[info/submit] Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars."
  );
}

// SINGLE server-side client using service role (bypass RLS, we do auth ourselves)
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
  },
});

type SubmitBody = {
  title?: string;
  slug?: string;
  content?: string;
  category?: string;
  chassis?: string;
  tags?: string[];
  draftId?: string | null;
  infoPageId?: string | null; // when resubmitting a rejected page
};

export async function POST(req: NextRequest) {
  try {
    // 1) Read bearer token from header
    const authHeader =
      req.headers.get("authorization") ?? req.headers.get("Authorization");
    const token =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice(7)
        : null;

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "You must be logged in to submit an info page." },
        { status: 401 }
      );
    }

    // 2) Verify token & get user (requires service role key)
    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(token);

    if (userError || !user || !(await isUserAdmitted(user.id))) {
      console.error("[info/submit] getUser error:", userError);
      return NextResponse.json(
        { ok: false, error: "You must be logged in to submit an info page." },
        { status: 401 }
      );
    }

    // 3) Load security flags
    const { data: secRow, error: secError } = await supabaseAdmin
      .from("site_security_settings")
      .select("maintenance_mode")
      .eq("id", 1)
      .maybeSingle<{
        maintenance_mode: boolean | null;
      }>();

    if (secError) {
      console.error("[info/submit] failed to load site_security_settings:", secError);
    }

    const maintenanceMode = !!secRow?.maintenance_mode;

    // 4) Check if user is admin
    const { data: roleRow, error: roleError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .maybeSingle<{ role: string }>();

    if (roleError) {
      console.error("[info/submit] failed to load user_roles:", roleError);
    }

    const isAdmin = roleRow?.role === "admin";

    // 5) Maintenance mode: block non-admin writes
    if (maintenanceMode && !isAdmin) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Site is currently in maintenance mode. Info submissions are temporarily disabled.",
        },
        { status: 503 }
      );
    }

    // 6) Parse and validate body
    const body = (await req.json()) as SubmitBody;

    const title = (body.title ?? "").trim();
    const slug = (body.slug ?? "").trim();
    const content = (body.content ?? "").trim();
    const category = (body.category ?? "maintenance-general").trim();
    const chassis = (body.chassis ?? "general").trim();
    const tags = Array.isArray(body.tags) ? body.tags : [];
    const draftId = body.draftId ?? null;
    const infoPageId = (body.infoPageId ?? null) ? String(body.infoPageId) : null;

    if (!title || !slug || !content) {
      return NextResponse.json(
        {
          ok: false,
          error: "Title, slug, and content are required.",
        },
        { status: 400 }
      );
    }
    const profTitle = await hardBlockIfProfane(title);
    if ("error" in profTitle) {
      return NextResponse.json({ ok: false, error: profTitle.error }, { status: 400 });
    }
    const profContent = await hardBlockIfProfane(content);
    if ("error" in profContent) {
      return NextResponse.json({ ok: false, error: profContent.error }, { status: 400 });
    }


    if (!/^[a-z0-9\-]+$/.test(slug)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Slug must contain only lowercase letters, numbers, and dashes.",
        },
        { status: 400 }
      );
    }

    // 7) Resubmit (update) rejected page OR insert a new pending page
    let submittedId: string | null = null;

    if (infoPageId) {
      // Validate ownership + status
      const { data: existing, error: existingErr } = await supabaseAdmin
        .from("info_pages")
        .select("id, created_by, status")
        .eq("id", infoPageId)
        .maybeSingle<{ id: string; created_by: string | null; status: string | null }>();

      if (existingErr || !existing) {
        console.error("[info/submit] resubmit load error:", existingErr);
        return NextResponse.json(
          { ok: false, error: "Submission not found." },
          { status: 404 }
        );
      }

      if (existing.created_by !== user.id || (existing.status ?? "").toLowerCase() !== "rejected") {
        return NextResponse.json(
          { ok: false, error: "You can only resubmit your own rejected submissions." },
          { status: 403 }
        );
      }

      // Prevent slug collision with other pages
      const { data: slugClash, error: slugErr } = await supabaseAdmin
        .from("info_pages")
        .select("id")
        .eq("slug", slug)
        .neq("id", infoPageId)
        .limit(1);

      if (slugErr) {
        console.error("[info/submit] slug check error:", slugErr);
      }
      if ((slugClash ?? []).length > 0) {
        return NextResponse.json(
          { ok: false, error: "That slug is already in use." },
          { status: 400 }
        );
      }

      const { error: updateErr } = await supabaseAdmin
        .from("info_pages")
        .update({
          title,
          slug,
          content_markdown: content,
          status: "pending",
          category,
          chassis,
          tags,
        })
        .eq("id", infoPageId)
        .eq("created_by", user.id);

      if (updateErr) {
        console.error("[info/submit] resubmit update error:", updateErr);
        return NextResponse.json(
          { ok: false, error: updateErr.message ?? "Failed to resubmit. Please try again." },
          { status: 500 }
        );
      }

      submittedId = infoPageId;
    } else {
      const { data: inserted, error: insertError } = await supabaseAdmin
        .from("info_pages")
        .insert({
          title,
          slug,
          content_markdown: content,
          created_by: user.id,
          status: "pending",
          category,
          chassis,
          tags,
        })
        .select("id")
        .maybeSingle<{ id: string }>();

      if (insertError || !inserted) {
        console.error("[info/submit] insert error:", insertError);
        return NextResponse.json(
          {
            ok: false,
            error:
              insertError?.message ??
              "Failed to submit info page. Please try again.",
          },
          { status: 500 }
        );
      }

      submittedId = inserted.id;
    }

    // 8) Delete draft if provided (non-fatal if it fails)
    if (draftId) {
      const { error: draftDeleteError } = await supabaseAdmin
        .from("info_page_drafts")
        .delete()
        .eq("id", draftId)
        .eq("created_by", user.id);

      if (draftDeleteError) {
        console.error(
          "[info/submit] failed to delete draft after submit:",
          draftDeleteError
        );
      }
    }

    return NextResponse.json({ ok: true, infoPageId: submittedId }, { status: 200 });
  } catch (e) {
    console.error("[info/submit] unexpected error:", e);
    return NextResponse.json(
      {
        ok: false,
        error: "Unexpected error while submitting info page.",
      },
      { status: 500 }
    );
  }
}
