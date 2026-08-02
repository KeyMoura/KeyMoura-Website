"use client";

import Link from "next/link";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";

type ReportRow = {
  id: string;
  created_at: string;
  status: string;
  category: string | null;
  reason: string;
  target_type: string;
  target_id: string;
  reporter_user_id: string;
  assigned_to: string | null;
  escalated_at: string | null;
};

type ProfileLite = {
  id: string;
  username: string | null;
  display_name: string | null;
};

type ThreadLite = {
  id: number;
  title: string;
  slug: string;
  category_id: number;
  created_by: string | null;
};

type CategoryLite = {
  id: number;
  slug: string;
  name: string;
};

type PostLite = {
  id: number;
  thread_id: number;
  body_markdown: string;
  created_by: string;
};

type TargetPreview = {
  // Human label for the underlying content (thread title, post snippet, etc.)
  label: string;
  // Optional secondary label shown under the target user (e.g., thread title).
  sublabel?: string | null;
  href: string | null;
  // Community/category label for the content when applicable.
  contentCategory?: string | null;
  reportedUserId: string | null;
};

function reportCategoryLabel(category: string | null): string {
  const c = (category ?? "").trim();
  if (!c) return "—";
  // Make snake_case / kebab-case / lower strings readable
  const pretty = c
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return pretty
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function typeLabel(t: string): string {
  switch ((t ?? "").toLowerCase()) {
    case "dm_thread":
      return "DM Thread";
    case "dm_message":
      return "DM Message";
    case "forum_post":
      return "Forum Post";
    case "forum_thread":
      return "Forum Thread";
    case "user":
      return "User";
    default:
      return t;
  }
}

function truncateText(s: string, max = 20): string {
  const v = (s ?? "").trim();
  if (!v) return "";
  if (v.length <= max) return v;
  return `${v.slice(0, max)}…`;
}

function statusBadgeClass(statusRaw: string): string {
  const s = (statusRaw ?? "").toLowerCase();
  if (s === "open") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
  }
  if (s.includes("await") || s.includes("pending") || s.includes("review")) {
    return "border-amber-500/30 bg-amber-500/10 text-amber-200";
  }
  if (s.includes("resolved") || s.includes("closed") || s.includes("done")) {
    return "border-zinc-500/30 bg-white/5 text-zinc-200";
  }
  return "border-zinc-700 bg-black/30 text-zinc-200";
}


function statusLabel(statusRaw: string): string {
  const s = (statusRaw ?? "").trim();
  if (!s) return "—";
  const pretty = s
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return pretty
    .split(" ")
    .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : ""))
    .join(" ");
}

function stripMarkdown(md: string, maxLen = 120): string {
  const s = (md ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^\)]*\)/g, " ")
    .replace(/\[[^\]]*\]\([^\)]*\)/g, "$1")
    .replace(/[#>*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "";
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

function formatWhen(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

export default function StaffReportsPage() {
  const supabase = supabaseBrowser();
  const router = useRouter();

  const { data: access, isLoading: accessLoading } = useMeAccess();
  const perms = useMemo(() => new Set(access?.permissions ?? []), [access?.permissions]);
  const canView = perms.has("moderation.reports.view");
  const canModerate = perms.has("moderation.reports.moderate");
  const canOverride = perms.has("moderation.reports.override");

  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const [error, setError] = useState<string | null>(null);

  const [viewerId, setViewerId] = useState<string | null>(null);

  const [reports, setReports] = useState<ReportRow[]>([]);
  const [profiles, setProfiles] = useState<Record<string, ProfileLite>>({});
  const [previews, setPreviews] = useState<Record<string, TargetPreview>>({});

  // Filters
  const [query, setQuery] = useState<string>("");
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<"newest" | "oldest" | "latest">("newest");
  const [assigneeFilter, setAssigneeFilter] = useState<"all" | "me" | "unassigned">("all");
  const [showEscalated, setShowEscalated] = useState(true);

  const [visibleCount, setVisibleCount] = useState(20);

  const canSeeEscalated = canOverride;

  useEffect(() => {
    // For non-override viewers, default to Unassigned so the queue is actionable.
    if (!canOverride && assigneeFilter === "all") {
      setAssigneeFilter("unassigned");
    }
  }, [assigneeFilter, canOverride]);


  const load = async () => {
    setState("loading");
    setError(null);

    if (accessLoading) {
      setState("loading");
      return;
    }

    if (!access) {
      setError("You must be logged in.");
      setState("error");
      return;
    }

    if (!access.isStaff || !canView) {
      setError("You do not have permission to view reports.");
      setState("error");
      return;
    }

    const {
      data: { session },
      error: sessionErr,
    } = await supabase.auth.getSession();

    if (sessionErr || !session?.user) {
      setError("You must be logged in.");
      setState("error");
      return;
    }

    setViewerId(session.user.id);

    const { data: repRows, error: repErr } = await supabase
      .from("reports")
      .select(
        "id, created_at, status, category, reason, target_type, target_id, reporter_user_id, assigned_to, escalated_at"
      )
      .order("created_at", { ascending: false })
      .limit(400);

    if (repErr) {
      console.error("Failed to load reports", repErr);
      setError("Failed to load reports.");
      setState("error");
      return;
    }

    const rows = (repRows ?? []) as ReportRow[];
    setReports(rows);

    // Targets
    const threadIds = rows
      .filter((r) => r.target_type === "forum_thread")
      .map((r) => Number(r.target_id))
      .filter((v) => Number.isFinite(v) && v > 0);

    const postIds = rows
      .filter((r) => r.target_type === "forum_post")
      .map((r) => Number(r.target_id))
      .filter((v) => Number.isFinite(v) && v > 0);

    const userTargetIds = rows
      .filter((r) => r.target_type === "user")
      .map((r) => r.target_id)
      .filter((v): v is string => typeof v === "string" && !!v);

    const dmThreadItems = rows
      .filter((r) => r.target_type === "dm_thread")
      .map((r) => ({ threadId: String(r.target_id), reporterUserId: r.reporter_user_id }))
      .filter((it) => it.threadId && it.reporterUserId);

    const { data: threads } = threadIds.length
      ? await supabase
          .from("forum_threads")
          .select("id, title, slug, category_id, created_by")
          .in("id", threadIds)
      : { data: [] as ThreadLite[] };

    const { data: posts } = postIds.length
      ? await supabase
          .from("forum_posts")
          .select("id, thread_id, body_markdown, created_by")
          .in("id", postIds)
      : { data: [] as PostLite[] };

    const categoryIds = Array.from(
      new Set((threads ?? []).map((t) => Number((t as ThreadLite).category_id)).filter((v) => Number.isFinite(v) && v > 0))
    );

    const { data: cats } = categoryIds.length
      ? await supabase.from("forum_categories").select("id, slug, name").in("id", categoryIds)
      : { data: [] as CategoryLite[] };

    const catMap = new Map<number, CategoryLite>();
    for (const c of (cats ?? []) as CategoryLite[]) catMap.set(Number(c.id), c);

    // Resolve dm_thread targets via service role API.
    let dmThreadTargets: Record<string, { userId: string; username: string | null; displayName: string | null }> = {};
    if (dmThreadItems.length) {
      const resp = await fetch("/api/staff/moderation/reports/resolve-dm-targets", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ items: dmThreadItems }),
      });
      const j = (await resp.json().catch(() => null)) as
        | { targets?: Record<string, { userId: string; username: string | null; displayName: string | null }>; error?: string }
        | null;
      if (resp.ok && j?.targets) dmThreadTargets = j.targets;
    }

    // Profiles: reporter + assignee + user targets + content authors + resolved dm targets
    const reporterAssigneeIds = Array.from(
      new Set(
        rows
          .flatMap((r) => [r.reporter_user_id, r.assigned_to])
          .filter((v): v is string => typeof v === "string" && !!v)
      )
    );

    const postAuthorIds = Array.from(
      new Set((posts ?? []).map((p) => (p as PostLite).created_by).filter((v): v is string => typeof v === "string" && !!v))
    );
    const threadAuthorIds = Array.from(
      new Set((threads ?? []).map((t) => (t as ThreadLite).created_by).filter((v): v is string => typeof v === "string" && !!v))
    );
    const dmUserIds = Array.from(new Set(Object.values(dmThreadTargets).map((t) => t.userId).filter((v) => !!v)));

    const profileIds = Array.from(new Set([...reporterAssigneeIds, ...userTargetIds, ...postAuthorIds, ...threadAuthorIds, ...dmUserIds]));

    const { data: profRows } = profileIds.length
      ? await supabase.from("profiles").select("id, username, display_name").in("id", profileIds)
      : { data: [] as ProfileLite[] };

    const profMap: Record<string, ProfileLite> = {};
    for (const p of (profRows ?? []) as ProfileLite[]) profMap[p.id] = p;
    setProfiles(profMap);

    const threadMap = new Map<number, ThreadLite>();
    for (const t of (threads ?? []) as ThreadLite[]) threadMap.set(Number(t.id), t);

    const postMap = new Map<number, PostLite>();
    for (const p of (posts ?? []) as PostLite[]) postMap.set(Number(p.id), p);

    // Build target previews
    const previewMap: Record<string, TargetPreview> = {};
    for (const r of rows) {
      const key = `${r.target_type}:${r.target_id}`;

      if (r.target_type === "user") {
        const p = profMap[r.target_id];
        const label = p?.username ? `@${p.username}` : p?.display_name || r.target_id;
        previewMap[key] = {
          label,
          sublabel: null,
          href: p?.username ? `/user/@${encodeURIComponent(p.username)}` : `/user/${encodeURIComponent(r.target_id)}`,
          contentCategory: null,
          reportedUserId: r.target_id,
        };
        continue;
      }

      if (r.target_type === "forum_thread") {
        const t = threadMap.get(Number(r.target_id));
        if (!t) {
          previewMap[key] = { label: `Thread ${r.target_id}`, sublabel: null, href: null, contentCategory: null, reportedUserId: null };
          continue;
        }
        const cat = catMap.get(Number(t.category_id));
        const href = cat ? `/community/${cat.slug}/${t.slug}` : "/community";
        previewMap[key] = {
          label: t.title ?? `Thread ${t.id}`,
          sublabel: t.title ?? null,
          href,
          contentCategory: cat?.name ?? null,
          reportedUserId: t.created_by ?? null,
        };
        continue;
      }

      if (r.target_type === "forum_post") {
        const p = postMap.get(Number(r.target_id));
        if (!p) {
          previewMap[key] = { label: `Post ${r.target_id}`, sublabel: null, href: null, contentCategory: null, reportedUserId: null };
          continue;
        }
        const t = threadMap.get(Number(p.thread_id));
        const cat = t ? catMap.get(Number(t.category_id)) : null;
        const threadHref = t && cat ? `/community/${cat.slug}/${t.slug}` : "/community";
        previewMap[key] = {
          label: stripMarkdown(p.body_markdown ?? ""),
          sublabel: t?.title ? `In: ${t.title}` : null,
          href: `${threadHref}#post-${p.id}`,
          contentCategory: cat?.name ?? null,
          reportedUserId: p.created_by ?? null,
        };
        continue;
      }

      if (r.target_type === "dm_thread") {
        const resolved = dmThreadTargets[String(r.target_id)] ?? null;
        const label = resolved?.username ? `@${resolved.username}` : resolved?.displayName || `Message thread ${r.target_id}`;
        previewMap[key] = {
          label,
          sublabel: null,
          href: `/messages/${encodeURIComponent(r.target_id)}`,
          contentCategory: "Messages",
          reportedUserId: resolved?.userId ?? null,
        };
        continue;
      }

      previewMap[key] = { label: `${r.target_type}:${r.target_id}`, sublabel: null, href: null, contentCategory: null, reportedUserId: null };
    }
    setPreviews(previewMap);

    setState("loaded");
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const escalatedReports = useMemo(() => {
    return reports.filter((r) => !!r.escalated_at && String(r.status ?? "").toLowerCase() !== "resolved" && String(r.status ?? "").toLowerCase() !== "dismissed");
  }, [reports]);

  const rowsToShow = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^@/, "");
    let out = [...reports];

    if (statusFilter !== "all") {
      const sf = statusFilter.toLowerCase();
      out = out.filter((r) => (r.status ?? "").toLowerCase() === sf);
    }
    if (assigneeFilter === "me" && viewerId) {
      out = out.filter((r) => r.assigned_to === viewerId);
    } else if (assigneeFilter === "unassigned") {
      out = out.filter((r) => !r.assigned_to);
    }

    if (q) {
      out = out.filter((r) => {
        const reporter = profiles[r.reporter_user_id];
        const reporterU = (reporter?.username ?? "").toLowerCase();
        const reporterD = (reporter?.display_name ?? "").toLowerCase();
        const prev = previews[`${r.target_type}:${r.target_id}`];
        const targetL = (prev?.label ?? "").toLowerCase();
        const reason = (r.reason ?? "").toLowerCase();
        return reporterU.includes(q) || reporterD.includes(q) || targetL.includes(q) || reason.includes(q);
      });
    }

    const activityTs = (r: ReportRow) => {
      const created = new Date(r.created_at).getTime();
      const escalated = r.escalated_at ? new Date(r.escalated_at).getTime() : 0;
      return Math.max(created, escalated);
    };

    out.sort((a, b) => {
      const at = sortMode === "latest" ? activityTs(a) : new Date(a.created_at).getTime();
      const bt = sortMode === "latest" ? activityTs(b) : new Date(b.created_at).getTime();
      if (sortMode === "oldest") return at - bt;
      return bt - at;
    });

    return out;
  }, [assigneeFilter, previews, profiles, query, reports, sortMode, statusFilter, viewerId]);
  useEffect(() => {
    setVisibleCount(20);
  }, [query, statusFilter, sortMode, assigneeFilter]);

  const visibleRows = useMemo(() => rowsToShow.slice(0, visibleCount), [rowsToShow, visibleCount]);


  if (state === "loading") {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="text-sm text-brand-textMuted">Loading…</div>
      </div>
    );
  }

  if (state === "error") {
    return (
      <AccessDeniedCard
        title="Moderation • Reports"
        message={error ?? "Access denied."}
        backHref="/staff"
        backLabel="Back to Staff"
      />
    );
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Staff • Moderation</p>
          <h1 className="mt-1 text-xl font-semibold">Reports</h1>
          <p className="mt-1 text-sm text-brand-textMuted">Work incoming reports and coordinate escalation.</p>
          {/* Sidebar navigation already provides staff navigation. */}
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-zinc-800 bg-black/20 p-3">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search @username, target, reporter, reason…"
            className="ui-input text-sm sm:max-w-md"
            />
            <div className="text-xs text-brand-textMuted">
              {rowsToShow.length === 0 ? (
                <span>No reports match your filters.</span>
              ) : (
                <span>
                  Showing <span className="text-brand-text">{Math.min(visibleRows.length, rowsToShow.length)}</span> of {rowsToShow.length}
                </span>
              )}
            </div>
          </div>

          <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1">
            <MenuSelect
              ariaLabel="Filter by status"
              value={statusFilter}
              onChange={(next) => setStatusFilter(next)}
              className="flex h-10 flex-none items-center gap-2 rounded-lg border border-zinc-800 bg-black/40 px-3 text-sm outline-none transition hover:border-zinc-600"
              options={[
                { value: "open", label: "Open" },
                { value: "awaiting", label: "Awaiting" },
                { value: "awaiting_review", label: "Awaiting review" },
                { value: "resolved", label: "Resolved" },
                { value: "all", label: "All statuses" },
              ]}
            />
            <MenuSelect
              ariaLabel="Sort mode"
              value={sortMode}
              onChange={(next) => setSortMode(next as "newest" | "oldest" | "latest")}
              className="flex h-10 flex-none items-center gap-2 rounded-lg border border-zinc-800 bg-black/40 px-3 text-sm outline-none transition hover:border-zinc-600"
              options={[
                { value: "newest", label: "Newest" },
                { value: "oldest", label: "Oldest" },
                { value: "latest", label: "Latest" },
              ]}
            />

            <div className="flex h-8 flex-none items-center gap-1 rounded-full border border-zinc-700 bg-black/40 p-0.5">
              {canOverride ? (
                <button
                  type="button"
                  onClick={() => setAssigneeFilter("all")}
                  className={`inline-flex h-7 items-center rounded-full px-3 text-[11px] ${assigneeFilter === "all" ? "bg-white/10 text-white" : "text-brand-textMuted hover:text-brand-text"}`}
                >
                  All
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setAssigneeFilter("me")}
                className={`inline-flex h-7 items-center rounded-full px-3 text-[11px] ${assigneeFilter === "me" ? "bg-white/10 text-white" : "text-brand-textMuted hover:text-brand-text"}`}
              >
                Assigned to me
              </button>
              <button
                type="button"
                onClick={() => setAssigneeFilter("unassigned")}
                className={`inline-flex h-7 items-center rounded-full px-3 text-[11px] ${assigneeFilter === "unassigned" ? "bg-white/10 text-white" : "text-brand-textMuted hover:text-brand-text"}`}
              >
                Unassigned
              </button>
            </div>
          </div>
        </div>
      </div>

      {canSeeEscalated && escalatedReports.length ? (
        <div className="mb-6 rounded-xl border border-red-500/20 bg-red-500/5 p-4">
          <button
            type="button"
            onClick={() => setShowEscalated((v) => !v)}
            className="-m-6 mb-3 flex w-[calc(100%+3rem)] items-center justify-between rounded-xl px-6 py-4 text-left"
            aria-expanded={showEscalated}
            title={showEscalated ? "Collapse escalated reports" : "Expand escalated reports"}
          >
            <h2 className="text-sm font-semibold text-brand-text">Escalated</h2>
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-200">{escalatedReports.length}</span>
              <span className="text-[11px] text-red-200/90">{showEscalated ? "Hide" : "Show"}</span>
            </div>
          </button>
          {showEscalated ? (
            <div className="space-y-2 max-h-[360px] overflow-y-auto pr-2">
            {escalatedReports.map((r) => {
              const prev = previews[`${r.target_type}:${r.target_id}`];
              const reporter = profiles[r.reporter_user_id];
              const reporterLabel = reporter?.username ? `@${reporter.username}` : reporter?.display_name || r.reporter_user_id;
              const reporterHref = reporter?.username ? `/user/@${encodeURIComponent(reporter.username)}` : `/user/${encodeURIComponent(r.reporter_user_id)}`;

              const targetUser = prev?.reportedUserId ? profiles[prev.reportedUserId] : null;
              const targetUserLabel = targetUser?.username
                ? `@${targetUser.username}`
                : targetUser?.display_name || prev?.label || `${r.target_type}:${r.target_id}`;
              const targetUserHref = targetUser?.username
                ? `/user/@${encodeURIComponent(targetUser.username)}`
                : prev?.reportedUserId
                  ? `/user/${encodeURIComponent(prev.reportedUserId)}`
                  : null;

              const assignee = r.assigned_to ? profiles[r.assigned_to] : null;
              const assigneeLabel = assignee?.username ? `@${assignee.username}` : assignee?.display_name || (r.assigned_to ? "(unknown)" : "—");

              const assigneeHref = assignee?.username
  ? `/user/@${encodeURIComponent(assignee.username)}`
  : r.assigned_to
    ? `/user/${encodeURIComponent(r.assigned_to)}`
    : null;
              return (
                <Link
                  key={r.id}
                  href={`/reports/${r.id}`}
                  className="block rounded-lg border border-red-500/20 bg-black/20 p-3"
                >
                  <div className="min-w-0">
                    <div className="font-medium text-red-200">
                      {r.category ?? "Report"}
                    </div>
                    <div className="mt-1 text-xs text-brand-textMuted">
                      {formatWhen(r.created_at)} • {typeLabel(r.target_type)}
                      {prev?.contentCategory ? ` • ${prev.contentCategory}` : ""}
                      {" "}• Reporter{" "}
                      <Link href={reporterHref} className="underline underline-offset-2">
                        {reporterLabel}
                      </Link>
                      {" "}• Target{" "}
                      {targetUserHref ? (
                        <Link href={targetUserHref} className="underline underline-offset-2">
                          {targetUserLabel}
                        </Link>
                      ) : (
                        <span>{targetUserLabel}</span>
                      )}
                      {prev?.sublabel ? ` • ${prev.sublabel}` : ""}
                    </div>
                    <div className="mt-1 text-xs text-brand-textMuted">
                      <span
                        className={`mr-2 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusBadgeClass(r.status)}`}
                      >
                        {statusLabel(r.status)}
                      </span>
                      <span>Assigned: {assigneeHref ? (<Link href={assigneeHref} className="underline underline-offset-2">{assigneeLabel}</Link>) : (<span>{assigneeLabel}</span>)}</span>
                      {r.reason ? <span> • {truncateText(r.reason, 60)}</span> : null}
                    </div>
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={async (e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const res = await fetch(`/api/staff/reports/${r.id}/descalate`, { method: "POST" });
                        if (!res.ok) {
                          const j = await res.json().catch(() => null);
                          const jr = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
                          const msg = jr && typeof jr["error"] === "string" ? (jr["error"] as string) : "Failed to de-escalate.";
                          alert(msg);
                          return;
                        }
                        await load();
                      }}
                        className="ui-btn ui-btn-danger !px-2 !py-1 text-[11px]"
                    >
                      De-escalate
                    </button>
                  </div>
                </Link>
              );
            })}
            </div>
          ) : null}
        </div>
      ) : null}

      
      <div className="md:hidden space-y-3">
        {visibleRows.map((r) => {
          const prev = previews[`${r.target_type}:${r.target_id}`];
          const reporter = profiles[r.reporter_user_id];
          const reporterLabel = reporter?.username ? `@${reporter.username}` : reporter?.display_name || truncateText(r.reporter_user_id, 14);
          const reporterHref = reporter?.username ? `/user/@${encodeURIComponent(reporter.username)}` : `/user/${encodeURIComponent(r.reporter_user_id)}`;
          const targetUser = prev?.reportedUserId ? profiles[prev.reportedUserId] : null;
          const targetUserLabel = targetUser?.username ? `@${targetUser.username}` : targetUser?.display_name || prev?.label || `${typeLabel(r.target_type)} #${truncateText(r.target_id, 12)}`;
          const targetUserHref = targetUser?.username ? `/user/@${encodeURIComponent(targetUser.username)}` : prev?.reportedUserId ? `/user/${encodeURIComponent(prev.reportedUserId)}` : null;

          const reportHref = `/reports/${encodeURIComponent(r.id)}`;

          return (
            <div
              key={r.id}
              className="ui-card cursor-pointer"
              role="link"
              tabIndex={0}
              onClick={() => {
                router.push(reportHref);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  router.push(reportHref);
                }
              }}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${statusBadgeClass(r.status)}`}>
                      {statusLabel(r.status)}
                    </span>
                    <span className="text-[11px] uppercase tracking-[0.14em] text-brand-textMuted">
                      {typeLabel(r.target_type)}
                    </span>
                  </div>
                  <div className="mt-2 text-sm font-semibold text-brand-text">
                    {prev?.href ? (
                      <Link
                        href={prev.href}
                        onClick={(e) => e.stopPropagation()}
                        className="underline underline-offset-2"
                      >
                        {prev.label}
                      </Link>
                    ) : (
                      <span>{prev?.label ?? `${r.target_type}:${r.target_id}`}</span>
                    )}
                  </div>
                  <div className="mt-1 text-xs text-brand-textMuted">
                    Reported by{" "}
                    <Link
                      href={reporterHref}
                      onClick={(e) => e.stopPropagation()}
                      className="underline underline-offset-2"
                    >
                      {reporterLabel}
                    </Link>
                    {targetUserHref ? (
                      <>
                        {" "}
                        • Target{" "}
                        <Link
                          href={targetUserHref}
                          onClick={(e) => e.stopPropagation()}
                          className="underline underline-offset-2"
                        >
                          {targetUserLabel}
                        </Link>
                      </>
                    ) : null}
                  </div>
                  <div className="mt-2 text-xs text-brand-textMuted">{truncateText(r.reason, 140)}</div>
                </div>
                <div className="text-xs text-brand-textMuted whitespace-nowrap">{formatWhen(r.created_at)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Desktop: same clean card previews as mobile (click anywhere to open). */}
      <div className="hidden md:grid grid-cols-1 gap-3 lg:grid-cols-2">
        {visibleRows.map((r) => {
          const reporter = profiles[r.reporter_user_id];
          const reporterLabel = reporter?.username ? `@${reporter.username}` : reporter?.display_name || r.reporter_user_id;
          const reporterHref = reporter?.username
            ? `/user/@${encodeURIComponent(reporter.username)}`
            : r.reporter_user_id
              ? `/user/${encodeURIComponent(r.reporter_user_id)}`
              : null;

          const prev = previews[`${r.target_type}:${r.target_id}`];
          const targetUser = prev?.reportedUserId ? profiles[prev.reportedUserId] : null;
          const targetUserLabel = targetUser?.username
            ? `@${targetUser.username}`
            : targetUser?.display_name || (prev?.reportedUserId ?? null) || "(unknown)";
          const targetUserHref = targetUser?.username
            ? `/user/@${encodeURIComponent(targetUser.username)}`
            : prev?.reportedUserId
              ? `/user/${encodeURIComponent(prev.reportedUserId)}`
              : null;

          return (
            <Link
              key={r.id}
              href={`/reports/${r.id}`}
              className="group rounded-2xl border border-zinc-800 bg-black/25 p-4 transition-all hover:border-zinc-700 hover:bg-black/35"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${statusBadgeClass(
                        r.status
                      )}`}
                    >
                      {statusLabel(r.status)}
                    </span>
                    <span className="text-[11px] uppercase tracking-[0.14em] text-brand-textMuted">
                      {typeLabel(r.target_type)}
                    </span>
                    <span className="text-[11px] text-brand-textMuted">• {reportCategoryLabel(r.category)}</span>
                  </div>

                  <div className="mt-2 text-sm font-semibold text-brand-text group-hover:text-brand-primary">
                    {prev?.label ?? `${r.target_type}:${r.target_id}`}
                  </div>

                  <div className="mt-1 text-xs text-brand-textMuted">
                    Reported by{" "}
                    {reporterHref ? (
                      <Link
                        href={reporterHref}
                        onClick={(e) => e.stopPropagation()}
                        className="underline underline-offset-2"
                      >
                        {reporterLabel}
                      </Link>
                    ) : (
                      <span>{reporterLabel}</span>
                    )}
                    {targetUserHref ? (
                      <>
                        {" "}• Target{" "}
                        <Link
                          href={targetUserHref}
                          onClick={(e) => e.stopPropagation()}
                          className="underline underline-offset-2"
                        >
                          {targetUserLabel}
                        </Link>
                      </>
                    ) : null}
                  </div>

                  <div className="mt-2 text-xs text-brand-textMuted">{truncateText(r.reason, 180)}</div>
                </div>

                <div className="text-xs text-brand-textMuted whitespace-nowrap">{formatWhen(r.created_at)}</div>
              </div>
            </Link>
          );
        })}
      </div>
      {rowsToShow.length > visibleRows.length ? (
        <div className="mt-4 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <button
            type="button"
            onClick={() => setVisibleCount((p) => Math.min(p + 20, rowsToShow.length))}
                className="ui-btn ui-btn-ghost h-9 text-[12px]"
          >
            Show 20 more
          </button>
          <div className="text-xs text-brand-textMuted">
            Showing <span className="text-brand-text">{visibleRows.length}</span> of {rowsToShow.length}
          </div>
        </div>
      ) : null}




    </div>
  );
}
