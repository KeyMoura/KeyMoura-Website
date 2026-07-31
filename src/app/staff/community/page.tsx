"use client";

type ForumThreadRow = {
  id: string;
  category_id: number;
  title: string;
  slug: string;
  is_pinned: boolean;
  is_deleted: boolean;
  created_at: string;
  last_post_at: string | null;
};
 

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import type { SupabaseClient } from "@supabase/supabase-js";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { VerifiedBadge } from "@/components/VerifiedBadge";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { MenuSelect } from "@/components/ui/MenuSelect";

type CtaVariant = "secondary" | "primary" | "danger";

const flagStatusOptions = [
  { value: "open", label: "Open" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
] as const;

function CtaButton({
  children,
  onClick,
  disabled,
  variant = "secondary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: CtaVariant;
}) {
  // Match /staff/shops CTA buttons exactly.
  const base =
    "inline-flex items-center justify-center rounded-full px-3 py-1.5 text-[12px] font-medium transition";

  const primary =
    "border border-amber-400/80 bg-amber-500/20 text-amber-200 shadow-sm shadow-black/60 hover:bg-amber-500/30 hover:border-amber-300/90";

  const secondary =
    "border border-zinc-700 bg-black/40 text-brand-textMuted hover:border-amber-400/80 hover:text-brand-text";

  const danger =
    "border border-zinc-700 bg-black/40 text-brand-textMuted hover:border-rose-400/70 hover:text-rose-200";

  const cls = variant === "primary" ? primary : variant === "danger" ? danger : secondary;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`${base} ${cls} ${disabled ? "cursor-not-allowed opacity-60" : ""}`}
    >
      {children}
    </button>
  );
}

type ForumCategoryRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_archived: boolean;
  created_at: string;
  parent_id: number | null;
};

type ProfileRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  is_verified?: boolean | null;
};

type UserRoleJoinRowRaw = {
  user_id: string;
  role: string;
  // Supabase can return this as object OR array depending on relationship/FK shape
  profiles?: ProfileRow | ProfileRow[] | null;
};

type UserRoleJoinRow = {
  user_id: string;
  role: string;
  profile: ProfileRow | null;
};


type ForumFlagRowRaw = {
  id: string;
  created_at: string;
  status: string;
  reason: string | null;
  created_by: string;
  target_type: "thread" | "post";
  target_id: string;
};

type ForumFlagRow = ForumFlagRowRaw & {
  profile: ProfileRow | null;
  // Derived client-side for admin actions.
  target_href?: string | null;
  target_label?: string | null;
};

type LoadState = "loading" | "loaded" | "denied";

function toSlug(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeJoinRow(raw: UserRoleJoinRowRaw): UserRoleJoinRow {
  const p = raw.profiles ?? null;
  const profile =
    Array.isArray(p) ? (p.length ? p[0] : null) : (p as ProfileRow | null);
  return { user_id: raw.user_id, role: raw.role, profile };
}

export default function AdminCommunityPage() {
  const [state, setState] = useState<LoadState>("loading");

  const [currentUserId, setCurrentUserId] = useState<string | null>(null);

  const { data: access, isLoading: accessLoading } = useMeAccess();
  const perms = useMemo(() => new Set(access?.permissions ?? []), [access?.permissions]);
  const canView = perms.has("community.view");
  const canManageCategories = perms.has("community.categories.manage");
  const canEditCategories = perms.has("community.categories.edit") || canManageCategories;
  const canPin = perms.has("community.pin_thread");
  const canModerateFlags = perms.has("moderation.reports.moderate") || perms.has("moderation.reports.override");

  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  const [busyKey, setBusyKey] = useState<string | null>(null);

  // Categories
  const [categories, setCategories] = useState<ForumCategoryRow[]>([]);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newParentId, setNewParentId] = useState<number | null>(null);

  const [editingCategoryId, setEditingCategoryId] = useState<number | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editParentId, setEditParentId] = useState<number | null>(null);

  // Flags
  const [flags, setFlags] = useState<ForumFlagRow[]>([]);

  // Pinned threads
  const [pinnedThreads, setPinnedThreads] = useState<ForumThreadRow[]>([]);
  const [flagQuery, setFlagQuery] = useState("");
  const [flagStatus, setFlagStatus] = useState<"open" | "resolved" | "all">("open");

  const resetMessages = () => {
    setErrorMessage(null);
    setActionMessage(null);
  };

  const filteredFlags = useMemo(() => {
    let list = [...flags];
    if (flagStatus !== "all") list = list.filter((f) => String(f.status) === flagStatus);
    const q = flagQuery.trim().toLowerCase();
    if (q) {
      list = list.filter((f) => {
        const who = f.profile?.display_name || f.profile?.username || "";
        const reason = f.reason ?? "";
        return who.toLowerCase().includes(q) || reason.toLowerCase().includes(q);
      });
    }
    return list;
  }, [flags, flagQuery, flagStatus]);

  const handleUpdateFlagStatus = async (flagId: string, nextStatus: "open" | "resolved") => {
    if (!canModerateFlags) return;
    resetMessages();
    const supabase = supabaseBrowser();
    try {
      setBusyKey(`flag:${flagId}`);
      const { error } = await supabase
        .from("forum_flags")
        .update({
          status: nextStatus,
          resolved_at: nextStatus === "resolved" ? new Date().toISOString() : null,
          resolved_by: nextStatus === "resolved" ? currentUserId : null,
        })
        .eq("id", flagId);
      if (error) {
        setErrorMessage(error.message);
        return;
      }
      setFlags((prev) =>
        prev.map((f) =>
          f.id === flagId
            ? {
                ...f,
                status: nextStatus,
              }
            : f
        )
      );
      setActionMessage(nextStatus === "resolved" ? "Flag resolved." : "Flag reopened.");
    } catch {
      setErrorMessage("Failed to update flag.");
    } finally {
      setBusyKey(null);
    }
  };

  const handleDeleteFlag = async (flagId: string) => {
    if (!confirm("Delete this flag? This cannot be undone.")) return;
    const supabase = supabaseBrowser();
    const { error } = await supabase.from("forum_flags").delete().eq("id", flagId);
    if (error) {
      console.error("forum flag delete failed", error);
			setErrorMessage("Failed to delete flag.");
			window.setTimeout(() => setErrorMessage(null), 2500);
      return;
    }
    setFlags((prev) => prev.filter((f) => f.id !== flagId));
  };


  const handleUnpinThread = async (threadId: string) => {
    if (!canPin) return;
    resetMessages();
    try {
      setBusyKey(`pin:${threadId}`);
      const supabase = supabaseBrowser();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;

      if (!token) {
        setErrorMessage("You must be logged in.");
        return;
      }

      const res = await fetch(`/api/forum/threads/${encodeURIComponent(threadId)}/pin`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ pinned: false }),
      });

      const payload = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok || payload?.error) {
        setErrorMessage(payload?.error ?? "Failed to update pin.");
        return;
      }

      setPinnedThreads((prev) => prev.filter((t) => t.id !== threadId));
      setActionMessage("Thread unpinned.");
    } catch (e) {
      console.error("Unpin thread failed", e);
      setErrorMessage("Failed to update pin.");
    } finally {
      setBusyKey(null);
    }
  };

  const getName = (p: ProfileRow | null, fallback: string) =>
    p?.display_name || p?.username || fallback;

  const getAvatarLetter = (p: ProfileRow | null, fallback: string) =>
    (getName(p, fallback)[0] || "?").toUpperCase();

  // ---- initial load ----
  useEffect(() => {
    const load = async () => {
      const supabase = supabaseBrowser();
      try {
        setState("loading");
        resetMessages();

        // UI gating is permission-based. Server routes still enforce permissions.
        if (accessLoading) return;
        if (!canView) {
          setState("denied");
          setErrorMessage("Access denied.");
          return;
        }

        // 1) auth
        const {
          data: { user },
        } = await supabase.auth.getUser();

        if (!user) {
          setState("denied");
          setErrorMessage("You must be logged in.");
          return;
        }

        setCurrentUserId(user.id);

        // 2) categories
        const { data: catRows, error: catErr } = await supabase
          .from("forum_categories")
          .select("id, slug, name, description, sort_order, is_archived, created_at, parent_id")
          .order("sort_order", { ascending: true })
          .order("created_at", { ascending: true });

        if (catErr) {
          console.error("forum_categories load error", catErr);
          setErrorMessage("Failed to load forum categories.");
        } else {
          setCategories((catRows ?? []) as ForumCategoryRow[]);
        }

        // 4) flags
        const { data: flagRows, error: flagErr } = await supabase
          .from("forum_flags")
          .select("id, created_at, created_by, target_type, target_id, reason, status")
          .order("created_at", { ascending: false })
          .limit(500);

        if (flagErr) {
          console.error("forum_flags load error", flagErr);
          setErrorMessage((prev) => prev ?? "Failed to load flags.");
          setFlags([]);
        } else {
          const base = ((flagRows ?? []) as ForumFlagRowRaw[]).map((r) => ({
            ...r,
            profile: null,
          }));

          const derived = await deriveFlagTargets(supabase, base);

          const userIds = Array.from(
            new Set(base.map((f) => f.created_by).filter(Boolean))
          ) as string[];

          if (userIds.length > 0) {
            const { data: profRows } = await supabase
              .from("profiles")
              .select("id, username, display_name, avatar_url, is_verified")
              .in("id", userIds);

            const profMap = new Map<string, ProfileRow>();
            (profRows ?? []).forEach((p) => {
              const pr = p as ProfileRow;
              profMap.set(pr.id, pr);
            });

            setFlags(derived.map((f) => ({ ...f, profile: profMap.get(f.created_by) ?? null })));
          } else {
            setFlags(derived);

        // 5) pinned threads (for quick announcement/pin management)
        const { data: pinnedRows, error: pinnedErr } = await supabase
          .from("forum_threads")
          .select("id, category_id, title, slug, is_pinned, is_deleted, created_at, last_post_at")
          .eq("is_pinned", true)
          .eq("is_deleted", false)
          .order("last_post_at", { ascending: false })
          .limit(50);

        if (pinnedErr) {
          console.error("forum_threads pinned load error", pinnedErr);
          setPinnedThreads([]);
        } else {
          setPinnedThreads((pinnedRows ?? []) as ForumThreadRow[]);
        }
          }
        }

        setState("loaded");
      } catch (e) {
        console.error("AdminCommunityPage load error", e);
        setState("denied");
        setErrorMessage("Unexpected error loading community admin.");
      }
    };

    void load();
  }, [accessLoading, canView]);

  const categoryById = useMemo(() => {
    const map = new Map<number, ForumCategoryRow>();
    for (const c of categories) map.set(c.id, c);
    return map;
  }, [categories]);

  const buildParentOptions = (currentId?: number | null) => {
    const options = [{ value: "", label: "No parent" }];
    for (const c of categories) {
      if (currentId && c.id === currentId) continue;
      options.push({ value: String(c.id), label: c.name });
    }
    return options;
  };

  // ---- actions ----

  const handleCreateCategory = async () => {
    if (!canManageCategories) return;

    resetMessages();

    const name = newName.trim();
    const slug = (newSlug.trim() ? newSlug : toSlug(name)).trim();
    const description = newDescription.trim() || null;

    if (!name) {
      setErrorMessage("Category name is required.");
      return;
    }

    if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
      setErrorMessage("Slug must be lowercase letters/numbers/dashes only.");
      return;
    }

    try {
      setBusyKey("create-category");
      const supabase = supabaseBrowser();

      const maxSort = categories.length
        ? Math.max(...categories.map((c) => (Number.isFinite(c.sort_order) ? c.sort_order : 0)))
        : 0;
      const nextSort = maxSort + 10;

      const { data, error } = await supabase
        .from("forum_categories")
        .insert({
          name,
          slug,
          description,
          sort_order: nextSort,
          is_archived: false,
          parent_id: newParentId,
        })
        .select("id, slug, name, description, sort_order, is_archived, created_at, parent_id")
        .single<ForumCategoryRow>();

      if (error) {
        console.error("create category error", error);
        setErrorMessage(error.message || "Failed to create category.");
        return;
      }

      if (data) {
        setCategories((prev) => [...prev, data].sort((a, b) => a.sort_order - b.sort_order));
        setNewName("");
        setNewSlug("");
        setNewDescription("");
        setNewParentId(null);
        setActionMessage("Category created.");
      }
    } catch (e) {
      console.error("create category unexpected", e);
      setErrorMessage("Unexpected error creating category.");
    } finally {
      setBusyKey(null);
    }
  };

  const handleToggleArchived = async (catId: number, nextArchived: boolean) => {
    if (!canManageCategories) return;
    resetMessages();

    try {
      setBusyKey(`archive-${catId}`);
      const supabase = supabaseBrowser();

      const { data, error } = await supabase
        .from("forum_categories")
        .update({ is_archived: nextArchived })
        .eq("id", catId)
        .select("id, slug, name, description, sort_order, is_archived, created_at, parent_id")
        .single<ForumCategoryRow>();

      if (error) {
        console.error("archive toggle error", error);
        setErrorMessage("Failed to update category.");
        return;
      }

      setCategories((prev) => prev.map((c) => (c.id === catId ? data : c)));
      setActionMessage(nextArchived ? "Category archived." : "Category unarchived.");
    } catch (e) {
      console.error("archive toggle unexpected", e);
      setErrorMessage("Unexpected error updating category.");
    } finally {
      setBusyKey(null);
    }
  };

  const handleMoveCategory = async (catId: number, direction: "up" | "down") => {
    if (!canManageCategories) return;
    resetMessages();

    const sorted = [...categories].sort((a, b) => a.sort_order - b.sort_order);
    const idx = sorted.findIndex((c) => c.id === catId);
    if (idx < 0) return;

    const otherIdx = direction === "up" ? idx - 1 : idx + 1;
    if (otherIdx < 0 || otherIdx >= sorted.length) return;

    const a = sorted[idx];
    const b = sorted[otherIdx];
    if (!a || !b) return;

    try {
      setBusyKey(`sort-${catId}`);
      const supabase = supabaseBrowser();

      const { error: e1 } = await supabase
        .from("forum_categories")
        .update({ sort_order: b.sort_order })
        .eq("id", a.id);
      if (e1) {
        setErrorMessage(e1.message || "Failed to update sort order.");
        return;
      }

      const { error: e2 } = await supabase
        .from("forum_categories")
        .update({ sort_order: a.sort_order })
        .eq("id", b.id);
      if (e2) {
        setErrorMessage(e2.message || "Failed to update sort order.");
        return;
      }

      setCategories((prev) => {
        const next = prev.map((c) => {
          if (c.id === a.id) return { ...c, sort_order: b.sort_order };
          if (c.id === b.id) return { ...c, sort_order: a.sort_order };
          return c;
        });
        return next.sort((x, y) => x.sort_order - y.sort_order);
      });
      setActionMessage("Category order updated.");
    } catch {
      setErrorMessage("Failed to update category order.");
    } finally {
      setBusyKey(null);
    }
  };

  const beginEditCategory = (c: ForumCategoryRow) => {
    if (!canEditCategories) return;
    resetMessages();
    setEditingCategoryId(c.id);
    setEditName(c.name);
    setEditSlug(c.slug);
    setEditDescription(c.description ?? "");
    setEditParentId(c.parent_id ?? null);
  };

  const cancelEditCategory = () => {
    setEditingCategoryId(null);
    setEditName("");
    setEditSlug("");
    setEditDescription("");
    setEditParentId(null);
  };

  const saveEditCategory = async () => {
    if (!canEditCategories || !editingCategoryId) return;
    resetMessages();

    try {
      setBusyKey(`edit-${editingCategoryId}`);
      const supabase = supabaseBrowser();

      const patch: Record<string, unknown> = {
        name: editName.trim(),
        slug: editSlug.trim(),
        description: editDescription.trim() || null,
        parent_id: editParentId,
      };

      const { data, error } = await supabase
        .from("forum_categories")
        .update(patch)
        .eq("id", editingCategoryId)
        .select("id, slug, name, description, sort_order, is_archived, created_at, parent_id")
        .single<ForumCategoryRow>();

      if (error) {
        setErrorMessage(error.message || "Failed to update category.");
        return;
      }

      setCategories((prev) => prev.map((c) => (c.id === editingCategoryId ? data : c)));
      setActionMessage("Category updated.");
      cancelEditCategory();
    } catch {
      setErrorMessage("Failed to update category.");
    } finally {
      setBusyKey(null);
    }
  };


  // ---- render gates ----

  if (accessLoading || state === "loading") {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 text-sm text-brand-text">
        <p>Loading community admin…</p>
      </div>
    );
  }

  if (state === "denied") {
    return <AccessDeniedCard message={errorMessage ?? "You do not have permission to view this page."} />;
  }

  // ---- main UI ----

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <section>
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Staff • Community
        </p>

        <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Community overview
          </h1>
        </div>

        <p className="mt-1 text-[12px] text-brand-textMuted sm:text-sm">
          Manage forum categories and visibility.
        </p>
        {/* Sidebar navigation already provides context and navigation for staff pages. */}
      </section>
      {errorMessage && (
        <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[12px] text-rose-200">
          {errorMessage}
        </div>
      )}
      {actionMessage && (
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-[12px] text-emerald-200">
          {actionMessage}
        </div>
      )}
      {/* Categories */}
        {/* Forum Flags */}
        <div className="mt-8 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-brand-text">Flags</h2>
            <div className="flex items-center gap-2 text-[11px] text-brand-textMuted">
              <span>{filteredFlags.length} shown</span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              value={flagQuery}
              onChange={(e) => setFlagQuery(e.target.value)}
              placeholder="Search flags (user/reason)…"
              className="w-full max-w-sm rounded-lg border border-zinc-700 bg-black/40 px-3 py-2 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
            <MenuSelect
              ariaLabel="Filter flags by status"
              value={flagStatus}
              onChange={setFlagStatus}
              options={[...flagStatusOptions]}
              className="ui-select-trigger max-w-44"
              align="left"
            />
          </div>

          <div className="overflow-hidden rounded-xl border border-zinc-800/80 bg-black/40">
            <div className="divide-y divide-zinc-800/80">
              {filteredFlags.length === 0 ? (
                <div className="p-4 text-[12px] text-brand-textMuted">No flags.</div>
              ) : (
                filteredFlags.map((f) => {
                  const name = f.profile?.display_name || f.profile?.username || f.created_by || "Unknown";
                  return (
                    <div key={f.id} className="p-3">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[12px] font-semibold text-brand-text">
                              {name}
                              {f.profile?.is_verified ? <VerifiedBadge className="ml-0.5 h-3 w-3" /> : null}
                            </span>
                            <span className={"rounded-full border px-2 py-0.5 text-[10px] " + (String(f.status) === "resolved" ? "border-emerald-500/60 bg-emerald-500/10 text-emerald-200" : "border-amber-500/60 bg-amber-500/10 text-amber-200")}>
                              {String(f.status) === "resolved" ? "Resolved" : "Open"}
                            </span>
                            <span className="text-[10px] text-zinc-500">{new Date(f.created_at).toLocaleString()}</span>
                          </div>

                          <div className="mt-1 line-clamp-2 text-[12px] text-brand-textMuted">
                            {f.reason ? f.reason : <span className="italic text-zinc-600">(no reason)</span>}
                          </div>

                          <div className="mt-1 text-[10px] text-zinc-500">
                            {f.target_href ? (
                              <Link
                                href={f.target_href}
                                className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
                              >
                                {f.target_label ?? (f.target_type === "thread" ? `Thread #${f.target_id}` : `Post #${f.target_id}`)}
                              </Link>
                            ) : (
                              <>
                                {f.target_type === "thread" ? (<>Thread #{f.target_id}</>) : null}
                                {f.target_type === "post" ? (<>Post #{f.target_id}</>) : null}
                              </>
                            )}
                          </div>
                        </div>

                        <div className="flex shrink-0 flex-col items-end gap-2 text-[10px]">
                          {f.target_href ? (
                            <Link
                              href={f.target_href}
                              className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted hover:border-zinc-500 hover:text-brand-text"
                            >
                              View
                            </Link>
                          ) : null}

                          {String(f.status) !== "resolved" ? (
                            <button
                              type="button"
                              onClick={() => handleUpdateFlagStatus(f.id, "resolved")}
                              disabled={!canModerateFlags || busyKey === `flag:${f.id}`}
                              className="rounded-full border border-emerald-500/70 bg-emerald-500/15 px-2 py-0.5 text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-60"
                            >
                              Resolve
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handleUpdateFlagStatus(f.id, "open")}
                              disabled={!canModerateFlags || busyKey === `flag:${f.id}`}
                              className="rounded-full border border-amber-500/70 bg-amber-500/15 px-2 py-0.5 text-amber-200 hover:bg-amber-500/25 disabled:opacity-60"
                            >
                              Reopen
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => void handleDeleteFlag(f.id)}
                            disabled={!canModerateFlags || busyKey === `flag:${f.id}`}
                            className="rounded-full border border-red-500/60 bg-red-500/10 px-2 py-0.5 text-red-200 hover:bg-red-500/20 disabled:opacity-60"
                            title="Delete flag"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-brand-text">Forum categories</h2>
          <span className="text-[11px] text-brand-textMuted">
            {categories.length} total
          </span>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          <div className="space-y-1 md:col-span-1">
            <label className="block text-[11px] text-brand-textMuted">Name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Engine & Drivetrain"
              className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
              disabled={busyKey === "create-category"}
            />
          </div>

          <div className="space-y-1 md:col-span-1">
            <label className="block text-[11px] text-brand-textMuted">
              Slug (optional)
            </label>
            <input
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="auto-from-name if blank"
              className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
              disabled={busyKey === "create-category"}
            />
          </div>

          <div className="space-y-1 md:col-span-1">
            <label className="block text-[11px] text-brand-textMuted">
              Description (optional)
            </label>
            <input
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              placeholder="Short description"
              className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/40 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-brand-textMuted focus:border-amber-400"
              disabled={busyKey === "create-category"}
            />
          </div>

          <div className="space-y-1 md:col-span-1">
            <label className="block text-[11px] text-brand-textMuted">
              Parent category (optional)
            </label>
            <MenuSelect
              value={newParentId ? String(newParentId) : ""}
              onChange={(value) => setNewParentId(value ? Number(value) : null)}
              options={buildParentOptions(null)}
              className="ui-select-trigger"
              disabled={busyKey === "create-category"}
            />
          </div>
        </div>

        <div className="mt-3 flex justify-end">
          <CtaButton
            variant="primary"
            onClick={handleCreateCategory}
            disabled={busyKey === "create-category" || !canManageCategories || newName.trim().length === 0}
          >
            {!canManageCategories ? "No permission" : busyKey === "create-category" ? "Creating…" : "Create category"}
          </CtaButton>
        </div>

      </section>

      {/* List (match /staff/shops layout & cards) */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
            {`All categories (${categories.length})`}
          </h2>
        </div>

        {categories.length === 0 ? (
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[12px] text-brand-textMuted">
            No categories yet.
          </div>
        ) : (
          <div className="grid gap-3">
            {categories.map((c, idx) => (
              <div
                key={c.id}
                className={`rounded-xl border bg-black/40 p-4 transition hover:border-amber-400/80 ${
                  c.is_archived ? "border-rose-400/30" : "border-zinc-800/80"
                }`}
              >
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-[13px] font-semibold text-brand-text truncate">{c.name}</h3>
                      <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                        Slug: {c.slug}
                      </span>
                      {c.is_archived && (
                        <span className="rounded-full border border-rose-500/70 bg-rose-500/15 px-2 py-0.5 text-[10px] text-rose-200">
                          Archived
                        </span>
                      )}
                      <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                        Sort: {c.sort_order}
                      </span>
                    </div>

                    {c.description ? <p className="mt-1 text-[12px] text-brand-textMuted">{c.description}</p> : null}
                    {c.parent_id ? (
                      <p className="mt-1 text-[11px] text-brand-textMuted">
                        Parent:{" "}
                        <span className="text-brand-text">
                          {categoryById.get(c.parent_id)?.name ?? `#${c.parent_id}`}
                        </span>
                      </p>
                    ) : null}

                    {editingCategoryId === c.id ? (
                      <div className="mt-3 grid gap-3 md:grid-cols-4">
                        <div className="space-y-2">
                          <label className="block text-[11px] text-brand-textMuted">Name</label>
                          <input
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            disabled={busyKey === `edit-${c.id}` || !canEditCategories}
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="block text-[11px] text-brand-textMuted">Slug</label>
                          <input
                            value={editSlug}
                            onChange={(e) => setEditSlug(e.target.value)}
                            className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            disabled={busyKey === `edit-${c.id}` || !canEditCategories}
                          />
                        </div>
                        <div className="space-y-2">
                          <label className="block text-[11px] text-brand-textMuted">Description</label>
                          <input
                            value={editDescription}
                            onChange={(e) => setEditDescription(e.target.value)}
                            className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            disabled={busyKey === `edit-${c.id}` || !canEditCategories}
                          />
                        </div>

                        <div className="space-y-2">
                          <label className="block text-[11px] text-brand-textMuted">Parent</label>
                          <MenuSelect
                            value={editParentId ? String(editParentId) : ""}
                            onChange={(value) => setEditParentId(value ? Number(value) : null)}
                            options={buildParentOptions(c.id)}
                            className="ui-select-trigger"
                            disabled={busyKey === `edit-${c.id}` || !canEditCategories}
                          />
                        </div>

                      </div>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    <div className="inline-flex overflow-hidden rounded-full border border-zinc-700 bg-black/40">
                      <button
                        type="button"
                        onClick={() => void handleMoveCategory(c.id, "up")}
                        disabled={!canManageCategories || idx === 0 || busyKey === `sort-${c.id}`}
                        className="px-2 py-1 text-[11px] text-brand-textMuted hover:text-brand-text disabled:opacity-50"
                        title="Move up"
                      >
                        ↑
                      </button>
                      <div className="w-px bg-zinc-700/70" />
                      <button
                        type="button"
                        onClick={() => void handleMoveCategory(c.id, "down")}
                        disabled={!canManageCategories || idx === categories.length - 1 || busyKey === `sort-${c.id}`}
                        className="px-2 py-1 text-[11px] text-brand-textMuted hover:text-brand-text disabled:opacity-50"
                        title="Move down"
                      >
                        ↓
                      </button>
                    </div>

                    <Link href={`/community/${c.slug}`} className="inline-flex">
                      <CtaButton>View →</CtaButton>
                    </Link>

                    {canEditCategories ? (
                      editingCategoryId === c.id ? (
                        <>
                          <CtaButton
                            variant="primary"
                            onClick={saveEditCategory}
                            disabled={busyKey === `edit-${c.id}` || !canEditCategories}
                          >
                            {busyKey === `edit-${c.id}` ? "Saving…" : "Save"}
                          </CtaButton>
                          <CtaButton onClick={cancelEditCategory} disabled={busyKey === `edit-${c.id}`}>Cancel</CtaButton>
                        </>
                      ) : (
                        <CtaButton onClick={() => beginEditCategory(c)} disabled={!canEditCategories}>
                          Edit
                        </CtaButton>
                      )
                    ) : null}

                    <CtaButton
                      variant={c.is_archived ? "secondary" : "danger"}
                      onClick={() => handleToggleArchived(c.id, !c.is_archived)}
                      disabled={busyKey === `archive-${c.id}` || !canManageCategories}
                    >
                      {busyKey === `archive-${c.id}` ? "Updating…" : c.is_archived ? "Unarchive" : "Archive"}
                    </CtaButton>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
      <div className="text-[11px] text-brand-textMuted">
        Logged in as{" "}
        <span className="text-brand-text font-medium">{currentUserId}</span>
      </div>
    </div>
  );
}

async function deriveFlagTargets(
  supabase: SupabaseClient,
  flags: (ForumFlagRowRaw & { profile: ProfileRow | null })[]
): Promise<(ForumFlagRowRaw & { profile: ProfileRow | null; target_href?: string | null; target_label?: string | null })[]> {
  const threadIdsDirect = new Set<number>();
  const postIds = new Set<number>();

  for (const f of flags) {
    const n = Number(f.target_id);
    if (!Number.isFinite(n)) continue;
    if (f.target_type === "thread") threadIdsDirect.add(n);
    if (f.target_type === "post") postIds.add(n);
  }

  if (threadIdsDirect.size === 0 && postIds.size === 0) return flags;

  // Map postId -> threadId
  const postRows = postIds.size
    ? await supabase
        .from("forum_posts")
        .select("id, thread_id")
        .in("id", Array.from(postIds))
    : { data: [], error: null };

  const postToThread = new Map<number, number>();
  const threadIds = new Set<number>(threadIdsDirect);
  for (const r of postRows.data ?? []) {
    if (typeof r?.id === "number" && typeof r?.thread_id === "number") {
      postToThread.set(r.id, r.thread_id);
      threadIds.add(r.thread_id);
    }
  }

  // Map threadId -> { slug, category_id, title }
  const threadRows = threadIds.size
    ? await supabase
        .from("forum_threads")
        .select("id, slug, title, category_id")
        .in("id", Array.from(threadIds))
    : { data: [], error: null };

  const threadsById = new Map<number, { slug: string; title: string; category_id: number }>();
  const catIds = new Set<number>();
  for (const t of threadRows.data ?? []) {
    if (
      typeof t?.id === "number" &&
      typeof t?.slug === "string" &&
      typeof t?.category_id === "number"
    ) {
      threadsById.set(t.id, {
        slug: t.slug,
        title: typeof t?.title === "string" ? t.title : `Thread #${t.id}`,
        category_id: t.category_id,
      });
      catIds.add(t.category_id);
    }
  }

  // Map categoryId -> slug
  const catRows = catIds.size
    ? await supabase
        .from("forum_categories")
        .select("id, slug")
        .in("id", Array.from(catIds))
    : { data: [], error: null };

  const catSlugById = new Map<number, string>();
  for (const c of catRows.data ?? []) {
    if (typeof c?.id === "number" && typeof c?.slug === "string") {
      catSlugById.set(c.id, c.slug);
    }
  }

  const threadHrefById = new Map<number, string>();
  for (const [id, t] of threadsById.entries()) {
    const catSlug = catSlugById.get(t.category_id);
    if (!catSlug) continue;
    threadHrefById.set(id, `/community/${catSlug}/${t.slug}`);
  }

  return flags.map((f) => {
    const n = Number(f.target_id);
    if (!Number.isFinite(n)) return f;

    if (f.target_type === "thread") {
      const href = threadHrefById.get(n) ?? null;
      const title = threadsById.get(n)?.title ?? `Thread #${f.target_id}`;
      return { ...f, target_href: href, target_label: title };
    }

    // post
    const tid = postToThread.get(n);
    const threadHref = tid ? threadHrefById.get(tid) : null;
    const threadTitle = tid ? threadsById.get(tid)?.title : null;
    const href = threadHref ? `${threadHref}#post-${n}` : null;
    const label = threadTitle ? `${threadTitle} • Post #${n}` : `Post #${n}`;
    return { ...f, target_href: href, target_label: label };
  });
}
