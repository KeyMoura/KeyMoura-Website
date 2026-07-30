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
  threadId: number;
  parentPostId?: number | null;
  bodyMarkdown: string;
};

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

    const { threadId, parentPostId, bodyMarkdown } = body;

    if (!threadId || typeof threadId !== "number") {
      return NextResponse.json(
        { error: "threadId (number) is required." },
        { status: 400 }
      );
    }

    const trimmedBody = (bodyMarkdown ?? "").trim();
    if (!trimmedBody) {
      return NextResponse.json(
        { error: "Reply body is required." },
        { status: 400 }
      );
    }

    const prof = await hardBlockIfProfane(trimmedBody);
    if ("error" in prof) {
      return NextResponse.json({ error: prof.error }, { status: 400 });
    }

    // Rate limit: replies per hour
    // Normal members: 10/hr, Verified: 20/hr
    const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    let isVerified = false;
    const { data: actorProfile, error: profErr } = await serviceClient
      .from("profiles")
      .select("is_verified")
      .eq("id", actorUserId)
      .maybeSingle<{ is_verified: boolean | null }>();

    if (profErr) {
      console.error("Error loading profile for reply rate limit", profErr);
    } else {
      isVerified = !!actorProfile?.is_verified;
    }

    const maxRepliesPerHour = isVerified ? 20 : 10;
    const { count: recentReplyCount, error: replyCountErr } = await serviceClient
      .from("forum_posts")
      .select("id", { count: "exact", head: true })
      .eq("created_by", actorUserId)
      .gte("created_at", oneHourAgoIso)
      .eq("is_deleted", false);

    if (replyCountErr) {
      console.error("Failed to check reply rate limit", replyCountErr);
    } else if ((recentReplyCount ?? 0) >= maxRepliesPerHour) {
      return NextResponse.json(
        {
          error: isVerified
            ? "Rate limit: 20 replies per hour for verified users. Please wait and try again."
            : "Rate limit: 10 replies per hour. Please wait and try again.",
        },
        { status: 429 }
      );
    }

    // 3) Load thread
    const {
      data: thread,
      error: threadErr,
    } = await serviceClient
      .from("forum_threads")
      .select("id, category_id, created_by, is_locked, is_deleted, reply_count")
      .eq("id", threadId)
      .maybeSingle<{
        id: number;
        category_id: number;
        created_by: string;
        is_locked: boolean;
        is_deleted: boolean;
        reply_count: number | null;
      }>();

    if (threadErr) {
      console.error("Error loading thread in reply route", threadErr);
      return NextResponse.json(
        { error: "Failed to load thread." },
        { status: 500 }
      );
    }

    if (!thread || thread.is_deleted) {
      return NextResponse.json({ error: "Thread not found." }, { status: 404 });
    }

    if (thread.is_locked) {
      return NextResponse.json(
        { error: "This thread is locked and cannot accept new replies." },
        { status: 403 }
      );
    }

    // 4) Check category not archived
    const { data: category, error: categoryErr } = await serviceClient
      .from("forum_categories")
      .select("id, is_archived")
      .eq("id", thread.category_id)
      .maybeSingle<{ id: number; is_archived: boolean }>();

    if (categoryErr) {
      console.error("Error loading category in reply route", categoryErr);
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
        { error: "This category is archived and cannot accept new replies." },
        { status: 403 }
      );
    }

    // 5) Check user not banned
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
        { error: "You are banned and cannot reply." },
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
        { error: "You are restricted and cannot reply." },
        { status: 403 }
      );
    }

    // 6) If parentPostId is supplied, ensure it belongs to this thread
    let finalParentId: number | null = null;
    let parentPostAuthorId: string | null = null;
    if (parentPostId != null) {
      const { data: parentPost, error: parentErr } = await serviceClient
        .from("forum_posts")
        .select("id, thread_id, created_by, is_deleted")
        .eq("id", parentPostId)
        .maybeSingle<{
          id: number;
          thread_id: number;
          created_by: string;
          is_deleted: boolean;
        }>();

      if (parentErr) {
        console.error("Error loading parent post", parentErr);
        return NextResponse.json(
          { error: "Failed to validate parent post." },
          { status: 500 }
        );
      }

      if (
        !parentPost ||
        parentPost.thread_id !== thread.id ||
        parentPost.is_deleted
      ) {
        return NextResponse.json({ error: "Invalid parent post." }, { status: 400 });
      }

      finalParentId = parentPost.id;
      parentPostAuthorId = parentPost.created_by ?? null;
    }

    const now = new Date().toISOString();

    // 7) Insert reply
    const { data: postInsertData, error: postInsertErr } = await serviceClient
      .from("forum_posts")
      .insert({
        thread_id: thread.id,
        parent_post_id: finalParentId,
        created_by: actorUserId,
        created_at: now,
        body_markdown: trimmedBody,
        is_deleted: false,
      })
      .select("id")
      .maybeSingle<{ id: number }>();

    if (postInsertErr || !postInsertData) {
      console.error("Error inserting reply", postInsertErr);
      return NextResponse.json(
        { error: "Failed to create reply." },
        { status: 500 }
      );
    }

    const postId = postInsertData.id;

    // 8) Update thread reply_count + last_post_at/by
    const newReplyCount = (thread.reply_count ?? 0) + 1;

    const { error: threadUpdateErr } = await serviceClient
      .from("forum_threads")
      .update({
        reply_count: newReplyCount,
        last_post_at: now,
        last_post_by: actorUserId,
      })
      .eq("id", thread.id);

    if (threadUpdateErr) {
      console.error(
        "Error updating thread reply_count / last_post",
        threadUpdateErr
      );
      // don't fail the reply itself; just log
    }

    // 9) Notifications (reply + mentions)
    const excerpt = trimmedBody.slice(0, 140);

    // Reply notification to thread owner (TOP-LEVEL replies only).
    // If someone is replying to a specific comment (nested reply), the person who should be
    // notified is the author of that parent comment, not automatically the thread owner.
    if (finalParentId == null && thread.created_by && thread.created_by !== actorUserId) {
      void createNotification({
        recipientUserId: thread.created_by,
        actorUserId,
        type: "reply",
        threadId: thread.id,
        postId,
        payload: { excerpt },
      });
    }

    // Reply notification to the author of the parent post (comment reply)
    // If you reply directly to someone else's comment (including replying to a reply), notify *that* person.
    if (finalParentId != null && parentPostAuthorId && parentPostAuthorId !== actorUserId) {
      void createNotification({
        recipientUserId: parentPostAuthorId,
        actorUserId,
        type: "reply",
        threadId: thread.id,
        postId,
        payload: { excerpt, parentPostId: finalParentId },
      });
    }

    // Mention notifications (@username)
    const mentionUsernames = extractMentionUsernames(trimmedBody);
    if (mentionUsernames.length > 0) {
      const { data: mentionedProfiles, error: mentionErr } = await serviceClient
        .from("profiles")
        .select("id, username")
        .in("username", mentionUsernames);

      if (mentionErr) {
        console.error("Failed to resolve mentions", mentionErr);
      } else {
        for (const p of mentionedProfiles ?? []) {
          const mentionedId = (p as { id: string }).id;

          // avoid self + avoid duplicating reply notifications
          if (!mentionedId) continue;
          if (mentionedId === actorUserId) continue;
          // If this is a top-level reply, the thread owner may already get a "reply" notif.
          // For nested replies, allow mentions to notify the thread owner normally.
          if (finalParentId == null && thread.created_by && mentionedId === thread.created_by) continue;
          if (parentPostAuthorId && mentionedId === parentPostAuthorId) continue;

          void createNotification({
            recipientUserId: mentionedId,
            actorUserId,
            type: "mention",
            threadId: thread.id,
            postId,
            payload: { excerpt },
          });
        }
      }
    }

    // 10) Audit log
return NextResponse.json(
      {
        ok: true,
        postId,
        threadId: thread.id,
        createdAt: now,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in reply route", err);
    return NextResponse.json(
      { error: "Unexpected error creating reply." },
      { status: 500 }
    );
  }
}
