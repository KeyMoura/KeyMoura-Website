"use client";

import { useCallback } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * Reusable loader for thread posts.
 *
 * NOTE:
 * - Assumes your forum_posts RLS now correctly returns *all* posts for admin/support,
 *   even if a member has blocked them.
 * - The UI can still hide content for non-staff using BlocksProvider.
 */
export type ThreadPostRow = {
  id: number;
  thread_id: number;
  parent_post_id: number | null;
  created_at: string;
  updated_at: string | null;
  created_by: string;
  body_markdown: string;
  is_deleted: boolean;
  edit_reason: string | null;
  vote_score?: number | null;
  upvote_count?: number | null;
  downvote_count?: number | null;
};

export function useThreadPostsLoader() {
  return useCallback(
    async (
      threadId: number
    ): Promise<{ posts: ThreadPostRow[]; error: unknown | null }> => {
      try {
        const supabase = supabaseBrowser();
        const { data: sessionData, error: sessionErr } = await supabase.auth.getSession();

        // Prefer the server route so staff can always see blocked users' content.
        // (The server applies block rules for non-staff.)
        const token = sessionData.session?.access_token ?? "";

        if (!token || sessionErr) {
          // Fallback for logged-out users (or if session is temporarily unavailable).
          const { data, error } = await supabase
            .from("forum_posts")
            .select(
              "id, thread_id, parent_post_id, created_at, updated_at, created_by, body_markdown, is_deleted, edit_reason, vote_score, upvote_count, downvote_count"
            )
            .eq("thread_id", Number(threadId))
            .order("created_at", { ascending: true });

          if (error) return { posts: [], error };
          return { posts: (data ?? []) as ThreadPostRow[], error: null };
        }

        const res = await fetch("/api/forum/thread-posts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ threadId }),
        });

        type ApiResp =
          | { ok: true; posts: ThreadPostRow[] }
          | { ok: false; error: string };

        const json = (await res.json().catch(() => null)) as ApiResp | null;
        if (!res.ok || !json) {
          return { posts: [], error: "Failed to load posts" };
        }

        if (!json.ok) {
          return { posts: [], error: json.error ?? "Failed to load posts" };
        }

        return { posts: Array.isArray(json.posts) ? json.posts : [], error: null };
      } catch (e) {
        return { posts: [], error: e };
      }
    },
    []
  );
}
