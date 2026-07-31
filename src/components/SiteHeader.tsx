"use client";

import Link from "next/link";
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { useSiteSettings } from "@/components/SiteSettingsProvider";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBell,
  faBellSlash,
  faEnvelope,
  faEnvelopeOpen,
  faScrewdriverWrench,
  faChessRook,
  faBook,
  faMagnifyingGlass,
} from "@fortawesome/free-solid-svg-icons";

type SimpleUser = {
  id: string;
  email: string | null;
};

type SimpleProfile = {
  username: string | null;
  display_name: string | null;
  avatar_url?: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

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

type DmInboxRow = {
  thread_id: string;
  other_user_id: string;
  other_username: string | null;
  other_display_name: string | null;
  other_avatar_url: string | null;
  other_is_verified?: boolean | null;
  other_donation_rank?: string | null;
  other_role?: string | null;
  last_message_body: string | null;
  last_message_at: string | null;
  unread_count: number | null;
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

function formatRank(role: string | null | undefined): string {
  const r = (role ?? "member").toLowerCase();
  if (r === "admin") return "Admin";
  if (r === "support") return "Support";
  if (r === "staff") return "Staff";
  return "Member";
}

function rankChipClasses(role: string | null | undefined): string {
  const r = (role ?? "member").toLowerCase();
  if (r === "admin") return "border-rose-400/40 bg-rose-500/10 text-rose-200";
  if (r === "support") return "border-sky-400/40 bg-sky-500/10 text-sky-200";
  if (r === "staff") return "border-amber-400/40 bg-amber-500/10 text-amber-200";
  return "border-zinc-700 bg-black/40 text-brand-textMuted";
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

function NotificationBell({
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

  const bellClass = `${desktopPillBase} justify-center w-9 px-0 ${
    isNotificationsRoute
      ? "border-white/70 bg-white/10 text-white ring-1 ring-white/30"
      : unreadCount > 0
        ? "border-amber-400/80 bg-black/55 text-amber-200 shadow-[0_0_14px_rgba(251,191,36,0.20)]"
        : "border-zinc-700 bg-black/40 text-white hover:border-zinc-500"
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

  const badgeText = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        className={bellClass}
        onClick={onToggle}
        aria-label="Notifications"
      >
        <FontAwesomeIcon
          icon={unreadCount > 0 ? faBell : faBellSlash}
          className={`text-[14px] ${
            unreadCount > 0 ? "text-amber-300" : "text-brand-text"
          }`}
        />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full border border-amber-400/80 bg-amber-400 px-1 text-[10px] font-bold text-black">
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed left-2 right-2 mt-2 w-auto overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl backdrop-blur md:absolute md:right-0 md:left-auto md:mt-2 md:w-[360px]">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
            <div className="text-[12px] font-semibold text-brand-text">
              Notifications
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshNow()}
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
                title="Refresh"
              >
                Refresh
              </button>

              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={markAllRead}
                  className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
                  title="Mark all as read"
                >
                  Mark all read
                </button>
              )}

              <Link
                href="/notifications"
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
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
                      "group border-b border-zinc-900 px-3 py-2",
                      isRead ? "bg-transparent" : "bg-amber-500/5",
                    ].join(" ")}
                  >
                    <Link
                      href={href}
                      className="block rounded-xl p-2 transition hover:bg-white/5"
                      onClick={() => {
                        if (!isRead) void markOneRead(n.id);
                        setOpen(false);
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {actor?.avatar_url ? (
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
                        className="rounded-full border border-zinc-800 bg-black/30 px-3 py-1 text-[10px] text-brand-textMuted opacity-0 transition group-hover:opacity-100 hover:border-amber-400/60 hover:text-brand-text disabled:opacity-30"
                      >
                        Mark read
                      </button>
                    </div>
                  </div>
                );
              })}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-3 py-2">
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
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
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

function MessageBell({
  userId,
  desktopPillBase,
}: {
  userId: string;
  desktopPillBase: string;
}) {
  const pathname = usePathname();
  const isMessagesRoute = pathname.startsWith("/messages");
  const [open, setOpen] = useState(false);
  const popRef = useRef<HTMLDivElement | null>(null);

  const [unreadCount, setUnreadCount] = useState(0);
  const [items, setItems] = useState<DmInboxRow[]>([]);
  const [limit, setLimit] = useState(5);
  const [loading, setLoading] = useState(false);
  const [loadingCount, setLoadingCount] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [markingAllRead, setMarkingAllRead] = useState(false);

  // ✅ cache: only load list once until user manually refreshes
  const didLoadOnceRef = useRef(false);

  useOutsideClick(popRef, () => setOpen(false));

  const pillClass = `${desktopPillBase} justify-center w-9 px-0 ${
    isMessagesRoute
      ? "border-white/70 bg-white/10 text-white ring-1 ring-white/30"
      : unreadCount > 0
        ? "border-amber-400/80 bg-black/55 text-amber-200 shadow-[0_0_14px_rgba(251,191,36,0.20)]"
        : "border-zinc-700 bg-black/40 text-white hover:border-zinc-500"
  }`;

  const loadUnreadCount = async () => {
    setLoadingCount(true);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("dm_unread_thread_count");
      if (error) {
        console.error("dm unread count failed", error);
        setUnreadCount(0);
      } else {
        setUnreadCount(typeof data === "number" ? data : 0);
      }
    } catch (e: unknown) {
      console.error("dm unread count unexpected", e);
      setUnreadCount(0);
    } finally {
      setLoadingCount(false);
    }
  };

  const loadItems = async (take: number) => {
    setLoading(true);
    try {
      const supabase = supabaseBrowser();
      const { data, error } = await supabase.rpc("dm_list_threads", {
        p_limit: take + 1,
        p_offset: 0,
      });

      if (error) {
        console.error("dm inbox list failed", error);
        setItems([]);
        setHasMore(false);
        return;
      }

      const raw = (Array.isArray(data) ? data : []) as DmInboxRow[];
      const more = raw.length > take;
      const rows = more ? raw.slice(0, take) : raw;

      // Enrich with verified + role for the message preview list.
      const ids = Array.from(
        new Set(rows.map((r) => r.other_user_id).filter(Boolean))
      );

      const verifiedById: Record<string, boolean | null> = {};
      const donationRankById: Record<string, string | null> = {};
      const roleById: Record<string, string | null> = {};

      if (ids.length > 0) {
        const [{ data: profs }, { data: roles }] = await Promise.all([
          supabase
            .from("profiles")
            .select("id,is_verified,donation_rank")
            .in("id", ids),
          supabase
            .from("user_roles")
            .select("user_id,role")
            .in("user_id", ids),
        ]);

        (profs ?? []).forEach((p) => {
          const row = p as {
            id: string;
            is_verified?: boolean | null;
            donation_rank?: string | null;
          };
          verifiedById[row.id] = row.is_verified ?? null;
          donationRankById[row.id] = row.donation_rank ?? null;
        });

        (roles ?? []).forEach((r) => {
          const row = r as { user_id: string; role: string | null };
          roleById[row.user_id] = row.role ?? null;
        });
      }

      const enriched = rows.map((r) => ({
        ...r,
        other_is_verified: verifiedById[r.other_user_id] ?? null,
        other_donation_rank: donationRankById[r.other_user_id] ?? null,
        other_role: roleById[r.other_user_id] ?? null,
      }));

      setHasMore(more);
      setItems(enriched);
    } catch (e: unknown) {
      console.error("dm inbox list unexpected", e);
      setItems([]);
      setHasMore(false);
    } finally {
      setLoading(false);
    }
  };

  const markAllRead = async () => {
    if (markingAllRead) return;

    setMarkingAllRead(true);
    try {
      const supabase = supabaseBrowser();
      const { error } = await supabase.rpc("dm_mark_all_read");
      if (error) {
        console.error("dm_mark_all_read failed", error);
        return;
      }

      setUnreadCount(0);
      setItems((prev) => prev.map((t) => ({ ...t, unread_count: 0 })));
    } catch (e: unknown) {
      console.error("dm_mark_all_read unexpected", e);
    } finally {
      setMarkingAllRead(false);
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

  const showMore = async () => {
    const next = Math.min(limit + 5, 50);
    setLimit(next);
    didLoadOnceRef.current = true;
    await loadItems(next);
  };

  const optimisticMarkThreadRead = (threadId: string, unread: number) => {
    if (unread <= 0) return;

    setItems((prev) =>
      prev.map((t) =>
        t.thread_id === threadId ? { ...t, unread_count: 0 } : t
      )
    );
    setUnreadCount((c) => Math.max(0, c - unread));
  };

  const badgeText = unreadCount > 9 ? "9+" : String(unreadCount);

  return (
    <div className="relative" ref={popRef}>
      <button
        type="button"
        className={pillClass}
        onClick={onToggle}
        aria-label="Messages"
      >
        <FontAwesomeIcon
          icon={unreadCount > 0 ? faEnvelope : faEnvelopeOpen}
          className={`text-[14px] ${
            unreadCount > 0 ? "text-amber-300" : "text-brand-text"
          }`}
        />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-4 min-w-[16px] items-center justify-center rounded-full border border-amber-400/80 bg-amber-400 px-1 text-[10px] font-bold text-black">
            {badgeText}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed left-2 right-2 mt-2 w-auto overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950/95 shadow-2xl backdrop-blur md:absolute md:right-0 md:left-auto md:mt-2 md:w-[360px]">
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800 px-3 py-2">
            <div className="text-[12px] font-semibold text-brand-text">
              Messages
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refreshNow()}
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
                title="Refresh"
              >
                Refresh
              </button>

              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={() => void markAllRead()}
                  disabled={markingAllRead}
                  className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
                  title="Mark all as read"
                >
                  {markingAllRead ? "Marking…" : "Mark all read"}
                </button>
              )}

              <Link
                href="/messages"
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
                onClick={() => setOpen(false)}
              >
                View all
              </Link>
            </div>
          </div>

          <div className="max-h-[420px] overflow-auto">
            {loading && (
              <div className="px-3 py-3 text-[11px] text-brand-textMuted">
                Loading…
              </div>
            )}

            {!loading && items.length === 0 && (
              <div className="px-3 py-6 text-center text-[11px] text-brand-textMuted">
                No messages yet.
              </div>
            )}

            {!loading &&
              items.map((it) => {
                const name = it.other_display_name || it.other_username || "User";
                const preview = (it.last_message_body ?? "").trim();
                const time = it.last_message_at ? formatTimeAgo(it.last_message_at) : "";
                const unread = Number(it.unread_count ?? 0);
                const href = `/messages/${encodeURIComponent(it.thread_id)}`;

                return (
                  <div
                    key={it.thread_id}
                    className={[
                      "group border-b border-zinc-900 px-3 py-2",
                      unread > 0 ? "bg-amber-500/5" : "bg-transparent",
                    ].join(" ")}
                  >
                    <Link
                      href={href}
                      className="block rounded-xl p-2 transition hover:bg-white/5"
                      onClick={() => {
                        if (unread > 0) optimisticMarkThreadRead(it.thread_id, unread);
                        setOpen(false);
                      }}
                    >
                      <div className="flex items-start gap-2">
                        <div className="mt-0.5 h-7 w-7 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {it.other_avatar_url ? (
                            <img
                              src={it.other_avatar_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[10px] text-zinc-500">
                              {name ? name[0]?.toUpperCase() : "•"}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex min-w-0 items-center gap-2">
                              <div className="truncate text-[12px] font-semibold text-brand-text">
                                {name}
                                {it.other_is_verified ? (
                                  <VerifiedBadge className="ml-0.5 h-3 w-3" />
                                ) : null}
                                {it.other_donation_rank ? (
                                  <DonationBadge
                                    rank={it.other_donation_rank}
                                    className="ml-0.5 h-3 w-3"
                                  />
                                ) : null}
                                {unread > 0 ? (
                                  <span className="ml-2 rounded-full border border-amber-400/70 bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-200">
                                    {unread}
                                  </span>
                                ) : null}
                              </div>

                              <RolePill role={it.other_role} />
                            </div>
                            <div className="shrink-0 text-[10px] text-zinc-500">
                              {time}
                            </div>
                          </div>

                          {preview ? (
                            <div className="mt-0.5 line-clamp-2 text-[11px] text-brand-textMuted">
                              {preview}
                            </div>
                          ) : (
                            <div className="mt-0.5 text-[11px] text-brand-textMuted">
                              (No message)
                            </div>
                          )}
                        </div>
                      </div>
                    </Link>
                  </div>
                );
              })}
          </div>

          <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-3 py-2">
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
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text"
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

export default function SiteHeader() {
  const pathname = usePathname();
  const siteSettings = useSiteSettings();

  const [user, setUser] = useState<SimpleUser | null>(null);
  const [isAdmin, setIsAdmin] = useState<boolean>(false);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [isMobileOpen, setIsMobileOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const [displayName, setDisplayName] = useState<string | null>(null);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [myIsVerified, setMyIsVerified] = useState<boolean>(false);
  const [myDonationRank, setMyDonationRank] = useState<string | null>(null);
  const [isVerified, setIsVerified] = useState<boolean>(false);
  const [donationRank, setDonationRank] = useState<string | null>(null);

  const loadUserState = async (
    authUser: { id: string; email?: string | null } | null
  ) => {
    const supabase = supabaseBrowser();

    if (!authUser) {
      setUser(null);
      setIsAdmin(false);
      setMyRole(null);
      setDisplayName(null);
      setAvatarUrl(null);
      setMyIsVerified(false);
      setMyDonationRank(null);
      return;
    }

    setUser({ id: authUser.id, email: authUser.email ?? null });

    // Permission-based staff gate (no role checks)
    try {
      const res = await fetch("/api/me/access", { method: "GET" });
      const json = (await res.json().catch(() => null)) as { permissions?: string[] | null } | null;
      const perms = new Set(Array.isArray(json?.permissions) ? json!.permissions!.map(String) : []);
      const staffViewPerms = [
        "security.view",
        "community.view",
        "analytics.view",
        "audit.view",
        "shops.view",
        "info.pending.view",
        "info.updates.view",
      ];
      const canSeeStaff = staffViewPerms.some((p) => perms.has(p));
      setIsAdmin(canSeeStaff);
    } catch {
      setIsAdmin(false);
    }

    // Keep role value for display only (never for gating)
    const { data: roleRow } = await supabase.from("user_roles").select("role").eq("user_id", authUser.id).maybeSingle();
    setMyRole(roleRow?.role ?? null);

    try {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("username, display_name, avatar_url, is_verified, donation_rank")
        .eq("id", authUser.id)
        .maybeSingle<SimpleProfile>();

      if (!profileError && profile) {
        setDisplayName(profile.display_name || profile.username || null);
        setAvatarUrl(profile.avatar_url ?? null);
        setMyIsVerified(!!profile.is_verified);
        setMyDonationRank(profile.donation_rank ?? null);
      } else {
        setDisplayName(null);
        setAvatarUrl(null);
        setMyIsVerified(false);
        setMyDonationRank(null);
      }
    } catch (e) {
      console.error("Error loading profile for header", e);
    }
  };

  useEffect(() => {
    const supabase = supabaseBrowser();

    supabase.auth.getUser().then(({ data: { user } }) => {
      void loadUserState(user);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      void loadUserState(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    let lastY = typeof window !== "undefined" ? window.scrollY : 0;

    const onScroll = () => {
      const currentY = window.scrollY;
      const delta = currentY - lastY;

      if (Math.abs(delta) < 8) {
        lastY = currentY;
        return;
      }

      if (currentY > 80 && delta > 0) setHidden(true);
      else if (delta < 0) setHidden(false);

      lastY = currentY;
    };

    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname.startsWith(href);

  const isHome = pathname === "/";
  const isStaffRoute = pathname.startsWith("/staff");
  const isAccountRoute = pathname.startsWith("/account");

  const { data: meAccess } = useMeAccess();

  const staffRole = String((meAccess?.role ?? myRole ?? "")).toLowerCase();
  const isStaff = meAccess?.isStaff ?? ["admin", "moderator", "mod", "support"].includes(staffRole);

  const pillBase =
    "rounded-full px-3 py-1 text-[14px] font-medium tracking-wide transition-colors";
  const pillActive =
    "border border-brand-primary/70 bg-black/60 text-brand-primary shadow-[0_0_10px_rgba(126,230,255,0.25)]";
  const pillIdle =
    "border border-transparent text-brand-textMuted transition-all duration-150 ease-out hover:border-brand-primary/50 hover:bg-black/50 hover:text-brand-primary hover:shadow-[0_0_8px_rgba(126,230,255,0.18)] hover:-translate-y-[1px]";

  const navLinkClasses = (href: string) =>
    `${pillBase} ${isActive(href) ? pillActive : pillIdle}`;

  const avatarInitial = (displayName?.[0] || user?.email?.[0] || "U").toUpperCase();

  const handleToggleMobile = () => setIsMobileOpen((v) => !v);

  const handleOpenCommandPalette = () => {
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("open-command-palette"));
    }
  };

  const leftLinks = useMemo(
    () => [
      { href: "/info", label: "Info" },
      { href: "/community", label: "Community" },
    ],
    []
  );

  const rightLinks = useMemo(
    () => [
      { href: "/garage", label: "Garage" },
      { href: "/shops", label: "Shops" },
    ],
    []
  );

  const desktopPillBase =
    "inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-all duration-150 ease-out";

  const accountPillClass = `${desktopPillBase} ${
    isAccountRoute
      ? "border-brand-primary/80 bg-black/70 text-brand-primary shadow-[0_0_14px_rgba(126,230,255,0.35)]"
      : "border-zinc-700 bg-black/40 text-brand-text hover:border-brand-primary/70 hover:bg-black/70 hover:text-brand-primary hover:ring-1 hover:ring-brand-primary/30"
  }`;

  const hexToRgba = (hex: string, alpha: number) => {
    const h = hex.trim().replace(/^#/, "");
    if (!(h.length === 3 || h.length === 6)) return null;
    const full = h.length === 3 ? h.split("").map((c) => `${c}${c}`).join("") : h;
    const n = Number.parseInt(full, 16);
    if (!Number.isFinite(n)) return null;
    const r = (n >> 16) & 255;
    const g = (n >> 8) & 255;
    const b = n & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  };

  const getStaffPalette = () => {
    const db = meAccess?.roleStyle;
    const dbBorder = typeof db?.badge_border === "string" && db.badge_border.trim().length ? db.badge_border.trim() : null;
    const dbBg = typeof db?.badge_bg === "string" && db.badge_bg.trim().length ? db.badge_bg.trim() : null;
    const dbText = typeof db?.badge_text === "string" && db.badge_text.trim().length ? db.badge_text.trim() : null;

    if (dbBorder || dbBg || dbText) {
      return {
        border: dbBorder ?? "#fbbf24",
        bg: dbBg ?? "rgba(0,0,0,0.35)",
        text: dbText ?? "#ffffff",
      };
    }

    return { border: "#fbbf24", bg: "rgba(0,0,0,0.35)", text: "#ffffff" };
  };

  const staffPalette = getStaffPalette();

  const staffPillClass = `${desktopPillBase} justify-center hover:brightness-110`;

  const mobilePillBase =
    "inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[13px] font-medium transition-all duration-150 ease-out";

  const mobileAccountPillClass = `${mobilePillBase} border-zinc-700 bg-black/40 text-brand-text hover:border-brand-primary/70 hover:bg-black/70 hover:text-brand-primary`;
  const mobileStaffPillClass = `${mobilePillBase} hover:brightness-110`;

  const headerTheme = "border-b bg-black/55";

  const headerStyle = isStaffRoute
    ? {
        borderColor: hexToRgba(staffPalette.border, 0.35) ?? staffPalette.border,
        boxShadow: `0 10px 30px ${hexToRgba(staffPalette.border, 0.12) ?? "rgba(0,0,0,0.12)"}`,
      }
    : {
        borderColor: "rgba(251,191,36,0.25)",
        boxShadow: "0 10px 30px rgba(251,191,36,0.12)",
      };

  return (
    <header
      className={`sticky top-0 z-60 border-b backdrop-blur-md transition-transform duration-200 ${
        hidden ? "-translate-y-full" : "translate-y-0"
      } ${headerTheme}`}
      style={headerStyle}
    >
      <div className="mx-auto max-w-7xl px-4 xl:px-5">
        {/* DESKTOP */}
        <div
          className="hidden h-14 min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 lg:grid"
          data-testid="desktop-header"
        >
          <div className="flex min-w-0 items-center justify-start" data-testid="header-left-utilities">
            <button
              type="button"
              onClick={handleOpenCommandPalette}
              className={`${desktopPillBase} max-w-full justify-center border-zinc-700 bg-black/40 text-brand-text hover:border-brand-primary/60 hover:bg-black/55`}
              aria-label="Search site (Ctrl+K)"
            >
              <FontAwesomeIcon icon={faMagnifyingGlass} className="h-3.5 w-3.5 shrink-0" />
              <span className="hidden xl:inline">Search</span>
              <span className="hidden rounded bg-black/60 px-1 text-[9px] text-brand-textMuted 2xl:inline">
                Ctrl+K
              </span>
            </button>
          </div>

          <div className="flex items-center gap-3" data-testid="primary-navigation-group">
            <nav className="flex items-center gap-1" aria-label="Primary navigation">
              {leftLinks.map((l) => (
                <Link key={l.href} href={l.href} className={navLinkClasses(l.href)}>
                  {l.label}
                </Link>
              ))}
            </nav>

            <Link
              href="/"
              aria-label="Home"
              className={`inline-flex shrink-0 items-center transition-transform duration-200 ease-out ${
                isHome ? "" : "hover:scale-[1.06]"
              }`}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={siteSettings.logoUrl}
                alt={siteSettings.name}
                width={44}
                height={44}
                className="object-contain drop-shadow-[0_8px_14px_rgba(0,0,0,0.55)]"
              />
            </Link>

            <nav className="flex items-center gap-1" aria-label="Primary navigation continued">
              {rightLinks.map((l) => (
                <Link key={l.href} href={l.href} className={navLinkClasses(l.href)}>
                  {l.label}
                </Link>
              ))}
            </nav>
          </div>

          {/* Right utilities */}
          <div className="flex min-w-0 items-center justify-end gap-2 xl:gap-3" data-testid="header-utilities">
            {user ? (
              <>
                <MessageBell userId={user.id} desktopPillBase={desktopPillBase} />
                <NotificationBell userId={user.id} desktopPillBase={desktopPillBase} />

                <Link
                  href="/account"
                  className={accountPillClass}
                  title={displayName || user?.email || "Account"}
                >
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarUrl}
                      alt={displayName || user.email || "User avatar"}
                      className="h-7 w-7 rounded-full border border-zinc-700 object-cover"
                    />
                  ) : (
                    <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-primary/20 text-[10px] font-semibold text-brand-primary">
                      {avatarInitial}
                    </span>
                  )}
                  <span className="hidden max-w-[110px] truncate xl:inline 2xl:max-w-[140px]">
                    {displayName || user?.email?.split("@")[0] || "Account"}
                    {myIsVerified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                    {myDonationRank ? (
                      <DonationBadge rank={myDonationRank} className="ml-0.5 h-3 w-3" />
                    ) : null}
                  </span>
                </Link>

                {isStaff && (
                  <Link
                    href="/staff"
                    className={staffPillClass}
                    title="Staff"
                    style={{
                      borderColor: hexToRgba(staffPalette.border, 0.6) ?? staffPalette.border,
                      backgroundColor: staffPalette.bg,
                      color: staffPalette.text,
                      boxShadow: isStaffRoute
                        ? `0 0 14px ${hexToRgba(staffPalette.border, 0.22) ?? "rgba(0,0,0,0.18)"}`
                        : undefined,
                    }}
                  >
                    <FontAwesomeIcon
                      icon={faScrewdriverWrench}
                      className="h-3.5 w-3.5"
                    />
                    <span className="hidden xl:inline">Staff</span>
                  </Link>
                )}
              </>
            ) : (
              <Link
                href="/auth/login"
                className="rounded-full border border-amber-300 bg-amber-400 px-3 py-1 text-[11px] font-semibold text-black shadow-[0_0_14px_rgba(251,191,36,0.45)] transition-all duration-150 ease-out hover:bg-amber-300 hover:border-amber-200"
              >
                Log in
              </Link>
            )}
          </div>
        </div>

        {/* MOBILE */}
        <div className="flex h-14 items-center justify-between lg:hidden">
          <Link
            href="/"
            aria-label="Home"
            className={`inline-flex items-center transition-transform duration-200 ease-out ${
              isHome ? "" : "hover:scale-[1.06]"
            }`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={siteSettings.logoUrl}
              alt={siteSettings.name}
              width={36}
              height={36}
              className="object-contain drop-shadow-[0_8px_14px_rgba(0,0,0,0.55)]"
            />
          </Link>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleOpenCommandPalette}
              className="inline-flex h-9 items-center justify-center rounded-md border border-zinc-700 bg-black/40 px-2 text-[11px] text-brand-text transition-all duration-150 ease-out hover:border-brand-primary/60"
              aria-label="Search site (Ctrl+K)"
            >
              🔍
            </button>

            {user ? (
              <>
                <MessageBell
                  userId={user.id}
                  desktopPillBase="inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-all duration-150 ease-out"
                />
                <NotificationBell
                  userId={user.id}
                  desktopPillBase="inline-flex h-9 items-center gap-2 rounded-full border px-3 text-[12px] font-medium transition-all duration-150 ease-out"
                />

                <Link href="/account" aria-label="Account">
                  {avatarUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={avatarUrl}
                      alt={displayName || user.email || "User avatar"}
                      className="h-8 w-8 rounded-full border border-zinc-700 object-cover"
                    />
                  ) : (
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-primary/20 text-[11px] font-semibold text-brand-primary">
                      {avatarInitial}
                    </div>
                  )}
                </Link>
              </>
            ) : null}

            <button
              type="button"
              onClick={handleToggleMobile}
              className="inline-flex h-9 w-9 items-center justify-center rounded-md border border-zinc-700 bg-black/40 text-xs text-brand-text transition-all duration-150 ease-out hover:border-brand-primary/60"
              aria-label="Toggle menu"
            >
              {isMobileOpen ? "✕" : "☰"}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile nav */}
      <div
        className={`overflow-hidden border-t border-zinc-800/80 bg-black/80 px-4 text-xs transition-[max-height,opacity,padding] duration-200 lg:hidden ${
          isMobileOpen ? "max-h-96 opacity-100 pb-3 pt-3" : "max-h-0 opacity-0 pb-0 pt-0"
        }`}
      >
        <div className="mb-3 flex flex-col gap-2">
          <Link href="/info" className={navLinkClasses("/info")} onClick={() => setIsMobileOpen(false)}>
            Info
          </Link>
          <Link href="/garage" className={navLinkClasses("/garage")} onClick={() => setIsMobileOpen(false)}>
            Garage
          </Link>
          <Link href="/community" className={navLinkClasses("/community")} onClick={() => setIsMobileOpen(false)}>
            Community
          </Link>
          <Link href="/shops" className={navLinkClasses("/shops")} onClick={() => setIsMobileOpen(false)}>
            Shops
          </Link>
        </div>

        <div className="border-t border-zinc-800/80 pt-3">
          {user ? (
            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/account"
                className={mobileAccountPillClass}
                onClick={() => setIsMobileOpen(false)}
              >
                {avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={avatarUrl}
                    alt={displayName || user.email || "User avatar"}
                    className="h-7 w-7 rounded-full border border-zinc-700 object-cover"
                  />
                ) : (
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-primary/20 text-[10px] font-semibold text-brand-primary">
                    {avatarInitial}
                  </span>
                )}
                <span className="max-w-[160px] truncate">
                  {displayName || user?.email?.split("@")[0] || "Account"}
                </span>
              </Link>

              {isStaff && (
                <Link
                  href="/staff"
                  className={mobileStaffPillClass}
                  onClick={() => setIsMobileOpen(false)}
                  style={{
                    borderColor: hexToRgba(staffPalette.border, 0.6) ?? staffPalette.border,
                    backgroundColor: staffPalette.bg,
                    color: staffPalette.text,
                  }}
                >
                  <FontAwesomeIcon
                    icon={faScrewdriverWrench}
                    className="h-3.5 w-3.5"
                  />
                  <span>Staff</span>
                </Link>
              )}
            </div>
          ) : (
            <Link
              href="/auth/login"
              className="inline-flex items-center gap-2 rounded-full border border-amber-300 bg-amber-400 px-3 py-2 text-[11px] font-medium text-black shadow-[0_0_14px_rgba(251,191,36,0.45)] transition-all duration-150 ease-out hover:bg-amber-300 hover:border-amber-200"
              onClick={() => setIsMobileOpen(false)}
            >
              Log in
            </Link>
          )}
        </div>
      </div>
    </header>
  );
}
