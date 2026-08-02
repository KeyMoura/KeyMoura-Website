"use client";

import Link from "next/link";
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useSiteSettings } from "@/components/SiteSettingsProvider";
import { EmptyState } from "@/components/ui/DesignSystem";

type NotificationRow = {
  id: number;
  user_id: string;
  type: string;
  actor_user_id: string | null;
  thread_id: number | null;
  post_id: number | null;
  payload: unknown | null;
  is_read: boolean | null;
  created_at: string;
  read_at: string | null;
};

const SERVER_AVATAR_URL = "/favicon.ico";

type ActorProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function parsePayload(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }
  return {};
}

function notifTitle(n: NotificationRow): string {
  const t = (n.type ?? "").toLowerCase();

  if (t === "reply") return "New reply";
  if (t === "mention") return "Mentioned you";
  if (t === "accepted" || t === "accepted_answer") {
    return "Accepted your answer";
  }

  if (t === "broadcast") {
    const p = (n.payload && typeof n.payload === "object" && !Array.isArray(n.payload)
      ? (n.payload as Record<string, unknown>)
      : null);
    const title = typeof p?.title === "string" ? p.title : "";
    return title || "Announcement";
  }

  if (t === "admin_approval") {
    return "Admin approval requested";
  }

  if (t === "report_update") {
    const p = parsePayload(n.payload);
    const title = safeString(p["title"]);
    // Show a human-friendly fallback instead of the raw notification type.
    return title || "Report Update";
  }

  if (t === "moderation") {
    const p = parsePayload(n.payload);
    const title = safeString(p["title"]);
    return title || "Moderation Update";
  }

  if (t === "vote") {
    // Safely narrow payload (your NotificationRow.payload is typed as {})
    const payload = n.payload as {
      milestone?: number;
      is_thread_post?: boolean;
    } | null;

    const milestone = payload?.milestone;

    if (typeof milestone === "number" && milestone > 0) {
      const isThreadPost = payload?.is_thread_post === true;
      return isThreadPost
        ? `Your post hit ${milestone} upvotes`
        : `Your comment hit ${milestone} upvotes`;
    }

    // Fallback (should not happen anymore)
    return "New vote";
  }

  if (t === "garage_like") {
    const payload = n.payload as { milestone?: number } | null;
    const milestone = payload?.milestone;
    if (typeof milestone === "number" && milestone > 0) {
      return `Your build hit ${milestone} likes`;
    }
    return "New like";
  }

  // Universal fallback: prefer payload.title if present, otherwise prettify the type.
  const p = parsePayload(n.payload);
  const payloadTitle = safeString(p["title"]);
  if (payloadTitle) return payloadTitle;

  const raw = (n.type ?? "").trim();
  if (!raw) return "Notification";
  return raw
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function notifSubtitle(n: NotificationRow): string {
  const p = parsePayload(n.payload);
  const t = (n.type ?? "").toLowerCase();
  if (t === "admin_approval") {
    const actionType = safeString(p["actionType"]);
    return actionType ? `Action: ${actionType}` : "Open approvals to review";
  }
  if (t === "report_update") {
    return safeString(p["message"]) || safeString(p["preview"]) || "";
  }
  if (t === "moderation") {
    return safeString(p["message"]) || safeString(p["preview"]) || "";
  }
  return safeString(p["message"]) || safeString(p["preview"]) || safeString(p["text"]) || "";
}

function payloadThreadBase(n: NotificationRow): { base: string; postId: number | null } | null {
  const p = parsePayload(n.payload);
  const category = safeString(p["category_slug"]);
  const thread = safeString(p["thread_slug"]);
  const postIdFromPayload =
    typeof p["post_id"] === "number" ? (p["post_id"] as number) : null;

  const postId = postIdFromPayload ?? (typeof n.post_id === "number" ? n.post_id : null);

  if (category && thread) {
    const base = `/community/${encodeURIComponent(category)}/${encodeURIComponent(thread)}`;
    return { base, postId };
  }
  return null;
}

function formatTimeAgo(iso: string): string {
  try {
    const t = new Date(iso).getTime();
    const now = Date.now();
    const s = Math.max(1, Math.floor((now - t) / 1000));
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return `${d}d ago`;
  } catch {
    return "";
  }
}

export default function NotificationsPage() {
  const siteSettings = useSiteSettings();
  const [userId, setUserId] = useState<string | null>(null);

  const [items, setItems] = useState<NotificationRow[]>([]);
  const itemsRef = useRef<NotificationRow[]>([]);
  const [actorMap, setActorMap] = useState<Map<string, ActorProfile>>(() => new Map());

  const [threadHrefMap, setThreadHrefMap] = useState<Map<number, string>>(() => new Map());

  const [loading, setLoading] = useState(true);
  const [limit, setLimit] = useState(20);
  const [showUnreadOnly, setShowUnreadOnly] = useState(false);
  const restoreScrollYRef = useRef<number | null>(null);

  const [unreadCount, setUnreadCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const loadUnreadCount = async (uid: string) => {
    try {
      const supabase = supabaseBrowser();
      const { count, error } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", uid)
        .eq("is_read", false);

      if (error) {
        console.error("notif count failed", error);
        setUnreadCount(0);
      } else {
        setUnreadCount(count ?? 0);
      }
    } catch (e) {
      console.error("notif count unexpected", e);
      setUnreadCount(0);
    }
  };

  const resolveThreadHrefs = async (rows: NotificationRow[]) => {
    const supabase = supabaseBrowser();

    const needIds = Array.from(
      new Set(
        rows
          .filter((r) => r.thread_id != null)
          .filter((r) => payloadThreadBase(r) == null)
          .map((r) => r.thread_id as number)
      )
    );
    if (needIds.length === 0) return;

    const { data, error } = await supabase
      .from("forum_threads")
      .select("id, slug, forum_categories!inner(slug)")
      .in("id", needIds);

    if (error) {
      console.error("thread slug resolve failed", error);
      return;
    }

    type ThreadJoinRow = {
      id: number;
      slug: string;
      forum_categories: { slug: string };
    };
    const rowsJoin = (data ?? []) as unknown as ThreadJoinRow[];

    setThreadHrefMap((prev) => {
      const next = new Map(prev);
      for (const t of rowsJoin) {
        const catSlug = String(t.forum_categories?.slug ?? "");
        const thrSlug = String(t.slug ?? "");
        if (catSlug && thrSlug) {
          next.set(
            Number(t.id),
            `/community/${encodeURIComponent(catSlug)}/${encodeURIComponent(thrSlug)}`
          );
        }
      }
      return next;
    });
  };

  const load = async (take: number, unreadOnly: boolean) => {
    const isInitial = itemsRef.current.length === 0;
    // Avoid blanking the list while paginating; that "jump" is what makes it feel like it scrolls to top.
    setLoading(isInitial);
    try {
      const supabase = supabaseBrowser();

      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? null;
      setUserId(uid);

      if (!uid) {
        if (isInitial) {
          setItems([]);
          setActorMap(new Map());
          setThreadHrefMap(new Map());
          setUnreadCount(0);
          setHasMore(false);
        }
        setLoading(false);
        return;
      }

      // keep count fresh
      void loadUnreadCount(uid);

      let q = supabase
        .from("notifications")
        .select(
          "id,user_id,type,actor_user_id,thread_id,post_id,payload,is_read,created_at,read_at"
        )
        .eq("user_id", uid)
        .order("created_at", { ascending: false })
        .limit(take + 1); // ✅ detect "hasMore"

      if (unreadOnly) q = q.eq("is_read", false);

      const { data, error } = await q;
      if (error) {
        console.error("notifications load failed", error);
        if (isInitial) {
          setItems([]);
          setActorMap(new Map());
          setThreadHrefMap(new Map());
          setHasMore(false);
        }
        setLoading(false);
        return;
      }

      const raw = (data ?? []) as NotificationRow[];
      const more = raw.length > take;
      const rows = more ? raw.slice(0, take) : raw;

      setHasMore(more);
      setItems(rows);

      await resolveThreadHrefs(rows);

      const actorIds = Array.from(
        new Set(rows.map((r) => r.actor_user_id).filter((x): x is string => !!x))
      );

      if (actorIds.length) {
        const { data: actors, error: aErr } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .in("id", actorIds);

        if (!aErr) {
          const map = new Map<string, ActorProfile>();
          for (const a of (actors ?? []) as ActorProfile[]) map.set(String(a.id), a);
          setActorMap(map);
        } else {
          setActorMap(new Map());
        }
      } else {
        setActorMap(new Map());
      }
    } catch (e) {
      console.error("notifications load unexpected", e);
      if (itemsRef.current.length === 0) {
        setItems([]);
        setActorMap(new Map());
        setThreadHrefMap(new Map());
        setHasMore(false);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load(limit, showUnreadOnly);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, showUnreadOnly]);

  useEffect(() => {
    const y = restoreScrollYRef.current;
    if (y == null) return;
    restoreScrollYRef.current = null;
    requestAnimationFrame(() => {
      window.scrollTo({ top: y, behavior: "auto" });
    });
  }, [items.length]);

  const markOneRead = async (id: number) => {
    if (!userId) return;
    try {
      const supabase = supabaseBrowser();
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true, read_at: nowIso })
        .eq("user_id", userId)
        .eq("id", id);

      if (error) {
        console.error("mark read failed", error);
        return;
      }

      setItems((prev) =>
        prev.map((n) => (n.id === id ? { ...n, is_read: true, read_at: nowIso } : n))
      );

      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (e) {
      console.error("mark read unexpected", e);
    }
  };

  const markAllRead = async () => {
    if (!userId) return;
    try {
      const supabase = supabaseBrowser();
      const nowIso = new Date().toISOString();
      const { error } = await supabase
        .from("notifications")
        .update({ is_read: true, read_at: nowIso })
        .eq("user_id", userId)
        .eq("is_read", false);

      if (error) {
        console.error("mark all read failed", error);
        return;
      }

      setItems((prev) => prev.map((n) => ({ ...n, is_read: true, read_at: nowIso })));
      setUnreadCount(0);
    } catch (e) {
      console.error("mark all read unexpected", e);
    }
  };

  const visible = useMemo(() => items, [items]);

  return (
    <main className="page-container page-stack">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[18px] font-semibold text-brand-text">Notifications</h1>
          <p className="mt-1 text-[12px] text-brand-textMuted">
            Order updates, messages, and activity across KeyMoura.
          </p>
        </div>

        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:items-center">
          <button
            type="button"
            onClick={() => setShowUnreadOnly((v) => !v)}
            className="ui-btn ui-btn-secondary min-h-11 text-[12px]"
            aria-pressed={showUnreadOnly}
          >
            {showUnreadOnly ? "Showing unread" : "Showing all"}
          </button>

          {/* ✅ only show when unread exists */}
          {unreadCount > 0 && (
            <button
              type="button"
              onClick={markAllRead}
              className="ui-btn ui-btn-ghost min-h-11 text-[12px]"
              disabled={!userId}
            >
              Mark all read
            </button>
          )}
        </div>
      </div>

      {!userId && !loading && (
        <EmptyState>
          You’re not logged in.{" "}
          <Link
            href="/auth/login"
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
          >
            Log in
          </Link>{" "}
          to view notifications.
        </EmptyState>
      )}

      {loading && (
        <EmptyState>Loading…</EmptyState>
      )}

      {!loading && userId && visible.length === 0 && (
        <EmptyState>No notifications yet.</EmptyState>
      )}

      {!loading && userId && visible.length > 0 && (
        <div className="ui-card overflow-hidden !p-0">
          {visible.map((n) => {
            const isRead = !!n.is_read;
            const actor = n.actor_user_id ? actorMap.get(n.actor_user_id) : null;
            const parsedPayload = parsePayload(n.payload);
            const payloadHref = typeof parsedPayload["href"] === "string" ? parsedPayload["href"] : "";
            const isCustomerOrderUpdate = n.type === "order" && !payloadHref.startsWith("/staff/");
            const isSystem = !n.actor_user_id || isCustomerOrderUpdate;
            const actorName = isSystem
              ? siteSettings.shortName
              : actor?.display_name || actor?.username || "Someone";
            const title = notifTitle(n);
            const sub = notifSubtitle(n);

            const fromPayload = payloadThreadBase(n);
            const mappedBase =
              n.thread_id != null ? threadHrefMap.get(n.thread_id) ?? null : null;

            const postId =
              fromPayload?.postId ?? (typeof n.post_id === "number" ? n.post_id : null);

            const base = fromPayload?.base ?? mappedBase ?? "/notifications";
            const href =
              payloadHref ||
              (postId && base.startsWith("/community/") ? `${base}#post-${postId}` : base);

            return (
              <div
                key={n.id}
                className={[
                  "flex items-start gap-3 border-b border-zinc-900 px-4 py-3",
                  isRead ? "" : "bg-brand-primary/5",
                ].join(" ")}
              >
                <div className="mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                  {isSystem ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={SERVER_AVATAR_URL}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : actor?.avatar_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={actor.avatar_url} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-[11px] text-zinc-500">
                      {actorName[0]?.toUpperCase()}
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Link
                      href={href}
                      className="min-w-0 truncate text-[13px] font-semibold text-brand-text hover:text-amber-200"
                      onClick={() => {
                        if (!isRead) void markOneRead(n.id);
                      }}
                    >
                      {actorName} • {title}
                    </Link>
                    <div className="text-[11px] text-zinc-500">{formatTimeAgo(n.created_at)}</div>
                  </div>

                  {sub ? (
                    <div className="mt-1 line-clamp-2 text-[12px] text-brand-textMuted">
                      {sub}
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })}

          <div className="flex items-center justify-between gap-2 px-4 py-3">
            <div className="text-[11px] text-zinc-500">Showing {visible.length}</div>

            {/* ✅ only show if more exists */}
            {hasMore && (
              <button
                type="button"
                onClick={() => {
                  restoreScrollYRef.current = window.scrollY;
                  setLimit((v) => Math.min(v + 20, 200));
                }}
                className="ui-btn ui-btn-secondary text-[12px]"
              >
                Load more
              </button>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
