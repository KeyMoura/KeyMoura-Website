import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createNotification, extractMentionUsernames } from "@/lib/notifications";
import { hardBlockIfProfane } from "@/lib/profanity";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

type Body = {
  categoryId: number;
  title: string;
  bodyMarkdown: string;
  tags?: string[] | null;
};

function slugifyTitle(raw: string): string {
  const base = raw
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!base) {
    return `thread-${Date.now()}`;
  }
  return base;
}

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((tag) => (typeof tag === "string" ? tag.trim().toLowerCase() : ""))
    .filter((tag) => tag.length > 0 && tag.length <= 24);
  return Array.from(new Set(cleaned)).slice(0, 8);
}

export async function POST(req: NextRequest) {
  try {
    // 1) Auth via Authorization: Bearer <token>
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

    const actorUserId = user.id;

    // Rate limit: threads per hour
    // Normal members: 1/hr, Verified: 2/hr
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let isVerified = false;
    const { data: actorProfile, error: profErr } = await serviceClient
      .from("profiles")
      .select("is_verified")
      .eq("id", actorUserId)
      .maybeSingle<{ is_verified: boolean | null }>();

    if (profErr) {
      console.error("Error loading profile for rate limit", profErr);
    } else {
      isVerified = !!actorProfile?.is_verified;
    }

    const maxThreadsPerHour = isVerified ? 2 : 1;
    const { count: recentThreadCount, error: threadCountErr } = await serviceClient
      .from("forum_threads")
      .select("id", { count: "exact", head: true })
      .eq("author_user_id", actorUserId)
      .gte("created_at", oneHourAgoIso);

    if (threadCountErr) {
      console.error("Failed to check thread rate limit", threadCountErr);
    } else if ((recentThreadCount ?? 0) >= maxThreadsPerHour) {
      return NextResponse.json(
        {
          error: isVerified
            ? "Rate limit: 2 threads per hour for verified users. Please wait and try again."
            : "Rate limit: 1 thread per hour. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    // 2) Parse body
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body." },
        { status: 400 }
      );
    }

    const { categoryId, title, bodyMarkdown } = body;
    const tags = normalizeTags(body.tags);

    if (!categoryId || typeof categoryId !== "number") {
      return NextResponse.json(
        { error: "categoryId (number) is required." },
        { status: 400 }
      );
    }

    const trimmedTitle = (title ?? "").trim();
    const trimmedBody = (bodyMarkdown ?? "").trim();

    if (!trimmedTitle) {
      return NextResponse.json({ error: "Title is required." }, { status: 400 });
    }

    if (!trimmedBody) {
      return NextResponse.json({ error: "Body is required." }, { status: 400 });
    }

    const profTitle = await hardBlockIfProfane(trimmedTitle);
    if ("error" in profTitle) {
      return NextResponse.json({ error: profTitle.error }, { status: 400 });
    }
    const profBody = await hardBlockIfProfane(trimmedBody);
    if ("error" in profBody) {
      return NextResponse.json({ error: profBody.error }, { status: 400 });
    }

    // 3) Check category exists and not archived
    const { data: category, error: categoryErr } = await serviceClient
      .from("forum_categories")
      .select("id, slug, name, is_archived")
      .eq("id", categoryId)
      .maybeSingle<{
        id: number;
        slug: string;
        name: string;
        is_archived: boolean;
      }>();

    if (categoryErr) {
      console.error("Error loading category in create-thread", categoryErr);
      return NextResponse.json(
        { error: "Failed to load category." },
        { status: 500 }
      );
    }

    if (!category) {
      return NextResponse.json({ error: "Category not found." }, { status: 404 });
    }

    if (category.is_archived) {
      return NextResponse.json(
        { error: "This category is archived and cannot accept new threads." },
        { status: 403 }
      );
    }

    // 4) Check if user is banned
    const { data: banRow, error: banErr } = await serviceClient
      .from("user_bans")
      .select("id, active")
      .eq("user_id", actorUserId)
      .eq("active", true)
      .maybeSingle<{ id: number; active: boolean }>();

    if (banErr) {
      console.error("Error checking user ban status", banErr);
      return NextResponse.json(
        { error: "Failed to check user ban status." },
        { status: 500 }
      );
    }

    if (banRow && banRow.active !== false) {
      return NextResponse.json(
        { error: "You are banned and cannot create threads." },
        { status: 403 }
      );
    }

    // 4b) Check community / site restrictions (temp bans, community-only bans)
    const { data: restrRows, error: restrErr } = await serviceClient
      .from("user_restrictions")
      .select("id, kind, active, expires_at")
      .eq("user_id", actorUserId)
      .eq("active", true)
      .in("kind", ["site", "community"]);

    if (restrErr) {
      console.error("Error checking user restrictions", restrErr);
      return NextResponse.json(
        { error: "Failed to check user restriction status." },
        { status: 500 }
      );
    }

    const nowMs = Date.now();
    const activeRestr = (restrRows ?? []).find((r) => {
      const exp = (r as { expires_at?: unknown })?.expires_at;
      if (typeof exp === "string" && exp.length) {
        const t = new Date(exp).getTime();
        return Number.isFinite(t) ? t > nowMs : true;
      }
      return true;
    });

    if (activeRestr) {
      return NextResponse.json(
        { error: "You are restricted and cannot create threads." },
        { status: 403 }
      );
    }

    // 5) Build a unique slug for this category
    const baseSlug = slugifyTitle(trimmedTitle);
    let finalSlug = baseSlug;
    let suffix = 2;

    for (let i = 0; i < 32; i++) {
      const { data: existing, error: slugErr } = await serviceClient
        .from("forum_threads")
        .select("id")
        .eq("category_id", category.id)
        .eq("slug", finalSlug)
        .limit(1)
        .maybeSingle<{ id: number }>();

      if (slugErr) {
        console.error("Error checking slug uniqueness", slugErr);
        return NextResponse.json(
          { error: "Failed to validate thread slug." },
          { status: 500 }
        );
      }

      if (!existing) break;
      finalSlug = `${baseSlug}-${suffix++}`;
    }

    const now = new Date().toISOString();

    // 6) Insert thread
    const { data: threadInsertData, error: threadInsertErr } = await serviceClient
      .from("forum_threads")
      .insert({
        category_id: category.id,
        title: trimmedTitle,
        slug: finalSlug,
        created_by: actorUserId,
        created_at: now,
        last_post_at: now,
        last_post_by: actorUserId,
        reply_count: 0,
        view_count: 0,
        is_locked: false,
        is_pinned: false,
        is_deleted: false,
        tags,
      })
      .select("id")
      .maybeSingle<{ id: number }>();

    if (threadInsertErr || !threadInsertData) {
      console.error("Error inserting thread", threadInsertErr);
      return NextResponse.json(
        { error: "Failed to create thread." },
        { status: 500 }
      );
    }

    const threadId = threadInsertData.id;

    // 7) Insert OP post
    const { data: opPost, error: postInsertErr } = await serviceClient
      .from("forum_posts")
      .insert({
        thread_id: threadId,
        parent_post_id: null,
        created_by: actorUserId,
        created_at: now,
        body_markdown: trimmedBody,
        is_deleted: false,
      })
      .select("id")
      .maybeSingle<{ id: number }>();

    if (postInsertErr) {
      console.error("Error inserting initial post", postInsertErr);
      return NextResponse.json(
        { error: "Thread created, but failed to save initial post." },
        { status: 500 }
      );
    }

    // 7.5) Mention notifications in the OP body (@username)
    const opPostId = opPost?.id ?? null;
    const mentionUsernames = extractMentionUsernames(trimmedBody);
    if (opPostId && mentionUsernames.length > 0) {
      const { data: mentionedProfiles, error: mentionErr } = await serviceClient
        .from("profiles")
        .select("id, username")
        .in("username", mentionUsernames);

      if (mentionErr) {
        console.error("Failed to resolve OP mentions", mentionErr);
      } else {
        const excerpt = trimmedBody.slice(0, 140);
        for (const p of mentionedProfiles ?? []) {
          const mentionedId = (p as { id: string }).id;
          if (!mentionedId) continue;
          if (mentionedId === actorUserId) continue;

          void createNotification({
            recipientUserId: mentionedId,
            actorUserId,
            type: "mention",
            threadId,
            postId: opPostId,
            payload: { excerpt },
          });
        }
      }
    }

    // 8) Audit log
return NextResponse.json(
      {
        ok: true,
        threadId,
        slug: finalSlug,
        categorySlug: category.slug,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in create-thread route", err);
    return NextResponse.json(
      { error: "Unexpected error creating thread." },
      { status: 500 }
    );
  }
}
