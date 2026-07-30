"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { MenuSelect } from "@/components/ui/MenuSelect";

type InfoPage = {
  id: string;
  title: string;
  slug: string;
  content_markdown: string;
  created_at: string;
  status: string;
  category: string | null;
  chassis: string | null;
  tags: string[] | null;
};

type RoleResult = {
  role: string;
};

type ReviewMeta = {
  notesCount: number;
  revisionsCount: number;
  forwarded: boolean;
  lastEditedAt: string | null;
  lastEditedBy: string | null;
};

type ReviewEventRow = {
  info_page_id: string;
  action: string;
  notes: string | null;
  performed_by: string | null;
  created_at: string;
};

type SortMode =
  | "created_newest"
  | "created_oldest"
  | "revisions_desc"
  | "notes_desc";

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

const STATUS_FILTER_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "all", label: "All statuses" },
] as const;

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

export default function AdminInfoPendingListPage() {
  const [loading, setLoading] = useState(true);
  const [adminUserId, setAdminUserId] = useState<string | null>(null);
  const [pages, setPages] = useState<InfoPage[]>([]);
  const [pendingCount, setPendingCount] = useState<number>(0);
  const [updatesPendingCount, setUpdatesPendingCount] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const [metaById, setMetaById] = useState<Record<string, ReviewMeta>>({});

  const [searchTerm, setSearchTerm] = useState("");
  const [showForwardedOnly, setShowForwardedOnly] = useState(false);
  const [sortMode, setSortMode] = useState<SortMode>("created_newest");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("pending");

  const { data: access, isLoading: accessLoading } = useMeAccess();
  // Page access is .view-only. Moderation permissions do NOT imply visibility.
  const canView = Boolean(access?.permissions?.includes("info.pending.view"));
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  // Pagination: show 10 at a time
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

      const res = await fetch(`/api/staff/info/pending?status=${encodeURIComponent(statusFilter)}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
      });

      const j = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        setError((j && typeof j.error === "string" && j.error) || "Failed to load submissions.");
        setLoading(false);
        return;
      }

      setPages((j?.pages ?? []) as InfoPage[]);
      setMetaById((j?.metaById ?? {}) as Record<string, ReviewMeta>);
      setPendingCount(typeof j?.pendingCount === "number" ? j.pendingCount : 0);
      setUpdatesPendingCount(typeof j?.updatesPendingCount === "number" ? j.updatesPendingCount : 0);

      setLoading(false);
    };

    void load();
  }, [statusFilter, accessLoading, canView]);

  if (loading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
        <p>Loading submissions...</p>
      </div>
    );
  }

  if (!canView) {
    return (
      <AccessDeniedCard
        title="Info • Pending"
        message={error ?? "You do not have permission to view this page."}
        backHref="/staff"
        backLabel="Back to Staff"
      />
    );
  }

  // --- Filter pipeline (status already applied in query) ---

  let filtered = pages;

  if (categoryFilter !== "all") {
    filtered = filtered.filter(
      (p) =>
        p.status === "pending" && (p.category ?? "") === categoryFilter
    );
  }

  if (showForwardedOnly) {
    filtered = filtered.filter(
      (p) => metaById[p.id]?.forwarded === true
    );
  }

  const trimmedSearch = searchTerm.trim().toLowerCase();

  let sorted: InfoPage[];

  if (trimmedSearch) {
    // SEARCH MODE: rank by relevance, don't hide non-matches
    const tokens: string[] = [];
    for (const part of trimmedSearch.split(/\s+/)) {
      const t = part.trim();
      if (!t) continue;
      tokens.push(t);
    }

    const annotated = filtered.map((p) => {
      const title = p.title.toLowerCase();
      const slug = p.slug.toLowerCase();
      const content = p.content_markdown.toLowerCase();
      const category = (p.category ?? "").toLowerCase();
      const chassis = (p.chassis ?? "").toLowerCase();
      const tagsJoined = (p.tags ?? []).join(" ").toLowerCase();

      let score = 0;
      let matchedTokens = 0;

      for (const token of tokens) {
        let tokenScore = 0;
        let matchedThisToken = false;

        if (title.includes(token)) {
          tokenScore += 12;
          matchedThisToken = true;
        }
        if (slug.includes(token)) {
          tokenScore += 8;
          matchedThisToken = true;
        }
        if (tagsJoined.includes(token)) {
          tokenScore += 10;
          matchedThisToken = true;
        }
        if (category.includes(token)) {
          tokenScore += 6;
          matchedThisToken = true;
        }
        if (chassis.includes(token)) {
          tokenScore += 7;
          matchedThisToken = true;
        }
        if (content.includes(token)) {
          tokenScore += 4;
          matchedThisToken = true;
        }

        if (tokenScore > 18) tokenScore = 18;

        if (matchedThisToken) {
          matchedTokens += 1;
          score += tokenScore;
        }
      }

      score += matchedTokens * 20;

      return { page: p, score };
    });

    annotated.sort((a, b) => b.score - a.score);
    sorted = annotated.map((a) => a.page);
  } else {
    // NO SEARCH: use sort modes
    sorted = [...filtered].sort((a, b) => {
      const metaA = metaById[a.id];
      const metaB = metaById[b.id];

      if (sortMode === "created_newest") {
        return (
          new Date(b.created_at).getTime() -
          new Date(a.created_at).getTime()
        );
      } else if (sortMode === "created_oldest") {
        return (
          new Date(a.created_at).getTime() -
          new Date(b.created_at).getTime()
        );
      } else if (sortMode === "revisions_desc") {
        const revA = metaA?.revisionsCount ?? 0;
        const revB = metaB?.revisionsCount ?? 0;
        return revB - revA;
      } else if (sortMode === "notes_desc") {
        const nA = metaA?.notesCount ?? 0;
        const nB = metaB?.notesCount ?? 0;
        return nB - nA;
      }

      return 0;
    });
  }

  const visiblePages = sorted.slice(0, visibleCount);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8 text-brand-text">
      {/* Header */}
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
            Staff • Info
        </p>

        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
            Pending & in-review submissions
        </h1>

        <p className="text-[12px] text-brand-textMuted sm:text-sm">
            Review new info pages, add notes, forward for a second opinion, and approve or reject.
        </p>

        <div className="mt-1 text-[11px] text-brand-textMuted">
          <Link
            href="/staff"
            className="text-amber-300 underline underline-offset-2 hover:text-amber-200"
          >
            ← Back to admin overview
          </Link>
        </div>

        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Link
            href="/staff/info/pending"
            className="rounded-full border border-amber-400/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-200"
            aria-current="page"
          >
            Pending ({pendingCount})
          </Link>

          <Link
            href="/staff/info/updates"
            className="rounded-full border border-zinc-700 bg-black/30 px-4 py-2 text-xs text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
          >
            Updates ({updatesPendingCount})
          </Link>
        </div>

        {/* Keep this header minimal so /staff/info/pending and /staff/info/updates match. */}
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
            placeholder="Search by title, slug, content, tag, or chassis..."
            className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-3 py-1.5 text-xs text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400 md:w-72"
          />

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <MenuSelect
              ariaLabel="Status"
              value={statusFilter as any}
              onChange={(v) => {
                setStatusFilter(v as StatusFilter);
                setVisibleCount(10);
              }}
              options={STATUS_FILTER_OPTIONS as any}
              className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-2 text-[11px] text-brand-text outline-none transition hover:border-amber-400"
              menuClassName="mt-2 w-56 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              align="left"
            />

            <MenuSelect
              ariaLabel="Category"
              value={categoryFilter as any}
              onChange={(v) => {
                setCategoryFilter(v as string);
                setVisibleCount(10);
              }}
              options={([
                { value: "all", label: "All categories (pending)" },
                ...CATEGORY_FILTER_OPTIONS.map((c) => ({ value: c.value, label: c.label })),
              ] as const) as any}
              className="flex h-8 items-center gap-2 rounded-md border border-zinc-700 bg-black/40 px-2 text-[11px] text-brand-text outline-none transition hover:border-amber-400"
              menuClassName="mt-2 w-64 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              align="left"
            />

            <button
              type="button"
              onClick={() => {
                setShowForwardedOnly((prev) => !prev);
                setVisibleCount(10);
              }}
              className={
                "rounded-full border px-2 py-0.5 " +
                (showForwardedOnly
                  ? "border-amber-400 bg-amber-500/20 text-amber-300 shadow-sm shadow-black/40"
                  : "border-zinc-700 bg-black/40 text-brand-textMuted hover:border-amber-400/60 hover:text-brand-text")
              }
            >
              Needs further review
            </button>

            <div className="flex h-8 items-center gap-1 rounded-full border border-zinc-700 bg-black/40 p-0.5">
              <SortChip
                active={sortMode === "created_newest"}
                onClick={() => {
                  setSortMode("created_newest");
                  setVisibleCount(10);
                }}
              >
                Newest
              </SortChip>
              <SortChip
                active={sortMode === "created_oldest"}
                onClick={() => {
                  setSortMode("created_oldest");
                  setVisibleCount(10);
                }}
              >
                Oldest
              </SortChip>
              <SortChip
                active={sortMode === "revisions_desc"}
                onClick={() => {
                  setSortMode("revisions_desc");
                  setVisibleCount(10);
                }}
              >
                Most revisions
              </SortChip>
              <SortChip
                active={sortMode === "notes_desc"}
                onClick={() => {
                  setSortMode("notes_desc");
                  setVisibleCount(10);
                }}
              >
                Most notes
              </SortChip>
            </div>
          </div>
        </div>

        <div className="text-[11px] text-brand-textMuted">
          {sorted.length === 0 ? (
            <span>No submissions match your filters.</span>
          ) : (
            <span>
              Showing {visiblePages.length} of {sorted.length} submission
              {sorted.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </section>
      {/* List */}
      {/* Match Shops/Community: no large wrapper panel; each submission is its own card */}
      <section className="space-y-3">
        {sorted.length === 0 ? (
          <p className="text-[12px] text-brand-textMuted">
            Nothing here right now. Check back after new submissions come in.
          </p>
        ) : (
          <>
            <div className="space-y-4">
              {visiblePages.map((page) => {
                const snippet =
                  page.content_markdown.length > 220
                    ? page.content_markdown.slice(0, 220) + "…"
                    : page.content_markdown;

                const meta: ReviewMeta =
                  metaById[page.id] || {
                    notesCount: 0,
                    revisionsCount: 0,
                    forwarded: false,
                    lastEditedAt: null,
                    lastEditedBy: null,
                  };

                const status = (page.status ?? "").toLowerCase();

                const notesColor =
                  meta.notesCount > 0
                    ? "text-amber-300"
                    : "text-brand-textMuted";
                const revisionsColor =
                  meta.revisionsCount > 0
                    ? "text-brand-primary"
                    : "text-brand-textMuted";

                let lastEditedLabel = "";
                if (meta.lastEditedAt) {
                  const by =
                    adminUserId && meta.lastEditedBy === adminUserId
                      ? "You"
                      : meta.lastEditedBy ?? "";
                  const when = new Date(
                    meta.lastEditedAt
                  ).toLocaleString();
                  lastEditedLabel = by ? `${by} • ${when}` : when;
                }

                const tagChips = (page.tags ?? []).slice(0, 3);

                return (
                  <div
                    key={page.id}
                    onClick={() => router.push(`/staff/info/pending/${page.id}`)}
                    className="group cursor-pointer rounded-2xl border border-zinc-800 bg-black/35 p-4 transition hover:border-amber-400/60 hover:bg-black/45"
                  >
                    <div className="mb-2 flex items-start justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold group-hover:text-brand-primary">
                          {page.title}
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
                              key={`${page.id}-${tag}`}
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

                    <p className="mb-3 text-xs text-brand-textMuted">
                      {snippet}
                    </p>

                    <div className="flex flex-wrap items-center gap-4 text-[11px]">
                      <span
                        className={`inline-flex items-center gap-1 ${notesColor}`}
                      >
                        <NoteIcon className="h-3 w-3" />
                        <span>{meta.notesCount} notes</span>
                      </span>
                      <span
                        className={`inline-flex items-center gap-1 ${revisionsColor}`}
                      >
                        <HistoryIcon className="h-3 w-3" />
                        <span>{meta.revisionsCount} revisions</span>
                      </span>
                    </div>

                    <div className="mt-1 flex items-center justify-between text-[10px] text-brand-textMuted">
                      <span>
                        {lastEditedLabel
                          ? `Last admin action: ${lastEditedLabel}`
                          : "No admin actions yet"}
                      </span>
                      <span>
                        Created:{" "}
                        {new Date(page.created_at).toLocaleString()}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 flex flex-col items-center gap-2">
              <div className="text-[11px] text-brand-textMuted">
                Showing {Math.min(visibleCount, sorted.length)} out of {sorted.length}
              </div>

              {sorted.length > visibleCount ? (
                <button
                  type="button"
                  onClick={() =>
                    setVisibleCount((prev) => prev + 20)
                  }
                  className="inline-flex items-center justify-center rounded-full border border-zinc-700 bg-black/60 px-4 py-1.5 text-[12px] text-brand-textMuted hover:border-brand-primary/70 hover:text-brand-text"
                >
                  Show more (
                  {Math.min(sorted.length - visibleCount, 20)} more)
                </button>
              ) : null}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SortChip({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex h-7 items-center rounded-full px-3 text-[11px] " +
        (active
          ? "bg-amber-500/20 text-amber-300 border border-amber-400/80"
          : "text-brand-textMuted hover:text-brand-text")
      }
    >
      {children}
    </button>
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
