"use client";

import Link from "next/link";
import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faTrash } from "@fortawesome/free-solid-svg-icons";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { RolePill } from "@/components/RolePill";
import { DonationBadge } from "@/components/DonationBadge";

type DmInboxRow = {
  thread_id: string;
  other_user_id: string;
  other_username: string | null;
  other_display_name: string | null;
  other_avatar_url: string | null;
  other_role?: string | null;
  other_is_verified?: boolean | null;
  other_donation_rank?: string | null;
  last_message_body: string | null;
  last_message_at: string | null;
  unread_count: number | null;
};

function formatRank(role: string | null | undefined): string {
  const lower = (role ?? "member").toLowerCase();
  if (lower === "admin") return "Admin";
  if (lower === "moderator" || lower === "mod") return "Moderator";
  if (lower === "support") return "Support";
  return "Member";
}

function rankChipClasses(role: string | null | undefined): string {
  const lower = (role ?? "member").toLowerCase();
  if (lower === "admin") return "border-rose-500 bg-rose-500/20 text-rose-300";
  if (lower === "moderator" || lower === "mod") return "border-emerald-500 bg-emerald-500/20 text-emerald-200";
  if (lower === "support") return "border-sky-400 bg-sky-500/20 text-sky-300";
  return "border-zinc-600 bg-black/40 text-brand-textMuted";
}

function formatTimeAgo(iso: string | null): string {
  if (!iso) return "";
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

export default function MessagesPage() {
  const [userId, setUserId] = useState<string | null>(null);
  const [items, setItems] = useState<DmInboxRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [markingAllRead, setMarkingAllRead] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const supabase = supabaseBrowser();
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? null;
      setUserId(uid);

      if (!uid) {
        setItems([]);
        setLoading(false);
        return;
      }

      const { data, error: listErr } = await supabase.rpc("dm_list_threads", {
        p_limit: 50,
        p_offset: 0,
      });

      if (listErr) {
        console.error("dm_list_threads failed", listErr);
        setError("Failed to load messages.");
        setItems([]);
        setLoading(false);
        return;
      }

      const rows = (Array.isArray(data) ? data : []) as DmInboxRow[];
      // Load ranks for participants (best-effort)
      try {
        const ids = Array.from(new Set(rows.map((r) => r.other_user_id))).filter(Boolean);
        if (ids.length > 0) {
          const { data: roleRows } = await supabase
            .from("user_roles")
            .select("user_id, role")
            .in("user_id", ids);

          const roleById: Record<string, string | null> = {};
          (roleRows ?? []).forEach((rr) => {
            const row = rr as { user_id: string; role: string | null };
            roleById[row.user_id] = row.role ?? null;
          });

          // load verified + donation (best-effort)
          let verifiedById: Record<string, boolean | null> = {};
          let donationById: Record<string, string | null> = {};
          try {
            const { data: profRows } = await supabase
              .from("profiles")
              .select("id, is_verified, donation_rank")
              .in("id", ids);

            (profRows ?? []).forEach((pp) => {
              const row = pp as {
                id: string;
                is_verified?: boolean | null;
                donation_rank?: string | null;
              };
              verifiedById[row.id] = row.is_verified ?? null;
              donationById[row.id] = row.donation_rank ?? null;
            });
          } catch {
            verifiedById = {};
            donationById = {};
          }

          const merged = rows.map((r) => ({
            ...r,
            other_role: roleById[r.other_user_id] ?? null,
            other_is_verified: verifiedById[r.other_user_id] ?? null,
            other_donation_rank: donationById[r.other_user_id] ?? null,
          }));
          setItems(merged);
        } else {
          setItems(rows);
        }
      } catch {
        setItems(rows);
      }
    } catch (e: unknown) {
      console.error("messages load unexpected", e);
      setError("Failed to load messages.");
      setItems([]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // ✅ manual refresh only (no polling)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sorted = useMemo(() => {
    const copy = [...items];
    copy.sort((a, b) => {
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return bt - at;
    });
    return copy;
  }, [items]);

  const hasUnread = useMemo(
    () => items.some((t) => Number(t.unread_count ?? 0) > 0),
    [items]
  );

  const optimisticMarkThreadRead = (threadId: string) => {
    setItems((prev) =>
      prev.map((t) =>
        t.thread_id === threadId ? { ...t, unread_count: 0 } : t
      )
    );
  };

  const handleDelete = async (threadId: string, name: string) => {
    if (deletingThreadId) return;

    const ok = window.confirm(
      `Delete this chat with ${name}?\n\nThis will remove it from your inbox.`
    );
    if (!ok) return;

    setDeletingThreadId(threadId);
    setError(null);

    // optimistic remove
    setItems((prev) => prev.filter((x) => x.thread_id !== threadId));

    try {
      const supabase = supabaseBrowser();
      const { error: delErr } = await supabase.rpc("dm_leave_thread", {
        p_thread_id: threadId,
      });

      if (delErr) {
        console.error("dm_leave_thread failed", delErr);
        setError("Failed to delete chat.");
        await load();
      }
    } catch (e: unknown) {
      console.error("delete chat unexpected", e);
      setError("Failed to delete chat.");
      await load();
    } finally {
      setDeletingThreadId(null);
    }
  };

  const handleMarkAllRead = async () => {
    if (markingAllRead) return;
    if (!userId) return;
    if (!hasUnread) return;

    setMarkingAllRead(true);
    setError(null);

    // optimistic UI
    setItems((prev) => prev.map((t) => ({ ...t, unread_count: 0 })));

    try {
      const supabase = supabaseBrowser();
      const { error: mrErr } = await supabase.rpc("dm_mark_all_read");
      if (mrErr) {
        console.error("dm_mark_all_read failed", mrErr);
        setError("Failed to mark all as read.");
        await load(); // resync
      }
    } catch (e: unknown) {
      console.error("dm_mark_all_read unexpected", e);
      setError("Failed to mark all as read.");
      await load();
    } finally {
      setMarkingAllRead(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="text-lg font-semibold">Messages</h1>

        <div className="flex items-center gap-2">
          {hasUnread && (
            <button
              type="button"
              onClick={() => void handleMarkAllRead()}
              disabled={markingAllRead || loading}
              className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
              title="Mark all message threads as read"
            >
              {markingAllRead ? "Marking…" : "Mark all read"}
            </button>
          )}

          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
          >
            Refresh
          </button>
        </div>
      </div>

      {!userId && (
        <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-4 text-sm text-brand-textMuted">
          Please sign in to view messages.
        </div>
      )}

      {userId && (
        <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-black/30">
          {loading && (
            <div className="p-4 text-sm text-brand-textMuted">Loading…</div>
          )}

          {!loading && error && (
            <div className="p-4 text-sm text-rose-200">{error}</div>
          )}

          {!loading && !error && sorted.length === 0 && (
            <div className="p-6 text-center text-sm text-brand-textMuted">
              No messages yet.
            </div>
          )}

          {!loading && !error && sorted.length > 0 && (
            <div className="divide-y divide-zinc-900">
              {sorted.map((it) => {
                const name = it.other_display_name || it.other_username || "User";
                const preview = (it.last_message_body ?? "").trim();
                const time = formatTimeAgo(it.last_message_at);
                const unread = Number(it.unread_count ?? 0);
                const isDeleting = deletingThreadId === it.thread_id;

                return (
                  <div
                    key={it.thread_id}
                    className={
                      "group flex items-stretch transition hover:bg-white/5 " +
                      (unread > 0 ? "bg-amber-500/5" : "bg-transparent")
                    }
                  >
                    <Link
                      href={`/messages/${encodeURIComponent(it.thread_id)}`}
                      className="flex-1 p-3"
                      onClick={() => {
                        if (unread > 0) optimisticMarkThreadRead(it.thread_id);
                      }}
                    >
                      <div className="flex items-start gap-3">
                        <div className="mt-0.5 h-9 w-9 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-black/30">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          {it.other_avatar_url ? (
                            <img
                              src={it.other_avatar_url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center text-[12px] text-zinc-500">
                              {name ? name[0]?.toUpperCase() : "•"}
                            </div>
                          )}
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex flex-wrap items-center gap-2">
                              <div className="truncate text-sm font-semibold text-brand-text">
                                {name}
                                {it.other_is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                                {it.other_donation_rank ? (
                                  <DonationBadge rank={it.other_donation_rank} className="ml-0.5 h-3 w-3" />
                                ) : null}
                              </div>
                              <RolePill role={it.other_role} />
                              {unread > 0 ? (
                                <span className="ml-2 rounded-full border border-amber-400/70 bg-amber-500/20 px-2 py-0.5 text-[10px] text-amber-200">
                                  {unread}
                                </span>
                              ) : null}
                            </div>
                            <div className="shrink-0 text-[11px] text-zinc-500">
                              {time}
                            </div>
                          </div>

                          <div className="mt-0.5 line-clamp-2 text-[12px] text-brand-textMuted">
                            {preview || "(No message)"}
                          </div>
                        </div>
                      </div>
                    </Link>

                    {/* Delete button */}
                    <div className="flex items-center pr-2">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void handleDelete(it.thread_id, name);
                        }}
                        disabled={!!deletingThreadId || markingAllRead}
                        className={
                          "rounded-lg border px-2.5 py-2 text-[12px] transition " +
                          (isDeleting
                            ? "border-zinc-700 bg-black/40 text-brand-textMuted opacity-70"
                            : "border-zinc-800 bg-black/20 text-brand-textMuted hover:border-rose-500/60 hover:text-rose-200") +
                          " " +
                          (deletingThreadId && !isDeleting ? "opacity-50" : "")
                        }
                        aria-label="Delete chat"
                        title="Delete chat"
                      >
                        <FontAwesomeIcon icon={faTrash} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
