"use client";

import Link from "next/link";
import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { MarkdownContent } from "@/components/MarkdownContent";
import { useBlocks } from "@/components/BlocksProvider";
import ReportModal from "@/components/ReportModal";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { DonationBadge } from "@/components/DonationBadge";
import { RolePill } from "@/components/RolePill";

type ThreadSummary = {
  thread_id: string;
  other_user_id: string;
  other_username: string | null;
  other_display_name: string | null;
  other_avatar_url: string | null;
  other_role?: string | null;
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

type MessageRow = {
  id: string;
  thread_id: string;
  created_by: string;
  body: string | null;
  created_at: string;
  is_deleted: boolean | null;
};

type SenderProfile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function profileHref(userId: string, username: string | null): string {
  const u = (username ?? "").trim();
  return u ? `/user/@${u}` : `/user/${userId}`;
}

export default function MessageThreadPage() {
  const params = useParams();
  const threadIdParam = (params as { threadId?: string }).threadId;
  const threadId =
    typeof threadIdParam === "string"
      ? threadIdParam
      : Array.isArray(threadIdParam)
        ? threadIdParam[0]
        : null;

  // Blocks (global)
  const {
    viewerId: blocksViewerId,
    blockedUserIds,
    blockedByUserIds,
    setBlockedLocal,
  } = useBlocks();

  const [viewerId, setViewerId] = useState<string | null>(null);
  const [summary, setSummary] = useState<ThreadSummary | null>(null);
  const [otherIsVerified, setOtherIsVerified] = useState<boolean>(false);
  const [messages, setMessages] = useState<MessageRow[]>([]);
  const [senderMap, setSenderMap] = useState<Map<string, SenderProfile>>(
    () => new Map()
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  // Block button UI state
  const [blockLoading, setBlockLoading] = useState(false);
  const [blockError, setBlockError] = useState<string | null>(null);

  // Report modal
  const [reportOpen, setReportOpen] = useState(false);

  const bottomRef = useRef<HTMLDivElement | null>(null);

  const otherName = useMemo(() => {
    return summary?.other_display_name || summary?.other_username || "User";
  }, [summary]);

  const otherHref = useMemo(() => {
    if (!summary?.other_user_id) return null;
    return profileHref(summary.other_user_id, summary.other_username);
  }, [summary]);

  const otherUserId = summary?.other_user_id ?? null;

  const otherProfile = useMemo(() => {
    if (!otherUserId) return null;
    return senderMap.get(otherUserId) ?? null;
  }, [otherUserId, senderMap]);

  const iBlockedThem = useMemo(() => {
    if (!blocksViewerId || !otherUserId) return false;
    return blockedUserIds.has(otherUserId);
  }, [blocksViewerId, otherUserId, blockedUserIds]);

  const theyBlockedMe = useMemo(() => {
    if (!blocksViewerId || !otherUserId) return false;
    return blockedByUserIds.has(otherUserId);
  }, [blocksViewerId, otherUserId, blockedByUserIds]);

  const messagingBlocked = iBlockedThem || theyBlockedMe;

  const markRead = async (tid: string) => {
    try {
      const supabase = supabaseBrowser();
      const { error: mrErr } = await supabase.rpc("dm_mark_thread_read", {
        p_thread_id: tid,
      });
      if (mrErr) console.error("dm_mark_thread_read failed", mrErr);
    } catch (e: unknown) {
      console.error("dm_mark_thread_read unexpected", e);
    }
  };

  const load = async () => {
    setLoading(true);
    setError(null);

    try {
      const supabase = supabaseBrowser();
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth?.user?.id ?? null;
      setViewerId(uid);

      if (!uid) {
        setSummary(null);
        setMessages([]);
        setSenderMap(new Map());
        setLoading(false);
        return;
      }

      if (!threadId) {
        setError("Missing thread id.");
        setLoading(false);
        return;
      }

      const { data: sum, error: sumErr } = await supabase.rpc("dm_get_thread", {
        p_thread_id: threadId,
      });

      if (sumErr) {
        console.error("dm_get_thread failed", sumErr);
        setError("Failed to load thread.");
        setSummary(null);
        setLoading(false);
        return;
      }

      const row = Array.isArray(sum) ? sum[0] : sum;
      const s =
        row && typeof row === "object" ? (row as ThreadSummary) : null;

      if (!s?.thread_id) {
        setError("Thread not found.");
        setSummary(null);
        setLoading(false);
        return;
      }

      // Load other user's rank (best-effort)
      try {
        const { data: rr } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", s.other_user_id)
          .maybeSingle<{ role: string | null }>();
        s.other_role = rr?.role ?? null;
      } catch {
        s.other_role = null;
      }

      setSummary(s);

      // Load other user's verified flag (best-effort)
      try {
        const { data: vp } = await supabase
          .from("profiles")
          .select("is_verified")
          .eq("id", s.other_user_id)
          .maybeSingle<{ is_verified: boolean | null }>();
        setOtherIsVerified(Boolean(vp?.is_verified));
      } catch {
        setOtherIsVerified(false);
      }

      // mark read (await + error-handled)
      await markRead(threadId);

      const { data: rows, error: msgErr } = await supabase
        .from("dm_messages")
        .select("id, thread_id, created_by, body, created_at, is_deleted")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true })
        .limit(100);

      if (msgErr) {
        console.error("dm_messages select failed", msgErr);
        setError("Failed to load messages.");
        setMessages([]);
        setSenderMap(new Map());
        setLoading(false);
        return;
      }

      const m = (rows ?? []) as MessageRow[];
      setMessages(m);

      const senderIds = Array.from(
        new Set(m.map((x) => x.created_by).filter(Boolean))
      );

      if (senderIds.length) {
        const { data: profs, error: pErr } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url, is_verified, donation_rank")
          .in("id", senderIds);

        if (!pErr) {
          const map = new Map<string, SenderProfile>();
          for (const p of (profs ?? []) as SenderProfile[])
            map.set(String(p.id), p);
          setSenderMap(map);
        } else {
          setSenderMap(new Map());
        }
      } else {
        setSenderMap(new Map());
      }

      // mark read again after load
      await markRead(threadId);
    } catch (e: unknown) {
      console.error("dm thread load unexpected", e);
      setError("Failed to load thread.");
      setSummary(null);
      setMessages([]);
      setSenderMap(new Map());
    } finally {
      setLoading(false);
    }
  };

  const canReportThisThread = !!viewerId && !!threadId;

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    if (!loading)
      bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [loading, messages.length]);

  const handleToggleBlock = async () => {
    if (!otherUserId) return;

    if (!blocksViewerId) {
      setBlockError("You must be logged in to block users.");
      return;
    }

    if (blocksViewerId === otherUserId) {
      setBlockError("You cannot block yourself.");
      return;
    }

    setBlockError(null);
    setBlockLoading(true);

    try {
      const supabase = supabaseBrowser();
      const {
        data: { session },
        error: sessionError,
      } = await supabase.auth.getSession();

      if (sessionError || !session?.access_token) {
        setBlockError("You must be logged in to block users.");
        setBlockLoading(false);
        return;
      }

      const nextShouldBlock = !iBlockedThem;

      const res = await fetch(`/api/forum/users/${otherUserId}/block`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ block: nextShouldBlock }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; blocked?: boolean; error?: string }
        | null;

      if (!res.ok || !payload?.ok) {
        console.error("Failed to toggle block (dm)", payload);
        setBlockError(payload?.error ?? "Failed to update block.");
        setBlockLoading(false);
        return;
      }

      const nowBlocked = !!payload.blocked;
      setBlockedLocal(otherUserId, nowBlocked);

      // If we blocked, clear draft to avoid confusion
      if (nowBlocked) setText("");

      setBlockLoading(false);
    } catch (e: unknown) {
      console.error("Unexpected error toggling block (dm)", e);
      setBlockError("Unexpected error updating block state.");
      setBlockLoading(false);
    }
  };

  const onSend = async () => {
    if (!threadId) return;
    if (messagingBlocked) return;

    const body = text.trim();
    if (!body) return;

    // Clear previous error for this send attempt
    setError(null);

    // Hard-block profanity (server-configured list)
    try {
      const supabase = supabaseBrowser();
      const { data: hasProfanity, error: profErr } = await supabase.rpc(
        "contains_profanity",
        { input_text: body }
      );

      if (profErr) {
        console.error("contains_profanity failed", profErr);
        // If the filter check fails unexpectedly, allow the send rather than breaking messaging.
      } else if (hasProfanity === true) {
        setError("Message contains blocked language.");
        return;
      }
    } catch (e: unknown) {
      console.error("contains_profanity unexpected", e);
      // Allow send if the check throws.
    }

    setSending(true);
    try {
      const { data: sessionData } = await supabaseBrowser().auth.getSession();
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        setError("You must be logged in to send messages.");
        setSending(false);
        return;
      }

      const res = await fetch("/api/messages/send", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ threadId, body }),
      });

      const payload = (await res.json().catch(() => null)) as
        | { ok?: boolean; error?: string }
        | null;

      if (!res.ok || !payload?.ok) {
        setError(payload?.error || "Failed to send message.");
        setSending(false);
        return;
      }

      setText("");
      await markRead(threadId);
      await load();
    } catch (e: unknown) {
      console.error("dm send unexpected", e);
      setError("Failed to send message.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 text-brand-text">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="min-w-0">
          {summary && otherHref ? (
            <div className="flex items-center gap-3">
              <Link
                href={otherHref}
                className="h-10 w-10 shrink-0 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900/40"
                aria-label="View profile"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {summary.other_avatar_url ? (
                  <img
                    src={summary.other_avatar_url}
                    alt={otherName}
                    className="h-full w-full object-cover"
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-zinc-400">
                    <span className="text-sm">
                      {(otherName?.[0] || "?").toUpperCase()}
                    </span>
                  </div>
                )}
              </Link>

              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="truncate text-lg font-semibold">
                    <Link href={otherHref} className="hover:text-brand-primary">
                      {otherName}
                      {otherIsVerified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                      {otherProfile?.donation_rank ? (
                        <DonationBadge rank={otherProfile.donation_rank} className="ml-0.5 h-3 w-3" />
                      ) : null}
                    </Link>
                  </h1>

                  <RolePill role={summary?.other_role} />
                </div>

                <div className="mt-0.5 text-[11px] text-brand-textMuted">
                  <Link href="/messages" className="hover:text-brand-text">
                    ← Back to messages
                  </Link>
                </div>
              </div>
            </div>
          ) : (
            <>
              <h1 className="text-lg font-semibold">
                {summary ? otherName : "Messages"}
              </h1>
              <div className="mt-0.5 text-[11px] text-brand-textMuted">
                <Link href="/messages" className="hover:text-brand-text">
                  ← Back to messages
                </Link>
              </div>
            </>
          )}
        </div>

        <div className="shrink-0 flex items-start gap-2">
          {viewerId && threadId ? (
            <button
              type="button"
              onClick={() => setReportOpen(true)}
              className="rounded-xl border border-zinc-700 bg-black/40 px-3 py-2 text-xs text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
            >
              Report
            </button>
          ) : null}

          {/* ✅ Block / Unblock */}
          {blocksViewerId && otherUserId && blocksViewerId !== otherUserId && (
            <div className="flex flex-col items-end">
            <button
              type="button"
              onClick={() => void handleToggleBlock()}
              disabled={blockLoading}
              className={
                "rounded-xl border px-3 py-2 text-xs transition " +
                (iBlockedThem
                  ? "border-zinc-700 bg-black/40 text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
                  : "border-rose-500/60 bg-rose-500/15 text-rose-200 hover:border-rose-400 hover:bg-rose-500/25") +
                (blockLoading ? " opacity-60" : "")
              }
            >
              {blockLoading ? "Updating…" : iBlockedThem ? "Unblock" : "Block"}
            </button>
            {blockError && (
              <div className="mt-1 text-[10px] text-rose-300">{blockError}</div>
            )}
            </div>
          )}
        </div>
      </div>

      <ReportModal
        open={reportOpen}
        onClose={() => setReportOpen(false)}
        title={summary ? `Report chat with ${otherName}` : "Report chat"}
        description="This sends a private report to staff. Include context and timestamps if relevant."
        targetType="dm_thread"
        targetId={threadId ?? ""}
      />

      {!viewerId && (
        <div className="rounded-xl border border-zinc-800/80 bg-black/30 p-4 text-sm text-brand-textMuted">
          Please sign in to view messages.
        </div>
      )}

      {viewerId && (
        <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-black/30">
          {loading && (
            <div className="p-4 text-sm text-brand-textMuted">Loading…</div>
          )}

          {!loading && error && (
            <div className="p-4 text-sm text-rose-200">{error}</div>
          )}

          {!loading && !error && (
            <>
              {/* ✅ Block banner */}
              {messagingBlocked && (
                <div className="border-b border-zinc-800/80 bg-black/40 p-3 text-[12px] text-brand-textMuted">
                  {iBlockedThem
                    ? "You blocked this user. Messaging is disabled."
                    : "You can’t message this user because they’ve blocked you."}
                </div>
              )}

              <div className="max-h-[60vh] overflow-auto p-4">
                {messages.length === 0 && (
                  <div className="py-6 text-center text-sm text-brand-textMuted">
                    No messages yet.
                  </div>
                )}

                <div className="space-y-3">
                  {messages.map((m) => {
                    const mine = viewerId === m.created_by;
                    const sender = senderMap.get(m.created_by);

                    const senderName =
                      sender?.display_name || sender?.username || "User";

                    const senderHref =
                      sender?.id
                        ? profileHref(sender.id, sender.username)
                        : null;

                    const body = (m.is_deleted
                      ? "(Deleted)"
                      : (m.body ?? "")
                    ).trim();

                    return (
                      <div
                        key={m.id}
                        className={mine ? "flex justify-end" : "flex justify-start"}
                      >
                        {!mine && (
                          <div className="mr-2 mt-1 shrink-0">
                            {senderHref ? (
                              <Link
                                href={senderHref}
                                className="block h-8 w-8 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900/40"
                                aria-label="View profile"
                              >
                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                {sender?.avatar_url ? (
                                  <img
                                    src={sender.avatar_url}
                                    alt={senderName}
                                    className="h-full w-full object-cover"
                                  />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-zinc-400">
                                    <span className="text-xs">
                                      {(senderName?.[0] || "?").toUpperCase()}
                                    </span>
                                  </div>
                                )}
                              </Link>
                            ) : (
                              <div className="h-8 w-8 overflow-hidden rounded-full border border-zinc-800 bg-zinc-900/40" />
                            )}
                          </div>
                        )}

                        <div
                          className={
                            "max-w-[85%] rounded-2xl border px-3 py-2 text-[12px] " +
                            (mine
                              ? "border-amber-400/40 bg-amber-500/10 text-brand-text"
                              : "border-zinc-700 bg-black/40 text-brand-text")
                          }
                        >
                          {!mine && (
                            <div className="mb-1 text-[11px] font-semibold text-brand-textMuted">
                              {senderHref ? (
                                <Link
                                  href={senderHref}
                                  className="hover:text-brand-text"
                                >
                                  {senderName}
                                  {sender?.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                                  {sender?.donation_rank ? (
                                    <DonationBadge rank={sender.donation_rank} className="ml-0.5 h-3 w-3" />
                                  ) : null}
                                </Link>
                              ) : (
                                <span className="inline-flex items-center">
                                  {senderName}
                                  {sender?.is_verified ? (
                                    <VerifiedBadge className="ml-0.5 h-3 w-3" />
                                  ) : null}
                                </span>
                              )}
                            </div>
                          )}

                          <MarkdownContent
                            markdown={body}
                            makeUserHref={(username) => `/user/@${username}`}
                            className="text-brand-text"
                          />

                          <div className="mt-1 text-[10px] text-zinc-500">
                            {formatTime(m.created_at)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={bottomRef} />
                </div>
              </div>

              {/* ✅ Composer: prevent mobile width jump + no zoom */}
              <div className="border-t border-zinc-800 p-3 overflow-x-hidden">
                <div className="flex items-end gap-2 min-w-0">
                  <MarkdownEditor
                    value={text}
                    onChange={setText}
                    rows={4}
                    placeholder={
                      messagingBlocked ? "Messaging disabled" : "Write a message…"
                    }
                    disabled={messagingBlocked}
                    className={
                      "min-h-[44px] min-w-0 w-full resize-none " +
                      (messagingBlocked
                        ? "border-zinc-800 text-brand-textMuted opacity-70"
                        : "border-zinc-700 text-brand-text focus:border-amber-400/70")
                    }
                  />
                  <button
                    type="button"
                    onClick={() => void onSend()}
                    disabled={sending || text.trim().length === 0 || messagingBlocked}
                    className="shrink-0 inline-flex h-[44px] items-center justify-center rounded-xl border border-amber-400/70 bg-amber-500/15 px-4 text-[12px] font-semibold text-amber-200 hover:bg-amber-500/25 disabled:opacity-50"
                  >
                    {sending ? "Sending…" : "Send"}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
