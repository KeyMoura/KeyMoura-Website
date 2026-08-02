"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { LinkTabs } from "@/components/ui/LinkTabs";
import { SegmentedControl } from "@/components/ui/SegmentedControl";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";

// NOTE: This list page is intentionally styled/layouted to match
// /staff/info/pending exactly, but it lists *updates* instead of new submissions.

type InfoPageLite = {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  chassis: string | null;
  tags: string[] | null;
};

type InfoUpdate = {
  id: string;
  info_page_id: string;
  created_by: string;
  created_at: string;
  status: string;
  proposed_title: string | null;
  info_pages: InfoPageLite | null;
};

type ReviewMeta = {
  notesCount: number;
  revisionsCount: number;
  forwarded: boolean;
  lastEditedAt: string | null;
  lastEditedBy: string | null;
};

type UpdatesResponse = {
  error?: string;
  updates?: InfoUpdate[];
  metaByPageId?: Record<string, ReviewMeta>;
  pendingCount?: number;
  updatesPendingCount?: number;
};

type SortMode = "created_newest" | "created_oldest" | "revisions_desc" | "notes_desc";
type StatusFilter = "pending" | "approved" | "rejected" | "all";

const CATEGORY_FILTER_OPTIONS: { value: string; label: string }[] = [
  { value: "oem-manuals", label: "OEM Literature" },
  { value: "maintenance-general", label: "Maintenance & General" },
  { value: "chassis-suspension", label: "Chassis & Suspension" },
  { value: "engine-drivetrain", label: "Engine & Drivetrain" },
  { value: "wheels-brakes", label: "Wheels & Brakes" },
  { value: "electronics-wiring", label: "Electronics & Wiring" },
  { value: "body-interior", label: "Body & Interior" },
];

const CATEGORY_LABELS: Record<string, string> = {
  "oem-manuals": "OEM Literature",
  "maintenance-general": "Maintenance / General",
  "chassis-suspension": "Chassis & Suspension",
  "engine-drivetrain": "Engine & Drivetrain",
  "wheels-brakes": "Wheels & Brakes",
  "electronics-wiring": "Electronics & Wiring",
  "body-interior": "Body & Interior",
};

function getCategoryLabel(value: string | null): string {
  if (!value) return "Uncategorized";
  return CATEGORY_LABELS[value] ?? value;
}

export default function AdminInfoUpdatesListPage() {
  const [loading, setLoading] = useState(true);
  const [adminUserId, setAdminUserId] = useState<string | null>(null);
  const [updates, setUpdates] = useState<InfoUpdate[]>([]);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [updatesPendingCount, setUpdatesPendingCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [metaByPageId, setMetaByPageId] = useState<Record<string, ReviewMeta>>({});

  const [searchTerm, setSearchTerm] = useState("");
  const [showForwardedOnly, setShowForwardedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("created_newest");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const { data: access, isLoading: accessLoading } = useMeAccess();
  // Page access: explicit .view OR full info moderation.
  const canView = Boolean(
    access?.permissions?.includes("info.updates.view") || access?.permissions?.includes("info.moderate")
  );

  // Pagination: show 10 at a time (matches pending)
  const [visibleCount, setVisibleCount] = useState(20);

  const router = useRouter();

  useEffect(() => {
    const load = async () => {
      const supabase = supabaseBrowser();

      setLoading(true);
      setError(null);

      if (accessLoading) return;
      if (!canView) {
        setError("Access denied.");
        setLoading(false);
        return;
      }

      // 1) Get current user
      const {
        data: { user },
        error: userError,
      } = await supabase.auth.getUser();

      if (userError || !user) {
        setError("You must be logged in.");
        setLoading(false);
        return;
      }
      setAdminUserId(user.id);

      // Use a service-backed route for staff tools so RLS doesn't silently return empty lists.
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        setError("You must be logged in.");
        setLoading(false);
        return;
      }

      const res = await fetch(`/api/staff/info/updates?status=${encodeURIComponent(statusFilter)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      const j = (await res.json().catch(() => null)) as UpdatesResponse | null;
      if (!res.ok) {
        setError((j && typeof j.error === "string" && j.error) || "Failed to load updates.");
        setLoading(false);
        return;
      }

      setUpdates(j?.updates ?? []);
      setMetaByPageId((j?.metaByPageId ?? {}) as Record<string, ReviewMeta>);
      setPendingCount(typeof j?.pendingCount === "number" ? j.pendingCount : 0);
      setUpdatesPendingCount(typeof j?.updatesPendingCount === "number" ? j.updatesPendingCount : 0);

      setLoading(false);
    };

    void load();
  }, [statusFilter, accessLoading, canView]);

  const normalizedQuery = searchTerm.trim().toLowerCase();

  const filtered = updates
    .filter((u) => {
      const page = u.info_pages;
      if (!page) return false;

      // Category filter
      if (categoryFilter !== "all" && String(page.category ?? "") !== categoryFilter) {
        return false;
      }

      // Forwarded filter (based on underlying page review state)
      if (showForwardedOnly) {
        const meta = metaByPageId[u.info_page_id];
        if (!meta || !meta.forwarded) return false;
      }

      // Search filter
      if (!normalizedQuery) return true;

      const title = (u.proposed_title ?? page.title ?? "").toLowerCase();
      const slug = (page.slug ?? "").toLowerCase();
      const tags = (page.tags ?? []).join(" ").toLowerCase();

      return title.includes(normalizedQuery) || slug.includes(normalizedQuery) || tags.includes(normalizedQuery);
    })
    .sort((a, b) => {
      if (sortMode === "created_oldest") {
        return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      }
      if (sortMode === "created_newest") {
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      }

      // revisions_desc / notes_desc: sort by underlying page meta
      const aMeta = metaByPageId[a.info_page_id] ?? {
        notesCount: 0,
        revisionsCount: 0,
        forwarded: false,
        lastEditedAt: null,
        lastEditedBy: null,
      };
      const bMeta = metaByPageId[b.info_page_id] ?? {
        notesCount: 0,
        revisionsCount: 0,
        forwarded: false,
        lastEditedAt: null,
        lastEditedBy: null,
      };

      if (sortMode === "revisions_desc") {
        if (bMeta.revisionsCount !== aMeta.revisionsCount) {
          return bMeta.revisionsCount - aMeta.revisionsCount;
        }
      }

      if (sortMode === "notes_desc") {
        if (bMeta.notesCount !== aMeta.notesCount) {
          return bMeta.notesCount - aMeta.notesCount;
        }
      }

      // fallback newest
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  const visible = filtered.slice(0, visibleCount);

  if (loading) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-10">
        <div className="rounded-xl border border-zinc-800 bg-black/40 p-6">
          <div className="text-sm text-brand-textMuted">Loading…</div>
        </div>
      </div>
    );
  }

  if (!canView) {
    return (
      <AccessDeniedCard
        title="Info • Updates"
        message={error ?? "You do not have permission to view this page."}
        backHref="/staff"
        backLabel="Back to Staff"
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-brand-text">
      {/* Header */}
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Staff • Info
        </p>

        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
          Pending update submissions
        </h1>

        <p className="text-[12px] text-brand-textMuted sm:text-sm">
          Review updates submitted against existing info pages, add notes, forward for a second opinion, and approve or reject.
        </p>

        <div className="mt-1 text-[11px] text-brand-textMuted">
          <Link
            href="/staff"
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
          >
            ← Back to admin overview
          </Link>
        </div>

        <LinkTabs
          className="mt-3"
          ariaLabel="Info moderation queues"
          tabs={[
            { href: "/staff/info/pending", label: `Pending (${pendingCount})` },
            { href: "/staff/info/updates", label: `Updates (${updatesPendingCount})`, active: true },
          ]}
        />
      </section>

      {/* Filters & search */}
      <section className="space-y-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => {
              setSearchTerm(e.target.value);
              setVisibleCount(10);
            }}
            placeholder="Search by page title, slug, proposal content, or tags…"
            className="ui-input no-zoom-input text-xs md:w-72"
          />

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <MenuSelect
              ariaLabel="Status"
              value={statusFilter}
              onChange={(next) => {
                setStatusFilter(next as StatusFilter);
                setVisibleCount(10);
              }}
              className="ui-select-trigger h-8 text-[11px]"
              options={[
                { value: "pending", label: "Pending" },
                { value: "approved", label: "Approved" },
                { value: "rejected", label: "Rejected" },
                { value: "all", label: "All statuses" },
              ]}
            />

            <MenuSelect
              ariaLabel="Category"
              value={categoryFilter}
              onChange={(next) => {
                setCategoryFilter(next);
                setVisibleCount(10);
              }}
              className="ui-select-trigger h-8 text-[11px]"
              options={[
                { value: "all", label: "All categories" },
                ...CATEGORY_FILTER_OPTIONS.map((c) => ({ value: c.value, label: c.label })),
              ]}
            />

            <button
              type="button"
              onClick={() => {
                setShowForwardedOnly((prev) => !prev);
                setVisibleCount(10);
              }}
              aria-pressed={showForwardedOnly}
              className={`ui-chip ${showForwardedOnly ? "is-active" : ""}`}
            >
              Needs further review
            </button>

            <SegmentedControl
              value={sortMode}
              onChange={(next) => { setSortMode(next); setVisibleCount(10); }}
              ariaLabel="Sort updates"
              options={[
                { value: "created_newest", label: "Newest" },
                { value: "created_oldest", label: "Oldest" },
                { value: "revisions_desc", label: "Revisions" },
                { value: "notes_desc", label: "Notes" },
              ]}
            />
          </div>
        </div>

        <div className="text-[11px] text-brand-textMuted">
          {filtered.length === 0 ? (
            <span>No updates match your filters.</span>
          ) : (
            <span>
              Showing {visible.length} of {filtered.length} update
              {filtered.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </section>

      {/* List (match /staff/info/pending) */}
      {/* Match Shops/Community: no large wrapper panel; each update is its own card */}
      <section className="space-y-3">
        {filtered.length === 0 ? (
          <p className="text-[12px] text-brand-textMuted">
            Nothing here right now. Check back after new update submissions come in.
          </p>
        ) : (
          <>
            <div className="space-y-4">
              {visible.map((u) => {
                const page = u.info_pages;
                if (!page) return null;

                const meta: ReviewMeta =
                  metaByPageId[u.info_page_id] || {
                    notesCount: 0,
                    revisionsCount: 0,
                    forwarded: false,
                    lastEditedAt: null,
                    lastEditedBy: null,
                  };

                const status = (u.status ?? "").toLowerCase();

                const notesColor =
                  meta.notesCount > 0 ? "text-amber-300" : "text-brand-textMuted";
                const revisionsColor =
                  meta.revisionsCount > 0 ? "text-brand-primary" : "text-brand-textMuted";

                let lastEditedLabel = "";
                if (meta.lastEditedAt) {
                  const by =
                    adminUserId && meta.lastEditedBy === adminUserId
                      ? "You"
                      : meta.lastEditedBy ?? "";
                  const when = new Date(meta.lastEditedAt).toLocaleString();
                  lastEditedLabel = by ? `${by} • ${when}` : when;
                }

                const displayTitle = u.proposed_title ?? page.title;
                const snippetBase =
                  u.proposed_title && u.proposed_title !== page.title
                    ? `Proposed title: ${u.proposed_title}`
                    : `Update submitted for /${page.slug}`;
                const snippet =
                  snippetBase.length > 220 ? snippetBase.slice(0, 220) + "…" : snippetBase;

                const tagChips = (page.tags ?? []).slice(0, 3);

                return (
                  <div
                    key={u.id}
                    onClick={() => router.push(`/staff/info/updates/${u.id}`)}
                    className="group cursor-pointer rounded-2xl border border-zinc-800 bg-black/35 p-4 transition hover:border-amber-400/60 hover:bg-black/45"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold group-hover:text-brand-primary">
                          {displayTitle}
                        </h2>
                        <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-brand-textMuted">
                          <span className="text-zinc-600">•</span>
                          <span className="font-mono text-[11px] text-zinc-500">/{page.slug}</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                          {page.category && (
                            <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
                              {getCategoryLabel(page.category)}
                            </span>
                          )}
                          {page.chassis && (
                            <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted">
                              {page.chassis.toUpperCase()}
                            </span>
                          )}
                          {tagChips.map((tag) => (
                            <span
                              key={`${u.id}-${tag}`}
                              className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted"
                            >
                              {tag}
                            </span>
                          ))}
                          {page.tags && page.tags.length > 3 && (
                            <span className="text-[10px] text-brand-textMuted">
                              +{page.tags.length - 3} more
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1">
                        {status === "pending" ? (
                          <span className="rounded-full bg-amber-300 px-2 py-0.5 text-[10px] font-semibold text-black">
                            PENDING
                          </span>
                        ) : status === "approved" ? (
                          <span className="rounded-full bg-emerald-400 px-2 py-0.5 text-[10px] font-semibold text-black">
                            APPROVED
                          </span>
                        ) : status === "rejected" ? (
                          <span className="rounded-full bg-rose-400 px-2 py-0.5 text-[10px] font-semibold text-black">
                            REJECTED
                          </span>
                        ) : null}

                        {meta.forwarded && (
                          <span className="inline-flex items-center gap-1 text-[10px] text-yellow-300">
                            <ExclamationIcon className="h-3 w-3" />
                            <span>Needs further review</span>
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="mb-3 text-xs text-brand-textMuted">{snippet}</p>

                    <div className="flex flex-wrap items-center gap-4 text-[11px]">
                      <span className={`inline-flex items-center gap-1 ${notesColor}`}>
                        <NoteIcon className="h-3 w-3" />
                        <span>{meta.notesCount} notes</span>
                      </span>
                      <span className={`inline-flex items-center gap-1 ${revisionsColor}`}>
                        <HistoryIcon className="h-3 w-3" />
                        <span>{meta.revisionsCount} revisions</span>
                      </span>
                    </div>

                    <div className="mt-1 flex items-center justify-between text-[10px] text-brand-textMuted">
                      <span>
                        {lastEditedLabel ? `Last admin action: ${lastEditedLabel}` : "No admin actions yet"}
                      </span>
                      <span>Created: {new Date(u.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-col items-center gap-2">
              <div className="text-[11px] text-brand-textMuted">
                Showing {Math.min(visibleCount, filtered.length)} out of {filtered.length}
              </div>

              {filtered.length > visibleCount ? (
                <button
                  type="button"
                  onClick={() => setVisibleCount((prev) => prev + 20)}
                  className="ui-btn ui-btn-ghost text-[12px]"
                >
                  Show more ({Math.min(filtered.length - visibleCount, 20)} more)
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>

    </div>
  );
}

function NoteIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M7 3h10a2 2 0 0 1 2 2v9.5L15.5 21H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <path d="M9 9h6" />
      <path d="M9 13h3" />
    </svg>
  );
}

function HistoryIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M3 12a9 9 0 1 1 3 6.7" />
      <polyline points="3 12 3 18 9 18" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function ExclamationIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <circle cx="12" cy="17" r="0.8" />
    </svg>
  );
}
