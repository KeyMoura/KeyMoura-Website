"use client";

import * as React from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { isRecord, isString } from "@/lib/typeGuards";

type BlocksContextValue = {
  viewerId: string | null;
  viewerRole: string | null;
  viewerIsStaff: boolean;
  blockedUserIds: Set<string>;
  blockedByUserIds: Set<string>;
  loading: boolean;
  refresh: () => Promise<void>;
  setBlockedLocal: (targetUserId: string, shouldBlock: boolean) => void;
};

const BlocksContext = React.createContext<BlocksContextValue | null>(null);

/**
 * Accessor for the blocks context.
 */
export function useBlocks(): BlocksContextValue {
  const ctx = React.useContext(BlocksContext);
  if (!ctx) {
    throw new Error("useBlocks must be used within <BlocksProvider />");
  }
  return ctx;
}

/**
 * Loads viewer blocks and a viewer role snapshot.
 */
export function BlocksProvider({ children }: { children: React.ReactNode }) {
  const [viewerId, setViewerId] = React.useState<string | null>(null);
  const [viewerRole, setViewerRole] = React.useState<string | null>(null);
  const [blockedUserIds, setBlockedUserIds] = React.useState<Set<string>>(() => new Set());
  const [blockedByUserIds, setBlockedByUserIds] = React.useState<Set<string>>(() => new Set());
  const [loading, setLoading] = React.useState(false);

  const viewerIsStaff = (() => {
    const r = (viewerRole ?? "").toLowerCase();
    return r === "admin" || r === "support" || r === "moderator" || r === "mod";
  })();

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const supabase = supabaseBrowser();
      const { data: sessionData } = await supabase.auth.getSession();
      const user = sessionData.session?.user ?? null;

      if (!user) {
        setViewerId(null);
        setViewerRole(null);
        setBlockedUserIds(new Set());
        setBlockedByUserIds(new Set());
        setLoading(false);
        return;
      }

      setViewerId(user.id);

      /**
       * Role snapshot is loaded through a server route to avoid RLS edge cases.
       */
      try {
        const token = sessionData.session?.access_token;
        if (token) {
          const res = await fetch("/api/me/role", {
            headers: { Authorization: `Bearer ${token}` },
          });
          const j = (await res.json().catch(() => null)) as unknown;
          if (res.ok && isRecord(j) && isString(j.role)) {
            setViewerRole(j.role.toLowerCase());
          } else {
            setViewerRole(null);
          }
        } else {
          setViewerRole(null);
        }
      } catch {
        setViewerRole(null);
      }

      /**
       * Staff must still be able to moderate everyone even if blocks exist,
       * but the UI should reflect the block/unblock state.
       */
      const { data: b1, error: b1Err } = await supabase
        .from("user_blocks")
        .select("blocked_user_id")
        .eq("blocker_user_id", user.id);
      if (b1Err) {
        console.error("BlocksProvider: failed to load blocked users", b1Err);
        setBlockedUserIds(new Set());
      } else {
        const next = new Set<string>();
        for (const row of (b1 ?? []) as unknown[]) {
          if (row && typeof row === "object" && (row as Record<string, unknown>).blocked_user_id) {
            next.add(String((row as Record<string, unknown>).blocked_user_id));
          }
        }
        setBlockedUserIds(next);
      }

      const { data: b2, error: b2Err } = await supabase
        .from("user_blocks")
        .select("blocker_user_id")
        .eq("blocked_user_id", user.id);

      if (b2Err) {
        console.error("BlocksProvider: failed to load blocked-by users", b2Err);
        setBlockedByUserIds(new Set());
      } else {
        const next = new Set<string>();
        for (const row of (b2 ?? []) as unknown[]) {
          if (row && typeof row === "object" && (row as Record<string, unknown>).blocker_user_id) {
            next.add(String((row as Record<string, unknown>).blocker_user_id));
          }
        }
        setBlockedByUserIds(next);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();

    const supabase = supabaseBrowser();
    const { data: sub } = supabase.auth.onAuthStateChange(() => {
      void load();
    });

    return () => {
      sub.subscription.unsubscribe();
    };
  }, [load]);

  const setBlockedLocal = React.useCallback((targetUserId: string, shouldBlock: boolean) => {
    if (!targetUserId) return;
    setBlockedUserIds((prev) => {
      const next = new Set(prev);
      if (shouldBlock) next.add(targetUserId);
      else next.delete(targetUserId);
      return next;
    });
  }, []);

  const value: BlocksContextValue = {
    viewerId,
    viewerRole,
    viewerIsStaff,
    blockedUserIds,
    blockedByUserIds,
    loading,
    refresh: load,
    setBlockedLocal,
  };

  return <BlocksContext.Provider value={value}>{children}</BlocksContext.Provider>;
}
