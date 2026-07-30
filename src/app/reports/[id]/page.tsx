"use client";

import Link from "next/link";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useEffect, useMemo, useState } from "react";
import { useParams, usePathname } from "next/navigation";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { MarkdownContent } from "@/components/MarkdownContent";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { isRecord } from "@/lib/typeGuards";

type Report = {
  id: string;
  category: string | null;
  reason: string;
  status: string;
  target_type: string;
  target_id: string;
  created_at: string;
  reporter_user_id: string;
  assigned_to: string | null;
  escalated_at?: string | null;
  escalated_by?: string | null;
};

type ReportMessage = {
  id: string;
  created_at: string | null;
  author_user_id: string | null;
  message: string;
  kind: "reporter" | "staff" | "staff_note";
};

type ProfileLite = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

type RestrictionRow = {
  kind: "site" | "community" | "dm";
  expires_at: string | null;
  active: boolean | null;
};

type ApiPayload = {
  ok?: boolean;
  error?: string;
  report?: Report;
  messages?: ReportMessage[];
  authors?: ProfileLite[];
  dm_thread?: {
    thread_id: string;
    messages: Array<{
      id: string;
      thread_id: string;
      created_by: string;
      body: string | null;
      created_at: string;
      is_deleted: boolean | null;
    }>;
    senders: ProfileLite[];
    members?: ProfileLite[];
  } | null;
  viewer?: { id?: string; is_staff?: boolean };
};

type TargetPreview = {
  href: string;
  title: string;
  preview: string;
};

type DmMessageRow = {
  id: string;
  thread_id: string;
  created_by: string;
  body: string | null;
  created_at: string;
  is_deleted: boolean | null;
};

function coerceParamToString(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && typeof v[0] === "string") return v[0];
  return "";
}

function extractIdFromPath(pathname: string): string {
  const parts = pathname.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function isUuidLike(id: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
    id
  );
}

function safeString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function asNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function stripMarkdown(input: string, maxLen: number): string {
  const s = (input ?? "").trim();
  if (!s) return "";
  const withoutCode = s.replace(/```[\s\S]*?```/g, " ");
  const withoutInline = withoutCode.replace(/`([^`]+)`/g, "$1");
  const withoutLinks = withoutInline.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
  const withoutMd = withoutLinks.replace(/[#>*_~\-]/g, " ").replace(/\s+/g, " ").trim();
  if (withoutMd.length <= maxLen) return withoutMd;
  return `${withoutMd.slice(0, Math.max(0, maxLen - 1))}…`;
}

function formatRestrictionLabel(kind: RestrictionRow["kind"], expiresAt: string | null): string {
  const base = kind === "site" ? "Temp banned" : kind === "community" ? "Community restricted" : "DM restricted";
  if (!expiresAt) return base;
  const t = new Date(expiresAt).getTime();
  if (!Number.isFinite(t)) return base;
  return `${base} until ${new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}

export default function ReportPage() {
  const params = useParams();
  const pathname = usePathname();

  const reportIdFromParams = coerceParamToString((params as { id?: unknown })?.id);
  const reportId = reportIdFromParams || extractIdFromPath(pathname);

  const hasReportId = reportId.length > 0;

  const isValidReportId = useMemo(() => {
    if (!hasReportId) return false;
    return isUuidLike(reportId);
  }, [hasReportId, reportId]);

  const supabase = supabaseBrowser();

  const [viewerId, setViewerId] = useState<string | null>(null);
  const [viewerToken, setViewerToken] = useState<string | null>(null);
  const [isStaffViewer, setIsStaffViewer] = useState(false);
  const [viewerRole, setViewerRole] = useState<string>("member");

  const [report, setReport] = useState<Report | null>(null);
  const [messages, setMessages] = useState<ReportMessage[]>([]);
  const [authorMap, setAuthorMap] = useState<Record<string, ProfileLite>>({});

  const [dmThreadLog, setDmThreadLog] = useState<ApiPayload["dm_thread"]>(null);
  const [dmThread, setDmThread] = useState<ApiPayload["dm_thread"]>(null);

  const [targetPreview, setTargetPreview] = useState<TargetPreview | null>(null);
  const [reportedUser, setReportedUser] = useState<ProfileLite | null>(null);
  const [reportedUserRoleLower, setReportedUserRoleLower] = useState<string | null>(null);
  const [threadAuthorRoleLower, setThreadAuthorRoleLower] = useState<string | null>(null);
  const [contentMarkdown, setContentMarkdown] = useState<string | null>(null);
  const [threadMeta, setThreadMeta] = useState<{ threadId: number | null; postId: number | null; threadAuthor: ProfileLite | null } | null>(null);

  const [activeRestrictions, setActiveRestrictions] = useState<RestrictionRow[]>([]);

  const [reportedUserBanActive, setReportedUserBanActive] = useState(false);
  const [reportedUserBanLoading, setReportedUserBanLoading] = useState(false);
  const [reportedUserBanReason, setReportedUserBanReason] = useState<string | null>(null);
  const [reportedUserBannedAt, setReportedUserBannedAt] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [reply, setReply] = useState("");
  const [internalNote, setInternalNote] = useState("");

  const [sending, setSending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [actionSaving, setActionSaving] = useState(false);
  const [rateLimitInfo, setRateLimitInfo] = useState<{ remaining: number; limit: number; resetAtIso: string; warning: boolean } | null>(null);

  const noteRateLimit = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;
    const rateLimit = record.rate_limit;
    if (!rateLimit || typeof rateLimit !== "object") return;
    setRateLimitInfo(rateLimit as { remaining: number; limit: number; resetAtIso: string; warning: boolean });
  };


  const restrictionByKind = useMemo(() => {
    const by: Partial<Record<RestrictionRow["kind"], RestrictionRow>> = {};
    for (const r of activeRestrictions) {
      if (r && (r.kind === "site" || r.kind === "community" || r.kind === "dm")) {
        by[r.kind] = r;
      }
    }
    return by;
  }, [activeRestrictions]);

  const isAdminViewer = isStaffViewer && viewerRole.toLowerCase() === "admin";
  const isModeratorViewer = isStaffViewer && viewerRole.toLowerCase() === "moderator";
  const isSupportViewer = isStaffViewer && viewerRole.toLowerCase() === "support";
  const reportedUserIsStaff =
    reportedUserRoleLower === "admin" ||
    reportedUserRoleLower === "moderator" ||
    reportedUserRoleLower === "support";
  const threadAuthorIsStaff =
    threadAuthorRoleLower === "admin" ||
    threadAuthorRoleLower === "moderator" ||
    threadAuthorRoleLower === "support";

  const applyRateLimit = (payload: unknown) => {
    if (!payload || typeof payload !== "object") return;
    const record = payload as Record<string, unknown>;
    const rateLimit = record.rate_limit;
    if (!rateLimit || typeof rateLimit !== "object") return;
    setRateLimitInfo(rateLimit as { remaining: number; limit: number; resetAtIso: string; warning: boolean });
  };

  const load = async () => {
    if (!hasReportId) {
      setLoading(true);
      return;
    }
    if (!isValidReportId) {
      setError("Invalid report ID.");
      setReport(null);
      setMessages([]);
      setAuthorMap({});
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      const {
        data: { session },
      } = await supabase.auth.getSession();

      const token = session?.access_token ?? null;
      setViewerId(user?.id ?? null);
      setViewerToken(token);

      if (!token) {
        setError("You must be logged in.");
        setReport(null);
        setMessages([]);
        setAuthorMap({});
        setLoading(false);
        return;
      }

      const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const j = (await res.json().catch(() => null)) as ApiPayload | null;

      if (!res.ok || !j?.ok || !j.report) {
        setError(j?.error ?? "Report not found or access denied.");
        setReport(null);
        setMessages([]);
        setAuthorMap({});
        setLoading(false);
        return;
      }

      setReport(j.report);
      setMessages(Array.isArray(j.messages) ? j.messages : []);
      const dm = j.dm_thread ?? null;
      setDmThread(dm);
      // For chat reports, treat the other participant as the primary moderation target
      if (j.report?.target_type === "dm_thread" && dm?.members && Array.isArray(dm.members)) {
        const other = dm.members.find((p) => p.id && p.id !== j.report?.reporter_user_id) ?? null;
        setReportedUser(other ?? null);
      }

      setIsStaffViewer(j.viewer?.is_staff === true);

      // Determine viewer role (admin/support/moderator) for staff-only actions.
      // UI gating only: RLS + server routes are the source of truth.
      if (user?.id) {
        const { data: roleRow } = await supabase
          .from("user_roles")
          .select("role")
          .eq("user_id", user.id)
          .maybeSingle<{ role: string }>();

        const role = typeof roleRow?.role === "string" ? roleRow.role : "member";
        setViewerRole(role);
      } else {
        setViewerRole("member");
      }

      const nextAuthorMap: Record<string, ProfileLite> = {};
      for (const a of j.authors ?? []) {
        if (a && typeof a.id === "string") nextAuthorMap[a.id] = a;
      }
      setAuthorMap(nextAuthorMap);

      setDmThreadLog(j.dm_thread ?? null);

      setLoading(false);
    } catch (e) {
      console.error("report load failed", e);
      setError("Unexpected error loading report.");
      setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await load();
    };
    void run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasReportId, isValidReportId, reportId]);

  useEffect(() => {
    const run = async () => {
      if (!report) {
        setTargetPreview(null);
        setReportedUser(null);
        setContentMarkdown(null);
        setThreadMeta(null);
        return;
      }

      try {
        if (report.target_type === "user") {
          const { data } = await supabase
            .from("profiles")
            .select("id, username, display_name")
            .eq("id", report.target_id)
            .maybeSingle<{ id: string; username: string | null; display_name: string | null }>();

          const name = data?.display_name || data?.username || "User";
          const u = data?.username ? `@${data.username}` : "";

          setReportedUser(data ? { id: data.id, username: data.username ?? null, display_name: data.display_name ?? null, avatar_url: null } : null);
          setContentMarkdown(null);
          setThreadMeta({ threadId: null, postId: null, threadAuthor: null });
          setTargetPreview({
            href: `/user/${encodeURIComponent(report.target_id)}`,
            title: u ? `${name} (${u})` : name,
            preview: "User profile",
          });
          return;
        }

        if (report.target_type === "forum_thread") {
          const id = asNumber(report.target_id);
          if (id == null) {
            setTargetPreview({
              href: "/community",
              title: "Thread",
              preview: `Thread id: ${report.target_id}`,
            });
            return;
          }

          const { data } = await supabase
            .from("forum_threads")
            .select("id, title, slug, created_by, forum_categories!inner(slug)")
            .eq("id", id)
            .maybeSingle<{ id: number; title: string; slug: string; forum_categories: { slug: string } }>();

          const catSlug = safeString(data?.forum_categories?.slug);
          const thrSlug = safeString(data?.slug);

          const threadAuthorId = safeString((data as unknown as { created_by?: unknown })?.created_by);
          let threadAuthor: ProfileLite | null = null;
          if (threadAuthorId) {
            const { data: p } = await supabase
              .from("profiles")
              .select("id, username, display_name, avatar_url")
              .eq("id", threadAuthorId)
              .maybeSingle<ProfileLite>();
            if (p && typeof p.id === "string") threadAuthor = p;
          }

          // Load root post markdown for a better admin preview
          const { data: rootPost } = await supabase
            .from("forum_posts")
            .select("id, body_markdown")
            .eq("thread_id", id)
            .is("parent_post_id", null)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle<{ id: number; body_markdown: string }>();

          setReportedUser(threadAuthor);
          setContentMarkdown(typeof rootPost?.body_markdown === "string" ? rootPost.body_markdown : null);
          setThreadMeta({ threadId: id, postId: rootPost?.id ?? null, threadAuthor });

          if (catSlug && thrSlug) {
            setTargetPreview({
              href: `/community/${encodeURIComponent(catSlug)}/${encodeURIComponent(thrSlug)}`,
              title: safeString(data?.title) || "Thread",
              preview: `Thread #${id}`,
            });
          } else {
            setTargetPreview({
              href: "/community",
              title: "Thread",
              preview: `Thread id: ${report.target_id}`,
            });
          }
          return;
        }

        if (report.target_type === "forum_post") {
          const id = asNumber(report.target_id);
          if (id == null) {
            setTargetPreview({
              href: "/community",
              title: "Post",
              preview: `Post id: ${report.target_id}`,
            });
            return;
          }

          const { data: post } = await supabase
            .from("forum_posts")
            .select("id, thread_id, body_markdown, created_by")
            .eq("id", id)
            .maybeSingle<{ id: number; thread_id: number; body_markdown: string }>();

          if (!post) {
            setTargetPreview({
              href: "/community",
              title: "Post",
              preview: `Post id: ${report.target_id}`,
            });
            return;
          }


          const postAuthorId = safeString((post as unknown as { created_by?: unknown })?.created_by);
          let postAuthor: ProfileLite | null = null;
          if (postAuthorId) {
            const { data: p } = await supabase
              .from("profiles")
              .select("id, username, display_name, avatar_url")
              .eq("id", postAuthorId)
              .maybeSingle<ProfileLite>();
            if (p && typeof p.id === "string") postAuthor = p;
          }

          setReportedUser(postAuthor);
          setContentMarkdown(typeof post.body_markdown === "string" ? post.body_markdown : null);
          const { data: thr } = await supabase
            .from("forum_threads")
            .select("id, title, slug, created_by, forum_categories!inner(slug)")
            .eq("id", Number(post.thread_id))
            .maybeSingle<{ id: number; title: string; slug: string; forum_categories: { slug: string } }>();

          const catSlug = safeString(thr?.forum_categories?.slug);
          const thrSlug = safeString(thr?.slug);

          setThreadMeta({ threadId: Number(post.thread_id), postId: post.id, threadAuthor: null });

          if (catSlug && thrSlug) {
            setTargetPreview({
              href: `/community/${encodeURIComponent(catSlug)}/${encodeURIComponent(thrSlug)}#post-${post.id}`,
              title: safeString(thr?.title) || "Thread",
              preview: stripMarkdown(safeString(post.body_markdown), 180) || `Post #${post.id}`,
            });
          } else {
            setTargetPreview({
              href: "/community",
              title: "Post",
              preview: stripMarkdown(safeString(post.body_markdown), 180) || `Post #${post.id}`,
            });
          }
          return;
        }

        if (report.target_type === "dm_thread") {
          // Prefer the "other" participant as the moderation target for DM reports.
          // Some deployments do not expose a dm_thread_members table; infer participants from the DM log.
          if (!reportedUser) {
            const members = dmThread?.members && Array.isArray(dmThread.members) ? dmThread.members : [];
            const other = members.find((p) => p.id && p.id !== report.reporter_user_id) ?? null;
            if (other) {
              setReportedUser(other);
            } else {
              // Best-effort inference from message senders
              const msgs = dmThread?.messages && Array.isArray(dmThread.messages) ? dmThread.messages : [];
              const senderIds = Array.from(
                new Set(
                  msgs
                    .map((m) => (m && typeof m === "object" ? (m as Record<string, unknown>).created_by : null))
                    .filter((v): v is string => typeof v === "string" && v.length > 0)
                )
              );

              const inferredId =
                senderIds.find((id) => id !== report.reporter_user_id) ?? senderIds[0] ?? "";
              if (inferredId) {
                const { data: p } = await supabase
                  .from("profiles")
                  .select("id, username, display_name, avatar_url")
                  .eq("id", inferredId)
                  .maybeSingle<ProfileLite>();
                if (p && typeof p.id === "string") setReportedUser(p);
              }
            }
          }
          setContentMarkdown(null);
          setThreadMeta(null);
          setTargetPreview({
            href: `/messages/${encodeURIComponent(report.target_id)}`,
            title: "Message thread",
            preview: `Thread: ${report.target_id}`,
          });
          return;
        }

        if (report.target_type === "dm_message") {
          const messageId = safeString(report.target_id);
          if (!messageId) {
            setTargetPreview({
              href: "/messages",
              title: "Message",
              preview: "Message id missing",
            });
            return;
          }

          const { data: dmMsg } = await supabase
            .from("dm_messages")
            .select("id, thread_id, created_by, body, created_at, is_deleted")
            .eq("id", messageId)
            .maybeSingle<DmMessageRow>();

          if (!dmMsg) {
            setTargetPreview({
              href: "/messages",
              title: "Message",
              preview: `Message id: ${messageId}`,
            });
            return;
          }

          const authorId = safeString(dmMsg.created_by);
          if (authorId) {
            const { data: p } = await supabase
              .from("profiles")
              .select("id, username, display_name, avatar_url")
              .eq("id", authorId)
              .maybeSingle<ProfileLite>();
            if (p && typeof p.id === "string") setReportedUser(p);
          }

          setContentMarkdown(null);
          setThreadMeta(null);
          setTargetPreview({
            href: `/messages/${encodeURIComponent(dmMsg.thread_id)}`,
            title: "Message",
            preview: stripMarkdown(safeString(dmMsg.body), 180) || `Message ${dmMsg.id}`,
          });
          return;
        }

        setTargetPreview({
          href: "/",
          title: report.target_type,
          preview: `Target id: ${report.target_id}`,
        });
      } catch (e) {
        console.error("target preview load failed", e);
        setTargetPreview({
          href: "/",
          title: "Reported content",
          preview: `${report.target_type}: ${report.target_id}`,
        });
        setReportedUser(null);
        setContentMarkdown(null);
        setThreadMeta(null);
      }
    };

    void run();
  }, [report, supabase, dmThread]);

  // Staff: load permanent ban status for the reported user (for Unban / request-ban toggle).
  useEffect(() => {
    const userId = safeString(reportedUser?.id);
    if (!isStaffViewer || !viewerToken || !userId) {
      setReportedUserBanActive(false);
      setReportedUserBanReason(null);
      setReportedUserBannedAt(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setReportedUserBanLoading(true);
      try {
        const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/ban-status`, {
          headers: { Authorization: `Bearer ${viewerToken}` },
        });

        const j = (await res.json().catch(() => null)) as
          | { ok?: unknown; banned?: unknown; reason?: unknown; banned_at?: unknown }
          | { error?: unknown }
          | null;

        if (cancelled) return;

        if (!res.ok) {
          setReportedUserBanActive(false);
          setReportedUserBanReason(null);
          setReportedUserBannedAt(null);
          return;
        }

        setReportedUserBanActive(j ? (j as { banned?: unknown }).banned === true : false);
        setReportedUserBanReason(
          typeof (j as { reason?: unknown } | null)?.reason === "string" ? ((j as { reason?: string }).reason ?? null) : null
        );
        setReportedUserBannedAt(
          typeof (j as { banned_at?: unknown } | null)?.banned_at === "string" ? ((j as { banned_at?: string }).banned_at ?? null) : null
        );
      } finally {
        if (!cancelled) setReportedUserBanLoading(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [isStaffViewer, viewerToken, reportedUser?.id]);

  useEffect(() => {
    const run = async () => {
      if (!isStaffViewer) {
        setActiveRestrictions([]);
        return;
      }
      if (!reportedUser?.id) {
        setActiveRestrictions([]);
        return;
      }

      const { data, error } = await supabase
        .from("user_restrictions")
        .select("kind, expires_at, active")
        .eq("user_id", reportedUser.id)
        .eq("active", true);

      if (error) {
        console.error("failed to load restrictions", error);
        setActiveRestrictions([]);
        return;
      }

      const now = Date.now();
      const rows = (Array.isArray(data) ? data : []) as RestrictionRow[];
      const filtered = rows.filter((r) => {
        const exp = r.expires_at;
        if (typeof exp === "string" && exp.length) {
          const t = new Date(exp).getTime();
          return Number.isFinite(t) ? t > now : true;
        }
        return true;
      });
      setActiveRestrictions(filtered);
    };

    void run();
  }, [isStaffViewer, reportedUser?.id, supabase]);
  useEffect(() => {
    if (!isStaffViewer) return;

    const ids: string[] = [];
    if (reportedUser?.id) ids.push(reportedUser.id);
    if (threadMeta?.threadAuthor?.id) ids.push(threadMeta.threadAuthor.id);

    const uniqueIds = Array.from(new Set(ids)).filter((v) => typeof v === "string" && v.length > 0);
    if (uniqueIds.length === 0) {
      setReportedUserRoleLower(null);
      setThreadAuthorRoleLower(null);
      return;
    }

    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from("user_roles")
        .select("user_id, role")
        .in("user_id", uniqueIds);

      if (cancelled) return;

      if (error || !data) {
        // Leave roles unknown (we only use this to hide staff moderation actions)
        setReportedUserRoleLower(null);
        setThreadAuthorRoleLower(null);
        return;
      }

      const roleById = new Map<string, string>();
      for (const row of data as unknown as { user_id: string; role: string }[]) {
        if (row && typeof row.user_id === "string" && typeof row.role === "string") {
          roleById.set(row.user_id, row.role.toLowerCase());
        }
      }

      setReportedUserRoleLower(reportedUser?.id ? roleById.get(reportedUser.id) ?? "member" : null);
      setThreadAuthorRoleLower(threadMeta?.threadAuthor?.id ? roleById.get(threadMeta.threadAuthor.id) ?? "member" : null);
    })();

    return () => {
      cancelled = true;
    };
  }, [isStaffViewer, reportedUser?.id, threadMeta?.threadAuthor?.id, supabase]);


  const staffUpdate = async (next: { status?: string; assigned_to?: string | null }) => {
    if (!viewerToken || !report) return;
    setUpdating(true);
    try {
      const res = await fetch(`/api/staff/reports/${encodeURIComponent(report.id)}/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify(next),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as unknown;
	        applyRateLimit(j);
        const message =
          isRecord(j) && typeof j.error === "string" && j.error.trim().length
            ? j.error
            : null;
        alert(message ?? "Failed to update report.");
        return;
      }

      await load();
    } catch (e) {
      console.error("staff update failed", e);
      alert("Unexpected error updating report.");
    } finally {
      setUpdating(false);
    }
  };

  const sendStaffNote = async () => {
    if (!viewerToken || !report) return;
    const note = internalNote.trim();
    if (!note) return;

    setUpdating(true);
    try {
      const res = await fetch(`/api/staff/reports/${encodeURIComponent(report.id)}/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ internal_note: note }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        alert(j?.error ?? "Failed to save internal note.");
        return;
      }

      setInternalNote("");
      await load();
    } catch (e) {
      console.error("send staff note failed", e);
      alert("Unexpected error saving internal note.");
    } finally {
      setUpdating(false);
    }
  };

  const handleEscalate = async () => {
  if (!viewerToken || !report) return;
  if (!isStaffViewer) return;

  setActionSaving(true);
  try {
    const isEscalated = !!report.escalated_at;
    const url = isEscalated
      ? `/api/staff/reports/${encodeURIComponent(report.id)}/descalate`
      : `/api/staff/reports/${encodeURIComponent(report.id)}/escalate`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${viewerToken}`,
      },
    });

    if (!res.ok) {
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      alert(j?.error ?? (isEscalated ? "Failed to de-escalate." : "Failed to escalate."));
      return;
    }

    await load();
  } catch (e) {
    console.error("escalate toggle failed", e);
    alert("Unexpected error updating escalation.");
  } finally {
    setActionSaving(false);
  }
};


const toggleResolved = async () => {
  if (!report) return;
  const next = report.status === "resolved" ? "open" : "resolved";
  await staffUpdate({ status: next });
};


  const requestBanUser = async (userId: string, currentlyBanned: boolean) => {
    if (!viewerToken) return;
    try {
      const res = await fetch("/api/staff/ban-user", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ userId, currentlyBanned, reason: `From report ${report?.id ?? ""}` }),
      });

      const j = (await res.json().catch(() => null)) as { error?: string } | null;

      if (!res.ok) {
        alert(j?.error ?? "Failed to request ban.");
        return;
      }

      const pending =
        j && typeof j === "object" && "pending" in j
          ? Boolean((j as { pending?: unknown }).pending)
          : false;

      if (pending) {
        alert(currentlyBanned ? "Unban request sent for approval." : "Ban request sent for approval.");
      } else {
        alert(currentlyBanned ? "User unbanned." : "User banned.");
      }
    } catch (e) {
      console.error("request ban failed", e);
      alert("Unexpected error updating ban.");
    }
  };

  const setRestriction = async (args: {
    userId: string;
    kind: "site" | "community" | "dm";
    action: "set" | "clear";
    durationHours?: number | null;
  }) => {
    if (!viewerToken) return;
    try {
      const res = await fetch("/api/staff/restrictions/set", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({
          userId: args.userId,
          kind: args.kind,
          action: args.action,
          durationHours: typeof args.durationHours === "number" ? args.durationHours : null,
          reason: `From report ${report?.id ?? ""}`,
        }),
      });

      const j = (await res.json().catch(() => null)) as unknown;
      applyRateLimit(j);
      const jr = (j && typeof j === "object") ? (j as Record<string, unknown>) : null;
      if (!res.ok) {
        alert((jr && typeof jr.error === "string" ? jr.error : null) ?? "Failed to update restriction.");
        return;
      }

      const pending = Boolean(jr && jr.pending === true);
      if (pending) {
        alert("Request submitted for approval.");
      }

      await load();
    } catch (e) {
      console.error("restriction action failed", e);
      alert("Unexpected error updating restriction.");
    }
  };

  const deleteDmMessage = async (messageId: string) => {
    if (!viewerToken) return;
    if (!confirm("Delete this DM message?")) return;
    try {
      const res = await fetch("/api/staff/moderation/dm-delete-message", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ messageId }),
      });
      const j = (await res.json().catch(() => null)) as unknown;
      applyRateLimit(j);
      const jr = (j && typeof j === "object") ? (j as Record<string, unknown>) : null;
      if (!res.ok) {
        alert((jr && typeof jr["error"] === "string" ? (jr["error"] as string) : "Failed to delete message."));
        return;
      }
      await load();
    } catch (e) {
      console.error("dm delete failed", e);
      alert("Unexpected error deleting message.");
    }
  };

  const deleteThread = async (threadId: number) => {
    if (!viewerToken) return;
    const defaultReason = `From report ${report?.id ?? ""}`.trim() || "Deleted by staff";
    const input = window.prompt("Reason for deletion (optional)", defaultReason);
    if (input === null) return;
    const reason = input.trim() || defaultReason;

    try {
      const res = await fetch("/api/staff/moderation/delete-thread", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ threadId, reason }),
      });

      const j = (await res.json().catch(() => null)) as { error?: string } | null;

      if (!res.ok) {
        alert(j?.error ?? "Failed to delete thread.");
        return;
      }

      alert("Thread deleted.");
      await load();
    } catch (e) {
      console.error("delete thread failed", e);
      alert("Unexpected error deleting thread.");
    }
  };

  const deletePost = async (postId: number) => {
    if (!viewerToken) return;
    const defaultReason = `From report ${report?.id ?? ""}`.trim() || "Deleted by staff";
    const input = window.prompt("Reason for deletion (optional)", defaultReason);
    if (input === null) return;
    const reason = input.trim() || defaultReason;

    try {
      const res = await fetch("/api/staff/moderation/delete-post", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ postId, reason }),
      });

      const j = (await res.json().catch(() => null)) as { error?: string } | null;

      if (!res.ok) {
        alert(j?.error ?? "Failed to delete post.");
        return;
      }

      alert("Post deleted.");
      await load();
    } catch (e) {
      console.error("delete post failed", e);
      alert("Unexpected error deleting post.");
    }
  };

  const addInternalNote = async () => {
    if (!viewerToken || !report) return;
    const note = internalNote.trim();
    if (!note) return;

    setUpdating(true);
    try {
      const res = await fetch(`/api/staff/reports/${encodeURIComponent(report.id)}/update`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${viewerToken}`,
        },
        body: JSON.stringify({ internal_note: note }),
      });

      if (!res.ok) {
        const j = (await res.json().catch(() => null)) as { error?: string } | null;
        alert(j?.error ?? "Failed to add internal note.");
        return;
      }

      setInternalNote("");
      await load();
    } catch (e) {
      console.error("add internal note failed", e);
      alert("Unexpected error adding note.");
    } finally {
      setUpdating(false);
    }
  };

  if (!hasReportId) {
    return <div className="mx-auto max-w-xl px-4 py-12">Loading report…</div>;
  }

  if (!isValidReportId) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12 text-center">
        <h1 className="text-lg font-semibold">Invalid report ID</h1>
        <p className="mt-2 text-sm text-brand-textMuted">
          This report link is invalid or no longer exists.
        </p>
      </div>
    );
  }

  if (loading) {
    return <div className="mx-auto max-w-xl px-4 py-12">Loading report…</div>;
  }

  if (error || !report) {
    return (
      <div className="mx-auto max-w-xl px-4 py-12">
        <p className="text-sm text-red-400">{error ?? "Report not found."}</p>
        <Link href="/" className="text-sm underline">
          Go home
        </Link>
      </div>
    );
  }

  const reporter = authorMap[report.reporter_user_id];
  const reporterName = reporter?.display_name || reporter?.username || "Reporter";

  const assignee = report.assigned_to ? authorMap[report.assigned_to] : null;
  const assigneeName = assignee?.display_name || assignee?.username || "Unassigned";

  const showAwaitingBanner = report.status === "awaiting_reporter";
  const isReporterViewer = viewerId != null && viewerId === report.reporter_user_id;
  const moderationTargetId = safeString(reportedUser?.id);
  const moderationTargetLabel = reportedUser
    ? (reportedUser.username ? `@${reportedUser.username}` : (reportedUser.display_name || "User"))
    : "(unresolved)";
  const canTargetBeModerated = Boolean(moderationTargetId) && !reportedUserIsStaff;

  const formatEnumLabel = (value: string | null | undefined) => {
    const raw = (value ?? "").trim();
    if (!raw) return "";
    // Convert snake_case / kebab-case to Title Case.
    return raw
      .replace(/[_-]+/g, " ")
      .split(" ")
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="min-w-0">
            <div className="mb-2 flex items-center justify-between gap-3">
              <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Reports</p>
            </div>

            <h1 className="mt-1 text-xl font-semibold">Report</h1>
            {rateLimitInfo?.warning ? (
              <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                Approaching rate limit: {rateLimitInfo.remaining}/{rateLimitInfo.limit} actions remaining until {new Date(rateLimitInfo.resetAtIso).toLocaleTimeString()}
              </div>
            ) : null}

            <p className="mt-1 text-sm text-brand-textMuted">
              Status: <span className="font-medium text-brand-text">{formatEnumLabel(report.status)}</span>
              {report.escalated_at ? (
                <span className="ml-2 inline-flex items-center rounded-full border border-red-500/30 bg-red-500/10 px-2 py-0.5 text-[10px] font-medium text-red-200">
                  Escalated
                </span>
              ) : null}
              {report.category ? (
                <>
                  {" "}• Category: <span className="font-medium text-brand-text">{formatEnumLabel(report.category)}</span>
                </>
              ) : null}
              {isStaffViewer ? (
                <>
                  {" "}• Assigned: <span className="font-medium text-brand-text">{assigneeName}</span>
                </>
              ) : null}
            </p>
              {isStaffViewer ? (
                <div className="mt-2 text-[11px] text-brand-textMuted">
                  <Link
                    href="/staff/moderation/reports"
                    className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
                  >
                    ← Back to all reports
                  </Link>
                </div>
              ) : null}
          </div>

          <div className="shrink-0 rounded-2xl border border-zinc-800 bg-black/30 px-4 py-3 text-xs text-brand-textMuted md:text-right">
            <div>
              Reporter: {reporter ? (
              <Link
                href={reporter.username ? `/user/@${encodeURIComponent(reporter.username)}` : `/user/${encodeURIComponent(reporter.id)}`}
                className="text-brand-text hover:underline"
              >
                {reporter.display_name || reporter.username || "Reporter"}
                {reporter.username ? <span className="ml-1 text-brand-textMuted">@{reporter.username}</span> : null}
              </Link>
            ) : (
              <span className="text-brand-text">{reporterName}</span>
            )}
            </div>
            <div className="mt-1">
              Created: <span className="text-brand-text">{new Date(report.created_at).toLocaleString()}</span>
            </div>
          </div>
        </div>
      </header>
      {isStaffViewer ? (
        <section className="mb-6 rounded-2xl border border-zinc-800 bg-black/30 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm font-semibold text-brand-text">Staff actions</div>
            <button
              type="button"
              onClick={handleEscalate}
              disabled={actionSaving}
              className={
                "rounded-lg border px-3 py-2 text-sm disabled:opacity-60 " +
                (report.escalated_at
                  ? "border-zinc-800 bg-zinc-950 text-zinc-200 hover:bg-zinc-900"
                  : "border-red-500/40 bg-red-500/10 text-red-200 hover:bg-red-500/20")
              }
            >
              {report.escalated_at ? "De-escalate" : "Escalate to admins/mods"}
            </button>

<button
  type="button"
  onClick={() => void toggleResolved()}
  disabled={updating || !report}
  className="rounded-lg border border-zinc-800 bg-black/40 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-900 disabled:opacity-60"
>
  {report?.status === "resolved" ? "Reopen" : "Resolve"}
</button>

          </div>
          <p className="mt-1 text-xs text-brand-textMuted">
            Escalation pings all admins and marks this report as escalated for queue visibility.
          </p>

          <div className="mt-4 rounded-xl border border-zinc-800 bg-black/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs text-brand-textMuted">
                Moderation target: {moderationTargetId ? (
                  <Link className="font-medium text-brand-text hover:underline" href={`/user/${moderationTargetId}`}>{moderationTargetLabel}</Link>
                ) : (
                  <span className="font-medium text-brand-text">{moderationTargetLabel}</span>
                )}
              </div>
              {!moderationTargetId ? (
                <div className="text-[11px] text-amber-200">
                  Unable to resolve reported user for this target type. Actions are disabled.
                </div>
              ) : reportedUserIsStaff ? (
                <div className="text-[11px] text-amber-200">Target is staff — destructive actions disabled.</div>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={reportedUserBanLoading || !canTargetBeModerated}
                className={
                  "rounded-lg border px-2 py-1 text-[11px] font-medium hover:bg-opacity-15 disabled:opacity-60 " +
                  (reportedUserBanActive
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200 hover:bg-emerald-500/15"
                    : "border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/15")
                }
                onClick={() => {
                  if (!moderationTargetId) return;
                  void requestBanUser(moderationTargetId, reportedUserBanActive);
                }}
              >
                {reportedUserBanActive
                  ? isAdminViewer
                    ? "Unban"
                    : "Request unban"
                  : isAdminViewer
                    ? "Ban"
                    : "Request perm ban"}
              </button>

              <button
                type="button"
                disabled={!canTargetBeModerated}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/15 disabled:opacity-60"
                onClick={() => {
                  if (!moderationTargetId) return;
                  const input = window.prompt("Temp site ban: duration in hours", "24");
                  if (input === null) return;
                  const hours = Number(input.trim());
                  if (!Number.isFinite(hours) || hours <= 0) {
                    alert("Enter a positive number of hours.");
                    return;
                  }
                  void setRestriction({ userId: moderationTargetId, kind: "site", action: "set", durationHours: hours });
                }}
              >
                {(isAdminViewer || isModeratorViewer) ? "Temp ban" : "Request temp ban"}
              </button>

              <button
                type="button"
                disabled={!canTargetBeModerated}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/15 disabled:opacity-60"
                onClick={() => {
                  if (!moderationTargetId) return;
                  const input = window.prompt("Temp community restriction: duration in hours", "24");
                  if (input === null) return;
                  const hours = Number(input.trim());
                  if (!Number.isFinite(hours) || hours <= 0) {
                    alert("Enter a positive number of hours.");
                    return;
                  }
                  void setRestriction({ userId: moderationTargetId, kind: "community", action: "set", durationHours: hours });
                }}
              >
                {(isAdminViewer || isModeratorViewer) ? "Temp community" : "Request temp community"}
              </button>

              <button
                type="button"
                disabled={!canTargetBeModerated}
                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/15 disabled:opacity-60"
                onClick={() => {
                  if (!moderationTargetId) return;
                  const input = window.prompt("Temp DM restriction: duration in hours", "24");
                  if (input === null) return;
                  const hours = Number(input.trim());
                  if (!Number.isFinite(hours) || hours <= 0) {
                    alert("Enter a positive number of hours.");
                    return;
                  }
                  void setRestriction({ userId: moderationTargetId, kind: "dm", action: "set", durationHours: hours });
                }}
              >
                {(isAdminViewer || isModeratorViewer) ? "Temp DM" : "Request temp DM"}
              </button>
            </div>

            {(restrictionByKind.site || restrictionByKind.community || restrictionByKind.dm) ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {restrictionByKind.site ? (
                  <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                    {formatRestrictionLabel("site", restrictionByKind.site.expires_at)}
                  </span>
                ) : null}
                {restrictionByKind.community ? (
                  <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                    {formatRestrictionLabel("community", restrictionByKind.community.expires_at)}
                  </span>
                ) : null}
                {restrictionByKind.dm ? (
                  <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200">
                    {formatRestrictionLabel("dm", restrictionByKind.dm.expires_at)}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
        </section>
      ) : null}


      {showAwaitingBanner ? (
        <div className="mb-6 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
          <div className="text-sm font-semibold text-amber-100">Awaiting reporter</div>
          <p className="mt-1 text-sm text-brand-textMuted">
            {isReporterViewer
              ? "Staff asked for more details. Reply below to help resolve your report."
              : "This report is waiting on the reporter to provide more details."}
          </p>
        </div>
      ) : null}

      <section className="mb-6 rounded-2xl border border-zinc-800 bg-black/30 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-xs text-brand-textMuted">Reported content</div>
            {targetPreview ? (
              <div className="mt-1">
                <Link href={targetPreview.href} className="text-sm font-semibold hover:underline">
                  {targetPreview.title}
                </Link>
                <div className="mt-1 line-clamp-2 text-xs text-brand-textMuted">
                  {targetPreview.preview}
                </div>

                {reportedUser ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-brand-textMuted">Reported user:</span>
                    <Link
                      href={reportedUser.username ? `/user/@${encodeURIComponent(reportedUser.username)}` : `/user/${encodeURIComponent(reportedUser.id)}`}
                      className="font-medium text-brand-text hover:underline"
                    >
                      {reportedUser.display_name || reportedUser.username || "User"}
                      {reportedUser.username ? (
                        <span className="ml-1 text-brand-textMuted">@{reportedUser.username}</span>
                      ) : null}
                    </Link>

                  </div>
                ) : null}

                {threadMeta?.threadAuthor && (!reportedUser || threadMeta.threadAuthor.id !== reportedUser.id) && !threadAuthorIsStaff ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    <span className="text-brand-textMuted">Thread author:</span>
                    <Link
                      href={
                        threadMeta.threadAuthor.username
                          ? `/user/@${encodeURIComponent(threadMeta.threadAuthor.username)}`
                          : `/user/${encodeURIComponent(threadMeta.threadAuthor.id)}`
                      }
                      className="font-medium text-brand-text hover:underline"
                    >
                      {threadMeta.threadAuthor.display_name || threadMeta.threadAuthor.username || "User"}
                      {threadMeta.threadAuthor.username ? (
                        <span className="ml-1 text-brand-textMuted">@{threadMeta.threadAuthor.username}</span>
                      ) : null}
                    </Link>

                    {isStaffViewer && (isAdminViewer || isModeratorViewer || isSupportViewer) ? (
                      <button
                        type="button"
                        className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-500/15"
                        onClick={() => {
                          const id = threadMeta.threadAuthor?.id;
                          if (typeof id === "string" && id) void requestBanUser(id, false);
                        }}
                      >
                        {isAdminViewer ? "Ban" : "Request perm ban"}
                      </button>
                    ) : null}
                  </div>
                ) : null}

                {contentMarkdown ? (
                  <div className="mt-3 rounded-xl border border-zinc-800 bg-black/20 p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-brand-textMuted">
                      Content preview
                    </div>
                    <MarkdownContent markdown={contentMarkdown} />
                  </div>
                ) : null}

                {isStaffViewer && report.target_type === "dm_thread" && dmThreadLog?.thread_id ? (
                  <div className="mt-3 rounded-xl border border-zinc-800 bg-black/20 p-3">
                    <div className="mb-2 text-[11px] uppercase tracking-wide text-brand-textMuted">
                      Chat log (read-only)
                    </div>
                    <div className="max-h-[420px] space-y-2 overflow-auto pr-1">
                      {(dmThreadLog.messages ?? []).map((m) => {
                        const sender = (dmThreadLog.senders ?? []).find((s) => s.id === m.created_by);
                        const name = sender?.display_name || sender?.username || "User";
                        const isDeleted = m.is_deleted === true;
                        return (
                          <div key={m.id} className="rounded-lg border border-zinc-800 bg-black/10 p-2">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-xs font-medium text-brand-text">
                                {sender ? (
                                  <Link
                                    href={
                                      sender.username
                                        ? `/user/@${encodeURIComponent(sender.username)}`
                                        : `/user/${encodeURIComponent(sender.id)}`
                                    }
                                    className="hover:underline"
                                  >
                                    {name}
                                    {sender.username ? (
                                      <span className="ml-1 text-[11px] text-brand-textMuted">@{sender.username}</span>
                                    ) : null}
                                  </Link>
                                ) : (
                                  name
                                )}
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-brand-textMuted">
                                <span>
                                  {typeof m.created_at === "string" ? new Date(m.created_at).toLocaleString() : ""}
                                </span>
                                {(isAdminViewer || isModeratorViewer || isSupportViewer) && m.is_deleted !== true ? (
                                  <button
                                    type="button"
                                    className="rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-0.5 text-[11px] text-rose-200 hover:bg-rose-500/15"
                                    onClick={() => void deleteDmMessage(m.id)}
                                  >
                                    Delete
                                  </button>
                                ) : null}
                              </div>
                            </div>
                            <div className="mt-1 text-sm">
                              {isDeleted ? (
                                <span className="text-xs italic text-brand-textMuted">Message deleted</span>
                              ) : (
                                <MarkdownContent markdown={m.body ?? ""} />
                              )}
                            </div>
                          </div>
                        );
                      })}
                      {!dmThreadLog.messages?.length ? (
                        <div className="text-sm text-brand-textMuted">No messages found for this thread.</div>
                      ) : null}
                    </div>
                  </div>
                ) : null}

                {isStaffViewer ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {report.target_type === "forum_post" ? (
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-xs hover:border-zinc-500"
                        onClick={() => {
                          const pid = threadMeta?.postId;
                          if (typeof pid === "number" && Number.isFinite(pid)) void deletePost(pid);
                        }}
                      >
                        Delete post
                      </button>
                    ) : null}

                    {report.target_type === "forum_thread" ? (
                      <button
                        type="button"
                        className="rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-xs hover:border-zinc-500"
                        onClick={() => {
                          const tid = threadMeta?.threadId;
                          if (typeof tid === "number" && Number.isFinite(tid)) void deleteThread(tid);
                        }}
                      >
                        Delete thread
                      </button>
                    ) : null}
                  </div>
                ) : null}

              </div>
            ) : (
              <div className="mt-1 text-xs text-brand-textMuted">
                {report.target_type}: {report.target_id}
              </div>
            )}
          </div>

        </div>

          <div className="mt-6">
                  <MarkdownEditor
                    value={reply}
                    onChange={setReply}
                    rows={6}
                    className="no-zoom-input"
                    placeholder={isStaffViewer ? "Reply to the reporter…" : "Reply with more details…"}
                  />
          
                  <button
                    disabled={!reply.trim() || sending}
                    onClick={async () => {
                      setSending(true);
                      try {
                        const token = viewerToken;
                        if (!token) {
                          alert("You must be logged in.");
                          return;
                        }
          
                        const res = await fetch(`/api/reports/${encodeURIComponent(reportId)}/message`, {
                          method: "POST",
                          headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${token}`,
                          },
                          body: JSON.stringify({ message: reply }),
                        });
          
                        if (!res.ok) {
                          const j = (await res.json().catch(() => null)) as { error?: string } | null;
                          alert(j?.error ?? "Failed to send message.");
                          return;
                        }
          
                        setReply("");
                        await load();
                      } finally {
                        setSending(false);
                      }
                    }}
                    className="mt-3 inline-flex items-center justify-center gap-2 rounded-xl border border-brand-primary/60 bg-brand-primary/20 px-4 py-2 text-sm font-semibold text-brand-text hover:bg-brand-primary/25 disabled:opacity-50"
                  >
                    Send
                  </button>
                </div>


        {isStaffViewer ? (
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!viewerId || updating}
              onClick={() =>
                void staffUpdate({
                  assigned_to: report.assigned_to === viewerId ? null : viewerId,
                })
              }
              className="rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-xs hover:border-zinc-500 disabled:opacity-50"
            >
              {report.assigned_to === viewerId ? "Unassign" : "Assign to me"}
            </button>

            <label className="flex items-center gap-2 text-xs text-brand-textMuted">
              <span>Status</span>
              <MenuSelect
                ariaLabel="Status"
                value={report.status as string}
                onChange={(next) => void staffUpdate({ status: next })}
                disabled={updating}
                className="flex h-10 items-center gap-2 rounded-lg border border-zinc-700 bg-black px-3 text-xs text-brand-text outline-none transition hover:border-zinc-500"
                options={[
                  { value: "open", label: "Open" },
                  { value: "awaiting_reporter", label: "Awaiting reporter" },
                  { value: "resolved", label: "Resolved" },
                  { value: "dismissed", label: "Dismissed" },
                ]}
              />
            </label>
          </div>
        ) : null}
      </section>

      <div className={isStaffViewer ? "grid gap-6 lg:grid-cols-3" : ""}>
        <div className={isStaffViewer ? "space-y-4 lg:col-span-2" : "space-y-4"}>
          {messages
            .filter((m) => isStaffViewer || m.kind !== "staff_note")
            .map((m) => {
              const author = m.author_user_id ? authorMap[m.author_user_id] : null;
              const who =
                m.kind === "staff_note"
                  ? author?.display_name || author?.username || "Staff"
                  : m.kind === "staff"
                    ? author?.display_name || author?.username || "Staff"
                    : author?.display_name || author?.username || "Reporter";

              const badge =
                m.kind === "staff_note"
                  ? "Internal note"
                  : m.kind === "staff"
                    ? "Staff"
                    : "Reporter";

              const badgeClasses =
                m.kind === "staff"
                  ? "border-red-500/40 bg-red-500/10 text-red-200"
                  : m.kind === "staff_note"
                    ? "border-sky-500/40 bg-sky-500/10 text-sky-200"
                    : "border-amber-400/30 bg-amber-500/10 text-amber-200";

              return (
                <div key={m.id} className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-brand-textMuted">
                    {author ? (
                      <Link
                        href={
                          author.username
                            ? `/user/@${encodeURIComponent(author.username)}`
                            : `/user/${encodeURIComponent(author.id)}`
                        }
                        className="font-medium text-brand-text hover:underline"
                      >
                        {who}
                        {author.username ? (
                          <span className="ml-1 text-[11px] text-brand-textMuted">@{author.username}</span>
                        ) : null}
                      </Link>
                    ) : (
                      <span className="font-medium text-brand-text">{who}</span>
                    )}
                    <span className={`rounded-full border px-2 py-0.5 text-[10px] ${badgeClasses}`}>
                      {badge}
                    </span>
                    <span>
                      {new Date((m.created_at ?? report.created_at) ?? Date.now()).toLocaleString()}
                    </span>
                  </div>
                  <MarkdownContent markdown={m.message} />
                </div>
              );
            })}
        </div>

        {isStaffViewer ? (
          <aside className="lg:col-span-1">
            <div className="rounded-2xl border border-zinc-800 bg-black/25 p-4">
              <div className="text-sm font-semibold">Internal staff notes</div>
              <p className="mt-1 text-xs text-brand-textMuted">
                Visible to staff only. Does not notify the reporter.
              </p>
              <div className="mt-3">
                <MarkdownEditor
                  value={internalNote}
                  onChange={setInternalNote}
                  rows={4}
                  className="no-zoom-input"
                  placeholder="Write an internal note…"
                />
                <button
                  type="button"
                  disabled={!internalNote.trim() || updating}
                  onClick={() => void addInternalNote()}
                  className="mt-3 w-full rounded-xl border border-zinc-700 bg-black/40 px-4 py-2 text-sm font-semibold hover:border-zinc-500 disabled:opacity-50"
                >
                  Add note
                </button>
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}