// app/api/forum/posts/[postId]/vote/route.ts
import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createNotification } from "@/lib/notifications";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

type VoteValue = -1 | 0 | 1;

type VoteBody = { value: VoteValue };
type VoteRequestBody = { value?: unknown };

type ApplyVoteRpcRow = { my_vote: number };

function coerceVoteValue(input: unknown): VoteValue | null {
  const n = typeof input === "number" ? input : Number(input);
  if (n === 1) return 1;
  if (n === -1) return -1;
  if (n === 0) return 0;
  return null;
}

const VOTE_MILESTONES = new Set<number>([
  1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 25000, 50000, 100000,
]);

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ postId: string }> }
) {
  try {
    const { postId } = await ctx.params;
    const postIdNum = Number(postId);
    if (!Number.isFinite(postIdNum)) {
      return NextResponse.json({ error: "Invalid postId." }, { status: 400 });
    }

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
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

    // --- Parse + validate body (NO any) ---
    let body: VoteBody;
    try {
      const raw: VoteRequestBody | null = await req
        .json()
        .then((x: unknown) =>
          typeof x === "object" && x !== null ? (x as VoteRequestBody) : null
        )
        .catch(() => null);

      const vv = coerceVoteValue(raw?.value);
      if (vv === null) throw new Error("bad vote");
      body = { value: vv };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    // Apply the vote via a DB function (atomic & safe)
    const { data: rpcData, error: rpcErr } = await serviceClient.rpc(
      "apply_post_vote",
      {
        p_post_id: postIdNum,
        p_voter_user_id: user.id,
        p_value: body.value,
      }
    );

    if (rpcErr) {
      console.error("apply_post_vote rpc error", rpcErr);

      const msg =
        typeof rpcErr.message === "string" &&
        rpcErr.message.toLowerCase().includes("own post")
          ? "You can’t vote on your own post."
          : "Failed to apply vote.";

      return NextResponse.json({ error: msg }, { status: 400 });
    }

    // Fetch updated post (what the UI expects)
    const { data: postRow, error: postErr } = await serviceClient
      .from("forum_posts")
      .select(
        "id, thread_id, parent_post_id, created_at, updated_at, created_by, body_markdown, is_deleted, edit_reason, vote_score, upvote_count, downvote_count"
      )
      .eq("id", postIdNum)
      .maybeSingle();

    if (postErr || !postRow) {
      console.error("Failed to load updated post after vote", postErr);
      return NextResponse.json(
        { error: "Vote applied, but failed to load updated post." },
        { status: 500 }
      );
    }

    // Normalize rpc response -> my_vote
    const row: ApplyVoteRpcRow | null = Array.isArray(rpcData)
      ? ((rpcData[0] ?? null) as ApplyVoteRpcRow | null)
      : rpcData && typeof rpcData === "object"
        ? (rpcData as ApplyVoteRpcRow)
        : null;

    const myVoteNum = row?.my_vote;
    const my_vote: VoteValue = myVoteNum === 1 ? 1 : myVoteNum === -1 ? -1 : 0;

    // --- Notifications ---
    // Only notify when the post reaches a milestone upvote_count
    if (my_vote === 1 && postRow.created_by !== user.id) {
      const upvotes = Number(postRow.upvote_count ?? 0);

      if (VOTE_MILESTONES.has(upvotes)) {
        // de-dupe: do not create the same milestone notification twice
        const { data: existing, error: existingErr } = await serviceClient
          .from("notifications")
          .select("id")
          .eq("user_id", postRow.created_by)
          .eq("type", "vote")
          .eq("post_id", postRow.id)
          .contains("payload", { milestone: upvotes })
          .limit(1);

        if (existingErr) {
          console.error(
            "Failed to check existing vote milestone notification",
            existingErr
          );
        }

        if (!existing?.length) {
          // ✅ FIX: "is_thread_post" should mean "this is the thread's lead/OP post",
          // not merely "top-level (parent_post_id is null)".
          let isThreadPost = false;

          // Only top-level posts could possibly be the thread-starter.
          if (postRow.parent_post_id == null) {
            // 1) Get the thread owner
            const { data: threadRow, error: threadErr } = await serviceClient
              .from("forum_threads")
              .select("created_by")
              .eq("id", postRow.thread_id)
              .maybeSingle<{ created_by: string }>();

            if (!threadErr && threadRow?.created_by) {
              // 2) Find the lead post: earliest non-deleted top-level post by thread owner
              const { data: leadRows, error: leadErr } = await serviceClient
                .from("forum_posts")
                .select("id")
                .eq("thread_id", postRow.thread_id)
                .eq("created_by", threadRow.created_by)
                .is("parent_post_id", null)
                .eq("is_deleted", false)
                .order("created_at", { ascending: true })
                .limit(1);

              if (!leadErr && Array.isArray(leadRows) && leadRows.length > 0) {
                const leadId = Number((leadRows[0] as { id: number }).id);
                isThreadPost = leadId === Number(postRow.id);
              }
            }
          }

          void createNotification({
            recipientUserId: postRow.created_by,
            actorUserId: user.id,
            type: "vote",
            threadId: postRow.thread_id,
            postId: postRow.id,
            payload: {
              milestone: upvotes,
              vote_value: 1,
              is_thread_post: isThreadPost,
            },
          });
        }
      }
    }

    return NextResponse.json(
      { ok: true, post: postRow, my_vote, myVote: my_vote },
      { status: 200 }
    );
  } catch (err) {
    console.error("Unexpected error in post vote route", err);
    return NextResponse.json(
      { error: "Unexpected error applying vote." },
      { status: 500 }
    );
  }
}
