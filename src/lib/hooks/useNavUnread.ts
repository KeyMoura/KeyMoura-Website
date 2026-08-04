"use client";

import { useQuery } from "@tanstack/react-query";
import { supabaseBrowser } from "@/lib/supabaseClient";

export type NavUnread = { messages: number; notifications: number };

const EMPTY: NavUnread = { messages: 0, notifications: 0 };

/**
 * Unread counts for the navbar, without mounting a dropdown to get them.
 *
 * The header used to learn its unread counts as a side effect of rendering the
 * message and notification popovers: the count lived in each popover's own
 * state, so the only way to display "you have unread messages" anywhere was to
 * render the whole inbox panel beside it. That is why both bells sat on the bar.
 *
 * Moving Messages into the account menu needed the count to be available
 * independently, so it is fetched here — two cheap queries, both `head: true`
 * or an RPC that counts server-side, with no row bodies crossing the wire.
 *
 * Failure is silent and reads as zero. An unread badge is an ornament on a
 * storefront header; a red error where a number should be is worse than no
 * number, and the destinations it annotates are reachable either way.
 */
export function useNavUnread(userId: string | null) {
  return useQuery({
    queryKey: ["navUnread", userId],
    enabled: Boolean(userId),
    staleTime: 60_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
    queryFn: async (): Promise<NavUnread> => {
      if (!userId) return EMPTY;
      const supabase = supabaseBrowser();

      const [messages, notifications] = await Promise.all([
        supabase.rpc("dm_unread_thread_count"),
        supabase
          .from("notifications")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("is_read", false),
      ]);

      return {
        messages: !messages.error && typeof messages.data === "number" ? messages.data : 0,
        notifications: notifications.error ? 0 : notifications.count ?? 0,
      };
    },
  });
}
