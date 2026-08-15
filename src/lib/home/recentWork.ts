import "server-only";

import { supabasePublicServer } from "@/lib/supabasePublicServer";

/**
 * The write-ups behind the homepage's "Made recently" row.
 *
 * ## Why this reads as the public, and why that is the whole safety argument
 *
 * `info_pages` holds both published build write-ups and pages still in review,
 * and the table's RLS policy is the thing that separates them:
 *
 *     status in ('approved', 'published') or created_by = auth.uid()
 *
 * Reading through the anon client means that policy runs. A draft cannot reach
 * the homepage even if the filter below were deleted, because there is no
 * session for the `created_by` half of the policy to match. The service-role
 * client — which the old homepage used — has `BYPASSRLS`, so there the filter
 * *was* the only guard, and a typo in it would have published someone's
 * unfinished page to the front door.
 *
 * The status filter is still written explicitly. Defence in depth, and it also
 * documents the intent at the call site.
 *
 * ## Approved *and* published
 *
 * The old homepage asked only for `approved`. Both values are public — the
 * policy says so — so a page promoted from approved to published silently
 * dropped off the homepage while remaining live at its own URL and in the
 * gallery. Matching the policy's own list is what keeps the homepage and
 * `/projects` from disagreeing about what exists.
 *
 * ## Nothing here identifies a person
 *
 * Title, slug, category, and when it last changed. No author, no `created_by`,
 * no counts, no discussion metadata: the homepage is not a forum index, and a
 * public write-up's author is the author's business to publish, not the front
 * page's.
 */

export type RecentWorkItem = {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  updated_at: string | null;
};

/** Statuses the table's own read policy treats as public. */
export const PUBLIC_WORK_STATUSES = ["approved", "published"] as const;

export async function loadRecentWork(limit = 3): Promise<RecentWorkItem[]> {
  try {
    const { data, error } = await supabasePublicServer()
      .from("info_pages")
      .select("id,title,slug,category,updated_at")
      .in("status", PUBLIC_WORK_STATUSES as unknown as string[])
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) return [];
    return (data ?? []) as RecentWorkItem[];
  } catch {
    return [];
  }
}
