"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { MarkdownContent } from "@/components/MarkdownContent";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { MarkdownEditor } from "@/components/MarkdownEditor";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { RolePill } from "@/components/RolePill";
import { DonationBadge } from "@/components/DonationBadge";
import { MenuSelect } from "@/components/ui/MenuSelect";

type InfoPage = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  created_at: string;
  status: string;
  created_by: string | null;
  category: string | null;
  chassis: string | null;
  tags: string[] | null;
};

type RoleResult = {
  role: string;
};

type AdminAction = "approve" | "deny" | "forward" | "note";

type ReviewEvent = {
  id: string;
  action: string;
  performed_by: string;
  created_at: string;
  previous_title: string | null;
  new_title: string | null;
  previous_content_markdown: string | null;
  new_content_markdown: string | null;
  notes: string | null;
};



type Heading = { id: string; text: string; level: number };

function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}
type Profile = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url?: string | null;
  is_verified?: boolean | null;
  donation_rank?: string | null;
};

const ACTION_LABELS: Record<string, string> = {
  admin_approved: "Approved",
  admin_denied: "Denied",
  admin_forwarded_for_review: "Forwarded for further review",
  admin_note: "Note",
  admin_edited: "Edited",
  admin_undo_edit: "Undo edit",
};

function rolePillClass(role: string | null | undefined): string {
  const r = (role ?? "member").toLowerCase();
  if (r === "admin") return "border-rose-400/40 bg-rose-500/10 text-rose-200";
  if (r === "support") return "border-purple-400/40 bg-purple-500/10 text-purple-200";
  if (r === "moderator") return "border-sky-400/40 bg-sky-500/10 text-sky-200";
  if (r === "builder") return "border-emerald-400/40 bg-emerald-500/10 text-emerald-200";
  return "border-zinc-700 bg-black/30 text-brand-textMuted";
}

function formatRoleLabel(role: string | null | undefined): string {
  const r = (role ?? "member").toLowerCase();
  if (r === "admin") return "Admin";
  if (r === "support") return "Support";
  if (r === "moderator") return "Moderator";
  if (r === "builder") return "Builder";
  return "Member";
}

const CATEGORY_OPTIONS = [
  { value: "oem-manuals", label: "OEM Literature" },
  { value: "chassis-suspension", label: "Chassis & Suspension" },
  { value: "engine-drivetrain", label: "Engine & Drivetrain" },
  { value: "wiring-electronics", label: "Wiring & Electronics" },
  { value: "body-aero", label: "Body & Aero" },
  { value: "maintenance-general", label: "Maintenance & General" },
];

const CHASSIS_OPTIONS = [
  { value: "s13", label: "S13" },
  { value: "s14", label: "S14" },
  { value: "s15", label: "S15" },
  { value: "general", label: "General / Any" },
];

function parseTags(input: string): string[] {
  return input
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

function prettyCategoryLabel(input: string): string {
  return input
    .trim()
    .replace(/[-_]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map((w) => (w[0] ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export default function AdminPendingInfoDetailPage() {
  const params = useParams() as { id: string };
  const id = params.id;

  const router = useRouter();

  const { data: access, isLoading: accessLoading } = useMeAccess();
  // Page access is .view-only; moderation perms don't imply visibility.
  const canView = Boolean(access?.permissions?.includes("info.pending.view"));
  const canModerate = Boolean(access?.permissions?.includes("info.moderate"));

  const [loading, setLoading] = useState(true);
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [adminUserId, setAdminUserId] = useState<string | null>(null);
  const [page, setPage] = useState<InfoPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [actionLoading, setActionLoading] = useState<AdminAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // EDITING STATE
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editContent, setEditContent] = useState("");
  const [editCategory, setEditCategory] = useState("maintenance-general");
  const [editChassis, setEditChassis] = useState("general");
  const [editTagsInput, setEditTagsInput] = useState("");
  const [editLoading, setEditLoading] = useState(false);

  // HISTORY STATE
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const [undoLoadingId, setUndoLoadingId] = useState<string | null>(null);

  // SUBMITTER LABEL
  const [submitterLabel, setSubmitterLabel] = useState<string>("Unknown");
  const [submitterProfile, setSubmitterProfile] = useState<Profile | null>(null);
  const [submitterRole, setSubmitterRole] = useState<string | null>(null);

  // USERNAME MAP (id -> label)
  const [usernamesById, setUsernamesById] = useState<Record<string, string>>(
    {}
  );

  // REVIEW NOTES (for approve/deny/forward)
  const [reviewNotes, setReviewNotes] = useState("");

  const notesWithContent = events.filter(
    (ev) => ev.notes && String(ev.notes).trim() !== ""
  );

  // FULL DIFF TOGGLE
  const [expandedDiffId, setExpandedDiffId] = useState<string | null>(null);

  // PREVIEW MODE FOR MAIN CONTENT (view mode only)
  const [previewMode, setPreviewMode] = useState<"markdown" | "rendered">(
    "rendered"
  );

  // Derived values (hooks must run before any early returns)
  const previewMarkdown = page?.content_markdown ?? "";

  // NOTE: Avoid useMemo here to prevent hook-order issues in production builds.
  // These computations are cheap relative to the page size.
  const headings: Heading[] = (() => {
    if (!previewMarkdown) return [];
    return previewMarkdown
      .split("\n")
      .map((l) => l.trim())
      .map((l) => {
        const m = /^(#{1,6})\s+(.*)$/.exec(l);
        if (!m) return null;
        const level = m[1].length;
        const text = m[2].trim();
        if (!text) return null;
        return { id: slugify(text), text, level };
      })
      .filter((x): x is Heading => Boolean(x));
  })();

  const noteEvents = events.filter(
    (e) => e.action === "admin_note" && (e.notes ?? "").trim().length > 0
  );
  const reviewEvents = events.filter((e) => e.action !== "admin_note");
  const noteCount = noteEvents.length;

  useEffect(() => {
    const load = async () => {
      if (!id) {
        setError("Missing page id.");
        setLoading(false);
        return;
      }

      const supabase = supabaseBrowser();

      setLoading(true);
      setError(null);

      // 1) Get current user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setIsAdmin(false);
        setError("You must be logged in as staff to view this page.");
        setLoading(false);
        return;
      }

      // 2) Permission gate
      if (accessLoading) {
        setIsAdmin(false);
        setError(null);
        setLoading(true);
        return;
      }
      if (!canView) {
        setIsAdmin(false);
        setError("Access denied.");
        setLoading(false);
        return;
      }

      setIsAdmin(canModerate);
      setAdminUserId(user.id);

      // 3) Load the specific info page AND its review history in parallel
      const [pageRes, eventsRes] = await Promise.all([
        supabase
          .from("info_pages")
          .select(
            "id, title, slug, content_markdown, created_at, status, created_by, category, chassis, tags"
          )
          .eq("id", id)
          .maybeSingle<InfoPage>(),
        supabase
          .from("info_page_review_events")
          .select(
            "id, action, performed_by, created_at, previous_title, new_title, previous_content_markdown, new_content_markdown, notes"
          )
          .eq("info_page_id", id)
          .order("created_at", { ascending: false }),
      ]);

      if (pageRes.error || !pageRes.data) {
        console.error(pageRes.error);
        setError("Failed to load that submission.");
        setLoading(false);
        return;
      }

      const pageData = pageRes.data as InfoPage;
      const eventsData = (eventsRes.data || []) as ReviewEvent[];

      setPage(pageData);
      setEditTitle(pageData.title);
      setEditSlug(pageData.slug);
      setEditContent(pageData.content_markdown);
      setEditCategory(pageData.category ?? "maintenance-general");
      setEditChassis(pageData.chassis ?? "general");
      setEditTagsInput((pageData.tags ?? []).join(", "));
      setEvents(eventsData);

      // 4) Collect user IDs (submitter + all performed_by) and load usernames via .in()
      const userIds = new Set<string>();
      if (pageData.created_by) userIds.add(pageData.created_by);
      for (const ev of eventsData) {
        if (ev.performed_by) userIds.add(ev.performed_by);
      }

      const usernameMap: Record<string, string> = {};

      if (userIds.size > 0) {
        const { data: profilesData, error: profilesError } = await supabase
          .from("profiles")
          .select("id, username, display_name, avatar_url, is_verified, donation_rank")
          .in("id", Array.from(userIds));

        if (profilesError) {
          console.error("Error loading profiles", profilesError);
        } else if (profilesData) {
          const profilesList = profilesData as Profile[];
          for (const p of profilesList) {
            usernameMap[p.id] = p.display_name || p.username || p.id.slice(0, 8);
          }

          // Store submitter profile for preview sidebar.
          if (pageData.created_by) {
            const sp = profilesList.find((p) => p.id === pageData.created_by) ?? null;
            setSubmitterProfile(sp);
          }
        }
      }

      // Load roles for submitter + contributors shown in history.
      const roleMap: Record<string, string> = {};
      if (userIds.size > 0) {
        const { data: rolesData } = await supabase
          .from("user_roles")
          .select("user_id, role")
          .in("user_id", Array.from(userIds));

        if (rolesData) {
          for (const r of rolesData as Array<{ user_id: string; role: string }>) {
            roleMap[r.user_id] = r.role;
          }
        }
      }

      if (pageData.created_by) {
        setSubmitterRole(roleMap[pageData.created_by] ?? null);
      }

      setUsernamesById(usernameMap);

      // 5) Figure out submitter label (You / username / uuid)
      let label = "Unknown";

      if (pageData.created_by) {
        if (pageData.created_by === user.id) {
          label = "You";
        } else {
          const fromMap = usernameMap[pageData.created_by];
          label = fromMap || pageData.created_by;
        }
      }

      setSubmitterLabel(label);

      setLoading(false);
    };

    void load();
  }, [id]);

  const handleAction = async (action: AdminAction) => {
    if (!adminUserId) {
      setActionError("Missing admin user id.");
      return;
    }
    if (!page) {
      setActionError("No page loaded.");
      return;
    }

    const supabase = supabaseBrowser();

    try {
      setActionError(null);
      setActionLoading(action);

      let newStatus: string | null = null;
      let logAction: string;

      if (action === "note") {
        newStatus = null;
        logAction = "admin_note";
      } else if (action === "approve") {
        newStatus = "approved";
        logAction = "admin_approved";
      } else if (action === "deny") {
        newStatus = "rejected";
        logAction = "admin_denied";
      } else {
        // forward for further review: always mark as pending
        newStatus = "pending";
        logAction = "admin_forwarded_for_review";
      }

      const previousStatus = page.status;

      // 1) Update info_pages row (notes do not change status)
      if (newStatus !== null) {
        const { error: updateError } = await supabase
          .from("info_pages")
          .update({ status: newStatus })
          .eq("id", page.id);

        if (updateError) {
          console.error(updateError);
          setActionError("Failed to update info page.");
          setActionLoading(null);
          return;
        }
      }

      // 2) Insert review log entry for all actions (with notes)
      const { error: logError } = await supabase
        .from("info_page_review_events")
        .insert({
          info_page_id: page.id,
          action: logAction,
          performed_by: adminUserId,
          previous_title: page.title,
          previous_content_markdown: page.content_markdown,
          new_title: page.title,
          new_content_markdown: page.content_markdown,
          notes: reviewNotes || null,
        });

      if (logError) {
        console.error(logError);
        // best-effort audit trail
      }

      // 3) Fire audit API (best-effort)
      try {
        const {
          data: { session },
          error: sessionError,
        } = await supabase.auth.getSession();

        if (!sessionError && session?.access_token) {
          await fetch("/api/admin/audit-info-action", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
              infoPageId: page.id,
              action,
              notes: reviewNotes || null,
              previousStatus,
              newStatus,
              title: page.title,
            }),
          }).catch(() => {
            // ignore
          });
        }
      } catch (auditErr) {
        console.error("audit-info-action client error", auditErr);
      }

      setReviewNotes("");

      // Notes stay on the page; other actions return to list.
      if (action === "note") {
        const { data: freshEvents } = await supabase
          .from("info_page_review_events")
          .select(
            "id, action, performed_by, created_at, previous_title, new_title, previous_content_markdown, new_content_markdown, notes"
          )
          .eq("info_page_id", page.id)
          .order("created_at", { ascending: false });

        setEvents((freshEvents || []) as ReviewEvent[]);
        setActionLoading(null);
        return;
      }

      router.push("/staff/info/pending");
    } catch (e) {
      console.error(e);
      setActionError("Unexpected error performing action.");
      setActionLoading(null);
    }
  };

  const handleStartEdit = () => {
    if (!page) return;
    setEditTitle(page.title);
    setEditSlug(page.slug);
    setEditContent(page.content_markdown);
    setEditCategory(page.category ?? "maintenance-general");
    setEditChassis(page.chassis ?? "general");
    setEditTagsInput((page.tags ?? []).join(", "));
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    if (page) {
      setEditTitle(page.title);
      setEditSlug(page.slug);
      setEditContent(page.content_markdown);
      setEditCategory(page.category ?? "maintenance-general");
      setEditChassis(page.chassis ?? "general");
      setEditTagsInput((page.tags ?? []).join(", "));
    }
    setIsEditing(false);
    setActionError(null);
  };

  const handleSaveEdit = async () => {
    if (!adminUserId) {
      setActionError("Missing admin user id.");
      return;
    }
    if (!page) {
      setActionError("No page loaded.");
      return;
    }

    const supabase = supabaseBrowser();

    try {
      setEditLoading(true);
      setActionError(null);

      const previous = page;
      const tagsArray = parseTags(editTagsInput);

      const { error: updateError } = await supabase
        .from("info_pages")
        .update({
          title: editTitle,
          slug: editSlug,
          content_markdown: editContent,
          category: editCategory,
          chassis: editChassis,
          tags: tagsArray,
        })
        .eq("id", page.id);

      if (updateError) {
        console.error(updateError);
        setActionError("Failed to save changes.");
        setEditLoading(false);
        return;
      }

      const { error: logError } = await supabase
        .from("info_page_review_events")
        .insert({
          info_page_id: page.id,
          action: "admin_edited",
          performed_by: adminUserId,
          previous_title: previous.title,
          previous_content_markdown: previous.content_markdown,
          new_title: editTitle,
          new_content_markdown: editContent,
          notes: null,
        });

      if (logError) {
        console.error(logError);
      }

      const updatedPage: InfoPage = {
        ...page,
        title: editTitle,
        slug: editSlug,
        content_markdown: editContent,
        category: editCategory,
        chassis: editChassis,
        tags: tagsArray,
      };

      setPage(updatedPage);

      setEvents((prev) => [
        {
          id: crypto.randomUUID?.() ?? `local-${Date.now()}`,
          action: "admin_edited",
          performed_by: adminUserId,
          created_at: new Date().toISOString(),
          previous_title: previous.title,
          new_title: editTitle,
          previous_content_markdown: previous.content_markdown,
          new_content_markdown: editContent,
          notes: null,
        },
        ...prev,
      ]);

      setIsEditing(false);
      setEditLoading(false);
    } catch (e) {
      console.error(e);
      setActionError("Unexpected error saving changes.");
      setEditLoading(false);
    }
  };

  const handleUndoEvent = async (ev: ReviewEvent) => {
    if (!adminUserId) {
      setActionError("Missing admin user id.");
      return;
    }
    if (!page) {
      setActionError("No page loaded.");
      return;
    }
    if (ev.action !== "admin_edited") {
      return;
    }

    const supabase = supabaseBrowser();

    try {
      setUndoLoadingId(ev.id);
      setActionError(null);

      const previousTitle = ev.previous_title ?? page.title;
      const previousContent =
        ev.previous_content_markdown ?? page.content_markdown;

      const { error: updateError } = await supabase
        .from("info_pages")
        .update({
          title: previousTitle,
          content_markdown: previousContent,
        })
        .eq("id", page.id);

      if (updateError) {
        console.error(updateError);
        setActionError("Failed to undo changes.");
        setUndoLoadingId(null);
        return;
      }

      const { error: logError } = await supabase
        .from("info_page_review_events")
        .insert({
          info_page_id: page.id,
          action: "admin_undo_edit",
          performed_by: adminUserId,
          previous_title: page.title,
          previous_content_markdown: page.content_markdown,
          new_title: previousTitle,
          new_content_markdown: previousContent,
          notes: `Undid edit event ${ev.id}`,
        });

      if (logError) {
        console.error(logError);
      }

      const updatedPage: InfoPage = {
        ...page,
        title: previousTitle,
        content_markdown: previousContent,
      };
      setPage(updatedPage);

      setEvents((prev) => [
        {
          id: crypto.randomUUID?.() ?? `local-undo-${Date.now()}`,
          action: "admin_undo_edit",
          performed_by: adminUserId,
          created_at: new Date().toISOString(),
          previous_title: page.title,
          new_title: previousTitle,
          previous_content_markdown: page.content_markdown,
          new_content_markdown: previousContent,
          notes: `Undid edit event ${ev.id}`,
        },
        ...prev,
      ]);

      setUndoLoadingId(null);
    } catch (e) {
      console.error(e);
      setActionError("Unexpected error undoing changes.");
      setUndoLoadingId(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-brand-text">
        <p>Loading submission...</p>
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-brand-text">
        <h1 className="mb-2 text-xl font-semibold">Admin Only</h1>
        <p className="text-sm text-brand-textMuted">{error}</p>
      </div>
    );
  }

  if (!page) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 text-brand-text">
        <p className="text-sm text-brand-textMuted">
          Could not find that submission.
        </p>
      </div>
    );
  }

  const status = page.status;
  const statusLabel =
    status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

  let statusClasses = "border-zinc-700 bg-black/40 text-brand-text";
  if (status === "pending") {
    statusClasses = "border-yellow-500/40 bg-yellow-500/10 text-yellow-100";
  } else if (status === "approved") {
    statusClasses =
      "border-emerald-500/40 bg-emerald-500/10 text-emerald-100";
  } else if (status === "rejected") {
    statusClasses = "border-red-500/40 bg-red-500/10 text-red-100";
  }

  const displayCategory = page.category ?? "maintenance-general";
  const displayChassis = page.chassis ?? "general";
  const displayTags = page.tags ?? [];

  const categoryLabel = prettyCategoryLabel(displayCategory);

  // button styles (lighter fills + outline, matching your other colored buttons)
  const btnBase =
    "inline-flex items-center justify-center rounded-full px-3 py-1 text-[11px] font-medium transition disabled:opacity-60 disabled:cursor-not-allowed";
  const btnApprove =
    btnBase +
    " border border-emerald-400/80 bg-emerald-500/20 text-emerald-200 hover:bg-emerald-500/30 hover:border-emerald-300/90";
  const btnDeny =
    btnBase +
    " border border-red-400/80 bg-red-500/20 text-red-200 hover:bg-red-500/30 hover:border-red-300/90";
  const btnForward =
    btnBase +
    " border border-sky-400/80 bg-sky-500/20 text-sky-200 hover:bg-sky-500/30 hover:border-sky-300/90";
  const btnNeutral =
    btnBase +
    " border border-zinc-700 bg-black/40 text-brand-textMuted hover:border-brand-primary/60 hover:bg-black/55 hover:text-brand-text";

  // (headings + noteCount are memoized above; do not redeclare them here)

  const notesDisabled =
    actionLoading !== null || editLoading || undoLoadingId !== null;

  const actionDisabled =
    actionLoading !== null || editLoading || undoLoadingId !== null;

  const hasAnyRelatedNotes = notesWithContent.length > 0;

  
return (
  <div className="mx-auto max-w-6xl px-4 py-8">
    <div className="mb-3">
      <Link
        href="/staff/info/pending"
        className="text-[12px] underline underline-offset-2 text-amber-300 hover:text-amber-200"
      >
        ← Back to pending submissions
      </Link>
    </div>

    <div className="mb-6">
      <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Admin • Info</p>
      <h1 className="text-2xl font-semibold text-brand-text">Review pending page</h1>
      <p className="mt-1 text-[12px] text-brand-textMuted">
        <span className="text-brand-text">{page.title}</span>
        <span className="text-brand-textMuted"> • </span>
        Submitted by {submitterLabel}
      </p>
    </div>

    {actionError && (
      <div className="mb-4 rounded-xl border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-200">
        {actionError}
      </div>
    )}

    <div className="grid gap-6 md:grid-cols-[1fr,340px]">
      {/* Main preview (styled close to live /info page) */}
      <div className="space-y-6">
        <div className="rounded-2xl border border-zinc-800/80 bg-black/30 p-5">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Proposed</p>
              <div className="mt-1 text-lg font-semibold text-brand-text">{page.title}</div>
              <div className="text-[12px] text-brand-textMuted">/{page.slug}</div>
            </div>
            <div className="text-[12px] text-brand-textMuted">
              Category: {page.category ?? "—"} • Chassis: {page.chassis ?? "—"}
            </div>
          </div>

          {Array.isArray(page.tags) && page.tags.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1">
              {page.tags.map((t) => (
                <span
                  key={t}
                  className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted"
                >
                  {t}
                </span>
              ))}
            </div>
          )}

          <div className="mt-4 grid gap-6 md:grid-cols-3">
            <div className="min-w-0 md:col-span-2">
              <MarkdownContent markdown={page.content_markdown} />
            </div>

            <div className="space-y-3 md:col-span-1">
              {/* Author card (match /info/[id]) */}
              {submitterProfile ? (
                <Link
                  href={`/user/${submitterProfile.id}`}
                  className="block rounded-lg border border-zinc-800/80 bg-black/40 p-3 hover:border-zinc-700"
                >
                  <div className="flex items-start gap-3">
                    <div className="h-12 w-12 shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {submitterProfile.avatar_url ? (
                        <img
                          src={submitterProfile.avatar_url}
                          alt={submitterProfile.display_name ?? submitterProfile.username ?? "Author"}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-zinc-400">
                          <span className="text-lg">
                            {((submitterProfile.display_name ?? submitterProfile.username ?? "?")[0] || "?").toUpperCase()}
                          </span>
                        </div>
                      )}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex min-w-0 items-center gap-1 truncate text-[13px] font-semibold text-zinc-100">
                          <span className="truncate">
                            {submitterProfile.display_name || submitterProfile.username || "Unknown"}
                          </span>
                          {submitterProfile.is_verified ? <VerifiedBadge className="h-3 w-3" /> : null}
                          {submitterProfile.donation_rank ? (
                            <DonationBadge rank={submitterProfile.donation_rank} className="h-3 w-3" />
                          ) : null}
                        </div>
                        <RolePill role={submitterRole ?? "member"} />
                      </div>
                      {submitterProfile.username ? (
                        <div className="truncate text-[11px] text-brand-textMuted">@{submitterProfile.username}</div>
                      ) : null}
                    </div>
                  </div>
                </Link>
              ) : (
                <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3">
                  <p className="text-[12px] text-brand-textMuted">Author</p>
                  <p className="mt-1 text-sm text-brand-text">{submitterLabel}</p>
                </div>
              )}

              {/* Table of contents (match /info/[id]) */}
              <div className="rounded-lg border border-zinc-800/80 bg-black/40 p-3 text-[12px]">
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-brand-textMuted">
                  Table of contents
                </h2>

                {headings.length === 0 ? (
                  <p className="text-[11px] text-brand-textMuted">This page has no headings yet.</p>
                ) : (
                  <ul className="space-y-1 text-[12px]">
                    {headings.map((h) => (
                      <li
                        key={h.id}
                        className={
                          (h.level === 1
                            ? "font-semibold"
                            : h.level === 2
                            ? "pl-2"
                            : "pl-4") + " leading-snug"
                        }
                      >
                        <a href={`#${h.id}`} className="text-brand-textMuted hover:text-brand-primary">
                          {h.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Sidebar actions */}
      <aside className="space-y-4">
        <div className="rounded-2xl border border-zinc-800/80 bg-black/40 p-4">
          <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Review</p>
          <div className="mt-2 space-y-2 text-[12px] text-brand-textMuted">
            <div>
              Submitted: <span className="text-brand-text">{new Date(page.created_at).toLocaleString()}</span>
            </div>
            <div>
              Status: <span className="text-brand-text">{page.status}</span>
            </div>
          </div>

          <p className="mt-4 text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Admin notes (optional)</p>
          <textarea
            value={reviewNotes}
            onChange={(e) => setReviewNotes(e.target.value)}
            rows={3}
            disabled={actionLoading !== null || editLoading || undoLoadingId !== null}
            className="ui-input mt-2 text-sm"
            placeholder="Why did you approve/deny/forward this?"
          />

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => void handleAction("note")}
              className="ui-btn ui-btn-ghost text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionLoading === "note" ? "Saving note..." : "Save note"}
            </button>

            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => (isEditing ? handleCancelEdit() : handleStartEdit())}
              className={`ui-btn text-[12px] disabled:cursor-not-allowed disabled:opacity-60 ${isEditing ? "ui-btn-secondary" : "ui-btn-ghost"}`}
            >
              {isEditing ? "Close editor" : "Edit content / meta"}
            </button>
          </div>

          {isEditing && (
            <div className="mt-3 space-y-2 rounded-xl border border-zinc-800/80 bg-black/30 p-3">
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">Title</span>
                <input
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="ui-input text-sm"
                />
              </label>
              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">Slug</span>
                <input
                  value={editSlug}
                  onChange={(e) => setEditSlug(e.target.value)}
                  className="ui-input text-sm"
                />
              </label>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">Category</span>
                  <MenuSelect
                    ariaLabel="Category"
                    value={editCategory}
                    onChange={(next) => setEditCategory(next)}
                    className="ui-select-trigger h-10 text-sm"
                    options={CATEGORY_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                  />
                </label>
                <label className="space-y-1">
                  <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">Chassis</span>
                  <MenuSelect
                    ariaLabel="Chassis"
                    value={editChassis}
                    onChange={(next) => setEditChassis(next)}
                    className="ui-select-trigger h-10 text-sm"
                    options={CHASSIS_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                  />
                </label>
              </div>

              <label className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">Tags (comma-separated)</span>
                <input
                  value={editTagsInput}
                  onChange={(e) => setEditTagsInput(e.target.value)}
                  className="ui-input text-sm"
                />
              </label>

              {/* Match /staff/info/updates/[id] label sizing + spacing */}
              <div className="space-y-1">
                <span className="text-[11px] uppercase tracking-[0.12em] text-brand-textMuted">
                  Proposed content (markdown)
                </span>
                <MarkdownEditor
                  id="content_markdown"
                  value={editContent}
                  onChange={setEditContent}
                  helperText="Use markdown for headings, links, images, lists, etc."
                  rows={10}
                />
              </div>

              <div className="flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={editLoading}
                  onClick={() => void handleSaveEdit()}
                  className="ui-btn ui-btn-primary text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {editLoading ? "Saving..." : "Save edits"}
                </button>
              </div>
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => void handleAction("approve")}
              className="ui-btn ui-btn-primary text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionLoading === "approve" ? "Approving..." : "Approve"}
            </button>

            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => void handleAction("deny")}
              className="ui-btn ui-btn-danger text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionLoading === "deny" ? "Denying..." : "Deny"}
            </button>

            <button
              type="button"
              disabled={actionDisabled}
              onClick={() => void handleAction("forward")}
              className="ui-btn ui-btn-secondary text-[12px] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {actionLoading === "forward" ? "Submitting..." : "Submit for further review"}
            </button>

            <Link
              href={`/projects/${encodeURIComponent(page.slug)}`}
              className="ui-btn ui-btn-ghost ml-auto text-[12px]"
            >
              View live
            </Link>
          </div>

          <div className="mt-4 border-t border-zinc-800/80 pt-4">
            {noteEvents.length > 0 && (
              <div className="mb-4">
                <div className="flex items-baseline justify-between gap-2">
                <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Notes</p>
                <p className="text-[11px] text-brand-textMuted">{noteCount === 1 ? "1 note" : `${noteCount} notes`}</p>
                </div>
                <div className="mt-2 space-y-2">
                  {noteEvents.map((ev) => {
                    const performerLabel = ev.performed_by
                      ? adminUserId && ev.performed_by === adminUserId
                        ? "You"
                        : usernamesById[ev.performed_by] || ev.performed_by
                      : "Admin";

                    return (
                      <div key={ev.id} className="rounded-xl border border-zinc-800/80 bg-black/30 p-3">
                        <p className="text-[11px] text-brand-textMuted">
                          {performerLabel} • {new Date(ev.created_at).toLocaleString()}
                        </p>
                        {ev.notes ? (
                          <p className="mt-2 whitespace-pre-wrap text-[12px] text-brand-textMuted">{ev.notes}</p>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div className="flex items-baseline justify-between gap-2">
              <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Review history</p>
              <p className="text-[11px] text-brand-textMuted">{reviewEvents.length} event{reviewEvents.length === 1 ? "" : "s"}</p>
            </div>

            {reviewEvents.length === 0 ? (
              <p className="mt-2 text-[12px] text-brand-textMuted">No review history yet.</p>
            ) : (
              <div className="mt-2 space-y-2">
                {reviewEvents.map((ev) => {
                  const performerLabel = ev.performed_by
                    ? adminUserId && ev.performed_by === adminUserId
                      ? "You"
                      : usernamesById[ev.performed_by] || ev.performed_by
                    : "Admin";

                  return (
                    <div key={ev.id} className="rounded-xl border border-zinc-800/80 bg-black/30 p-3">
                      <div className="min-w-0">
                        <p className="text-[12px] font-semibold text-brand-text">
                          {ACTION_LABELS[ev.action] ?? ev.action}
                        </p>
                        <p className="text-[11px] text-brand-textMuted">
                          {performerLabel} • {new Date(ev.created_at).toLocaleString()}
                        </p>
                      </div>
                      {ev.notes && ev.notes.trim().length > 0 ? (
                        <p className="mt-2 whitespace-pre-wrap text-[12px] text-brand-textMuted">{ev.notes}</p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  </div>
);
}
