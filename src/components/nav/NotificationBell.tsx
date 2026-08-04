"use client";

import Link from "next/link";
import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { badgeCount } from "@/lib/navBadge";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faBell, faBellSlash } from "@fortawesome/free-solid-svg-icons";

/**
 * The customer notification bell.
 *
 * Lifted out of `SiteHeader` with its behaviour unchanged. It kept its place on
 * the bar when the message bell moved into the account menu, because an order
 * notification is transactional — "your quote is ready", "your order shipped" —
 * and belongs beside the cart. Messages are correspondence, and correspondence
 * can live one level down.
 *
 * The payloads still describe forum events (replies, mentions, accepted
 * answers) as well as order events, because both write to the same table.
 * Nothing about that changed here.
 */

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

type ActorProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

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
    const p = parsePayload(n.payload);
    const title = safeString(p["title"]);
    return title || "Announcement";
  }

  if (t === "admin_approval") {
    return "Admin approval requested";
  }

  if (t === "report_update") {
    const p = parsePayload(n.payload);
    const title = safeString(p["title"]);
    return title || "Report update";
  }

  if (t === "moderation") {
    const p = parsePayload(n.payload);
    const title = safeString(p["title"]);
    return title || "Moderation update";
  }

  if (t === "vote") {
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

  return (
    safeString(p["message"]) ||
    safeString(p["preview"]) ||
    safeString(p["text"]) ||
    ""
  );
}

function payloadThreadBase(
  n: NotificationRow
): { base: string; postId: number | null } | null {
  const p = parsePayload(n.payload);
  const category = safeString(p["category_slug"]);
  const thread = safeString(p["thread_slug"]);
  const postIdFromPayload =
    typeof p["post_id"] === "number" ? (p["post_id"] as number) : null;

  const postId =
    postIdFromPayload ?? (typeof n.post_id === "number" ? n.post_id : null);

  if (category && thread) {
    const base = `/community/${encodeURIComponent(category)}/${encodeURIComponent(
      thread
    )}`;
    return { base, postId };
  }
  return null;
}

function useOutsideClick(
  ref: React.RefObject<HTMLElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const el = ref.current;
      if (!el) return;
      if (e.target instanceof Node && !el.contains(e.target)) onClose();
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [ref, onClose]);
}

export default function NotificationBell({
  userId,
  desktopPillBase,
}: {
  userId: string;
  desktopPillBase: string;
}) {
  const pathname = usePathname();
  const isNotificationsRoute = pathname.startsWith("/notifications");
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [actorMap, setActorMap] = useState<Map<string, ActorProfile>>(
    () => new Map()
  );

  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(false);
  const [loadingCount, setLoadingCount] = useState(false);

  const [hasMore, setHasMore] = useState(false);
  const [threadHrefMap, setThreadHrefMap] = useState<Map<number, string>>(
    () => new Map()
  );

  // ✅ cache: only load list once until user manually refreshes
  const didLoadOnceRef = useRef(false);

  useOutsideClick(popRef, () => setOpen(false));

  const bellClass = `${desktopPillBase} justify-center w-9 px-0 site-nav-utility${
    isNotificationsRoute || unreadCount > 0 ? " is-highlighted" : ""
  }`;

  const loadUnreadCount = async () => {
    setLoadingCount(true);
    try {
      const supabase = supabaseBrowser();
      const { count, error } = await supabase
        .from("notifications")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
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
    } finally {
      setLoadingCount(false);
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
            `/community/${encodeURIComponent(catSlug)}/${encodeURIComponent(
              thrSlug
            )}`
          );
        }
      }
      return next;
    });
  };

  const loadItems = async (take: number) => {
    setLoading(true);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase
        .from("notifications")
        .select(
          "id,user_id,type,actor_user_id,thread_id,post_id,payload,is_read,created_at,read_at"
        )
        .eq("user_id", userId)
        .order("created_at", { ascending: false })
        .limit(take + 1);

      if (error) {
        console.error("notif list failed", error);
        setItems([]);
        setActorMap(new Map());
        setHasMore(false);
        return;
      }

      const raw = (data ?? []) as NotificationRow[];
      const more = raw.length > take;
      const rows = more ? raw.slice(0, take) : raw;

      setHasMore(more);
      setItems(rows);

      await resolveThreadHrefs(rows);

      const actorIds = Array.from(
        new Set(
          rows.map((r) => r.actor_user_id).filter((x): x is string => !!x)
        )
      );

      if (actorIds.length) {
        const { data: actors, error: aErr } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url")
          .in("id", actorIds);

        if (!aErr) {
          const map = new Map<string, ActorProfile>();
          for (const a of (actors ?? []) as ActorProfile[])
            map.set(String(a.id), a);
          setActorMap(map);
        } else {
          setActorMap(new Map());
        }
      } else {
        setActorMap(new Map());
      }
    } catch (e) {
      console.error("notif list unexpected", e);
      setItems([]);
      setActorMap(new Map());
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!userId) return;
    void loadUnreadCount();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const onToggle = async () => {
    const next = !open;
    setOpen(next);

    if (!next) return;

    // always refresh count when opening
    await loadUnreadCount();

    // only load list once until manual refresh
    if (!didLoadOnceRef.current) {
      didLoadOnceRef.current = true;
      await loadItems(limit);
    }
  };

  const refreshNow = async () => {
    didLoadOnceRef.current = false;
    await loadUnreadCount();
    didLoadOnceRef.current = true;
    await loadItems(limit);
  };

  const markOneRead = async (id: number) => {
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
        prev.map((n) =>
          n.id === id ? { ...n, is_read: true, read_at: nowIso } : n
        )
      );
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch (e) {
      console.error("mark read unexpected", e);
    }
  };

  const markAllRead = async () => {
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

  const showMore = async () => {
    const prevScrollTop = listRef.current?.scrollTop ?? 0;
    const next = Math.min(limit + 5, 50);
    setLimit(next);
    // this is a manual action => allow refresh even if cached
    didLoadOnceRef.current = true;
    await loadItems(next);
    requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = prevScrollTop;
    });
  };

  const badgeText = badgeCount(unreadCount);

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        className={bellClass}
        onClick={onToggle}
        // The real count, not the capped bubble text.
        aria-label={unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications"}
      >
        <FontAwesomeIcon
          icon={unreadCount > 0 ? faBell : faBellSlash}
          className="text-[14px]"
        />
        {unreadCount > 0 && (
          <span className="site-nav-utility-badge site-nav-badge" aria-hidden="true">
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div className="nav-menu-panel fixed left-2 right-2 mt-2 w-auto overflow-hidden rounded-2xl border shadow-2xl md:absolute md:right-0 md:left-auto md:mt-2 md:w-[360px]">
          <div className="nav-menu-section flex items-center justify-between gap-2 border-b px-3 py-2">
            <div className="text-[12px] font-semibold text-brand-text">
              Notifications
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshNow()}
                className="nav-menu-chip"
                title="Refresh"
              >
                Refresh
              </button>

              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="nav-menu-chip"
                  title="Mark all as read"
                >
                  Mark all read
                </button>
              )}

              <Link
                href="/notifications"
                className="nav-menu-chip"
                onClick={() => setOpen(false)}
              >
                View all
              </Link>
            </div>
          </div>

          <div ref={listRef} className="max-h-[420px] overflow-auto">
            {loading && (
              <div className="px-3 py-3 text-[11px] text-brand-textMuted">
                Loading…
              </div>
            )}

            {!loading && items.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-brand-textMuted">
                No notifications yet.
              </div>
            )}

            {!loading &&
              items.map((n) => {
                const isRead = !!n.is_read;
                const actor = n.actor_user_id ? actorMap.get(n.actor_user_id) : null;
                const actorName =
                  actor?.display_name ||
                  actor?.username ||
                  (n.actor_user_id ? "Someone" : "");
                const sub = notifSubtitle(n);

                const fromPayload = payloadThreadBase(n);
                const mappedBase =
                  n.thread_id != null ? threadHrefMap.get(n.thread_id) ?? null : null;

                const postId =
                  fromPayload?.postId ??
                  (typeof n.post_id === "number" ? n.post_id : null);

                const parsedPayload = parsePayload(n.payload);
                const payloadHref = safeString(parsedPayload["href"]);

                const base = fromPayload?.base ?? mappedBase ?? "/notifications";
                const href =
                  payloadHref ||
                  (postId && base.startsWith("/community/")
                    ? `${base}#post-${postId}`
                    : base);

                return (
                  <div
                    key={n.id}
                    className={[
                      "nav-menu-row group border-b px-3 py-2",
                      isRead ? "" : "is-unread",
                    ].join(" ")}
                  >
                    <Link
                      href={href}
                      className="nav-menu-rowlink block rounded-xl p-2 transition"
                      onClick={() => {
                        if (!isRead) void markOneRead(n.id);
                        setOpen(false);
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <div className="nav-menu-avatar mt-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-full border">
                          {actor?.avatar_url ? (
                            // Avatars come from arbitrary operator-configured
                            // hosts, which are not in the optimizer's
                            // allow-list; a 28px box is not worth a proxy.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={actor.avatar_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-500">
                              {actorName ? actorName[0]?.toUpperCase() : "•"}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="truncate text-[12px] font-semibold text-brand-text">
                              {actorName ? `${actorName} • ` : ""}
                              {notifTitle(n)}
                            </div>
                            <div className="shrink-0 text-[10px] text-zinc-500">
                              {formatTimeAgo(n.created_at)}
                            </div>
                          </div>

                          {sub ? (
                            <div className="mt-0.5 line-clamp-2 text-[11px] text-brand-textMuted">
                              {sub}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    </Link>

                    <div className="mt-1 flex items-center justify-end">
                      <button
                        type="button"
                        onClick={() => void markOneRead(n.id)}
                        disabled={isRead}
                        className="nav-menu-chip text-[10px] opacity-0 transition group-hover:opacity-100 disabled:opacity-30"
                      >
                        Mark read
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="nav-menu-section flex items-center justify-between gap-2 border-t px-3 py-2">
            <div className="text-[10px] text-zinc-500">
              {loadingCount
                ? "…"
                : unreadCount > 0
                  ? `${unreadCount} unread`
                  : "All caught up"}
            </div>

            {hasMore && (
              <button
                type="button"
                onClick={showMore}
                className="nav-menu-chip"
                disabled={loading}
                title="Show more"
              >
                Show more
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
