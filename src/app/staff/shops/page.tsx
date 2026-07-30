"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { MenuSelect } from "@/components/ui/MenuSelect";

type TrustStatus = "trusted" | "untrusted" | "unknown";

type ShopRow = {
  id: string;
  name: string;
  slug: string;
  url: string;
  description: string | null;
  tags: string[] | null;
  featured: boolean;
  sort_order: number;
  is_published: boolean;
  trust_status: TrustStatus;
  warning_text: string | null;
  created_at: string;
};

const trustOptions = [
  { value: "trusted", label: "Trusted" },
  { value: "untrusted", label: "Untrusted" },
  { value: "unknown", label: "Unknown" },
] as const;

function safeUrl(input: string): string {
  const t = input.trim();
  if (!t) return "";
  if (t.startsWith("http://") || t.startsWith("https://")) return t;
  return `https://${t}`;
}

function isValidUrl(url: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

function parseTags(text: string): string[] | null {
  const tags = text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return tags.length ? tags : null;
}

function tagsToText(tags: string[] | null): string {
  return (tags ?? []).join(", ");
}

function capitalizeFirst(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function prettyTrustStatus(ts: TrustStatus): string {
  return capitalizeFirst(ts);
}

function CtaButton({
  children,
  onClick,
  disabled,
  variant = "secondary",
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
}) {
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

export default function AdminShopsPage() {
  const router = useRouter();
  const supabase = useMemo(() => supabaseBrowser(), []);

  const { data: access, isLoading: accessLoading } = useMeAccess();
  const perms = useMemo(() => new Set(access?.permissions ?? []), [access?.permissions]);
  const canModerateAll = perms.has("shops.moderate");
  const canView = perms.has("shops.view") || canModerateAll;
  const canCreate = canModerateAll || perms.has("shops.create");
  const canModify = canModerateAll || perms.has("shops.modify");
  const canReorder = canModerateAll || perms.has("shops.reorder");
  const canPublish = canModerateAll || perms.has("shops.publish");
  const canDelete = canModerateAll || perms.has("shops.delete");

  
  const [shops, setShops] = useState<ShopRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // List UX
  const [shopSearch, setShopSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(10);

  // Create form
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [featured, setFeatured] = useState(false);
  const [isPublished, setIsPublished] = useState(true);
  const [trustStatus, setTrustStatus] = useState<TrustStatus>("trusted");
  const [warningText, setWarningText] = useState("");
  const [creating, setCreating] = useState(false);

  // NEW: allow manual sort order when creating
  const [createSortOrderText, setCreateSortOrderText] = useState<string>(""); // blank = auto

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editSlug, setEditSlug] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editDescription, setEditDescription] = useState("");
  const [editTagsText, setEditTagsText] = useState("");
  const [editTrustStatus, setEditTrustStatus] = useState<TrustStatus>("trusted");
  const [editWarningText, setEditWarningText] = useState("");

  const createOk = useMemo(() => {
    if (!canCreate) return false;
    const fixed = safeUrl(url);
    if (!(name.trim().length >= 2 && isValidUrl(fixed))) return false;

    // if user typed sort order, it must parse to an integer
    const t = createSortOrderText.trim();
    if (!t) return true;
    const n = Number.parseInt(t, 10);
    return Number.isFinite(n) && !Number.isNaN(n);
  }, [canCreate, name, url, createSortOrderText]);

  // Permission-gated: the StaffNav hides this page unless you have shops.view.
  // We still enforce it here so direct URLs are safe.

  async function fetchAllShops() {
    setLoading(true);
    setErrorMsg(null);

    const { data, error } = await supabase
      .from("shops")
      .select(
        "id,name,slug,url,description,tags,featured,sort_order,is_published,trust_status,warning_text,created_at",
      )
      .order("featured", { ascending: false })
      .order("sort_order", { ascending: true })
      .order("created_at", { ascending: false });

    if (error) {
      setErrorMsg(error.message);
      setShops([]);
      setLoading(false);
      return;
    }

    setShops((data ?? []) as ShopRow[]);
    setLoading(false);
  }

  useEffect(() => {
    if (accessLoading) return;
    if (!canView) {
      setLoading(false);
      return;
    }
    void fetchAllShops();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessLoading, canView]);

  useEffect(() => {
    // reset paging when search changes
    setVisibleCount(10);
  }, [shopSearch]);

  const filteredShops = useMemo(() => {
    const q = shopSearch.trim().toLowerCase();
    if (!q) return shops;
    return shops.filter((s) => {
      const hay = [
        s.name,
        s.slug,
        s.url,
        s.description ?? "",
        ...(s.tags ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [shops, shopSearch]);

  const visibleShops = useMemo(() => {
    return filteredShops.slice(0, visibleCount);
  }, [filteredShops, visibleCount]);

  function beginEdit(s: ShopRow) {
    setEditingId(s.id);
    setEditName(s.name);
    setEditSlug(s.slug);
    setEditUrl(s.url);
    setEditDescription(s.description ?? "");
    setEditTagsText(tagsToText(s.tags));
    setEditTrustStatus(s.trust_status);
    setEditWarningText(s.warning_text ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setEditName("");
    setEditSlug("");
    setEditUrl("");
    setEditDescription("");
    setEditTagsText("");
    setEditTrustStatus("trusted");
    setEditWarningText("");
  }

  async function createShop() {
    if (!createOk) return;

    setCreating(true);
    setErrorMsg(null);

    const fixed = safeUrl(url);
    const tags = parseTags(tagsText);

    // default behavior (auto): put it above the current smallest sort_order
    const minSort = shops.length ? Math.min(...shops.map((s) => s.sort_order)) : 0;
    const autoSort = minSort - 10;

    const t = createSortOrderText.trim();
    const manualSort = t ? Number.parseInt(t, 10) : null;
    const finalSort = manualSort != null && !Number.isNaN(manualSort) ? manualSort : autoSort;

    const { error } = await supabase.from("shops").insert({
      name: name.trim(),
      slug: slug.trim() ? slug.trim() : null,
      url: fixed,
      description: description.trim() ? description.trim() : null,
      tags,
      featured,
      is_published: isPublished,
      trust_status: trustStatus,
      // Caution text is shown publicly; admins can set it regardless of trust status.
      warning_text: warningText.trim() ? warningText.trim() : null,
      sort_order: finalSort,
    });

    if (error) {
      setErrorMsg(error.message);
      setCreating(false);
      return;
    }

    setName("");
    setSlug("");
    setUrl("");
    setDescription("");
    setTagsText("");
    setFeatured(false);
    setIsPublished(true);
    setTrustStatus("trusted");
    setWarningText("");
    setCreateSortOrderText("");

    await fetchAllShops();
    setCreating(false);
  }

  async function saveEdit(id: string) {
    if (!canModify) {
      setErrorMsg("Access denied. You do not have permission.");
      return;
    }
    const fixed = safeUrl(editUrl);
    if (editName.trim().length < 2 || !isValidUrl(fixed)) {
      setErrorMsg("Please enter a valid name and URL.");
      return;
    }

    setBusyId(id);
    setErrorMsg(null);

    const { error } = await supabase
      .from("shops")
      .update({
        name: editName.trim(),
        slug: editSlug.trim() ? editSlug.trim() : null,
        url: fixed,
        description: editDescription.trim() ? editDescription.trim() : null,
        tags: parseTags(editTagsText),
        trust_status: editTrustStatus,
        // Caution text is shown publicly; admins can set it regardless of trust status.
        warning_text: editWarningText.trim() ? editWarningText.trim() : null,
      })
      .eq("id", id);

    if (error) {
      setErrorMsg(error.message);
      setBusyId(null);
      return;
    }

    await fetchAllShops();
    setBusyId(null);
    cancelEdit();
  }

  async function toggleFeatured(s: ShopRow) {
    if (!canModify) {
      setErrorMsg("Access denied. You do not have permission.");
      return;
    }
    setBusyId(s.id);
    setErrorMsg(null);
    const { error } = await supabase.from("shops").update({ featured: !s.featured }).eq("id", s.id);
    if (error) setErrorMsg(error.message);
    await fetchAllShops();
    setBusyId(null);
  }

  async function togglePublished(s: ShopRow) {
    if (!canPublish) {
      setErrorMsg("Access denied. You do not have permission.");
      return;
    }
    setBusyId(s.id);
    setErrorMsg(null);
    const { error } = await supabase.from("shops").update({ is_published: !s.is_published }).eq("id", s.id);
    if (error) setErrorMsg(error.message);
    await fetchAllShops();
    setBusyId(null);
  }

  async function removeShop(id: string) {
    if (!canDelete) {
      setErrorMsg("Access denied. You do not have permission.");
      return;
    }
    setBusyId(id);
    setErrorMsg(null);
    const { error } = await supabase.from("shops").delete().eq("id", id);
    if (error) setErrorMsg(error.message);
    await fetchAllShops();
    setBusyId(null);
  }

  async function move(id: string, dir: "up" | "down") {
    if (!canReorder) {
      setErrorMsg("Access denied. You do not have permission.");
      return;
    }
    const idx = shops.findIndex((s) => s.id === id);
    if (idx === -1) return;
    const targetIdx = dir === "up" ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= shops.length) return;

    const a = shops[idx];
    const b = shops[targetIdx];

    if (a.featured !== b.featured) return; // keep within bucket

    setBusyId(id);
    setErrorMsg(null);

    const { error: e1 } = await supabase.from("shops").update({ sort_order: b.sort_order }).eq("id", a.id);
    if (e1) {
      setErrorMsg(e1.message);
      setBusyId(null);
      return;
    }

    const { error: e2 } = await supabase.from("shops").update({ sort_order: a.sort_order }).eq("id", b.id);
    if (e2) {
      setErrorMsg(e2.message);
      setBusyId(null);
      return;
    }

    await fetchAllShops();
    setBusyId(null);
  }

  if (accessLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-10">
        <div className="text-sm text-brand-textMuted">Loading…</div>
      </div>
    );
  }

  if (!canView) {
    return (
      <AccessDeniedCard
        title="Staff • Shops"
        message="You do not have permission to view this page."
        backHref="/shops"
        backLabel="View shops"
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-8">
      <section className="space-y-3">
        <div className="flex items-end justify-between gap-3">
          <div>
            <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">Staff • Shops</p>
            <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">Manage shops</h1>
            <p className="mt-1 text-[12px] text-brand-textMuted sm:text-sm">
              Create, edit, publish, feature, sort, and label trust.
            </p>
            {/* Sidebar navigation already provides staff navigation context. */}
          </div>

          <div className="flex items-center gap-2">
            <CtaButton onClick={() => void fetchAllShops()} disabled={loading}>
              Refresh
            </CtaButton>
            <CtaButton onClick={() => router.push("/shops")}>View public page</CtaButton>
          </div>
        </div>

        {errorMsg && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-[12px] text-rose-200">
            {errorMsg}
          </div>
        )}
      </section>

      {/* Create */}
      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">Add a shop</h2>
          <CtaButton onClick={() => void createShop()} disabled={!createOk || creating} variant="primary">
            {creating ? "Saving…" : "Create"}
          </CtaButton>
        </div>

        <div className={`grid gap-3 md:grid-cols-2 ${canCreate ? "" : "opacity-60 pointer-events-none"}`}>
          <div className="space-y-2">
            <label className="block text-[11px] text-brand-textMuted">Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
              placeholder="Enjuku Racing"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-[11px] text-brand-textMuted">Slug (optional)</label>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
              placeholder="enjuku-racing"
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="block text-[11px] text-brand-textMuted">URL</label>
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
              placeholder="https://example.com"
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="block text-[11px] text-brand-textMuted">Description</label>
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
              placeholder="What they sell / why they’re recommended"
            />
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="block text-[11px] text-brand-textMuted">Tags (comma separated)</label>
            <input
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
              placeholder="parts, aero, tuning"
            />
          </div>

          {/* NEW: Sort order on create */}
          <div className="space-y-2 md:col-span-2">
            <label className="block text-[11px] text-brand-textMuted">
              Sort order (optional)
            </label>
            <input
              value={createSortOrderText}
              onChange={(e) => setCreateSortOrderText(e.target.value)}
              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
              placeholder="Leave blank for auto (e.g. -10, 0, 10, 20...)"
              inputMode="numeric"
            />
            <p className="text-[10px] text-brand-textMuted">
              Lower numbers show first (within the Featured/non-Featured bucket).
            </p>
          </div>

          <div className="grid gap-3 md:grid-cols-3 md:col-span-2">
            <label className="flex items-center gap-2 text-[11px] text-brand-textMuted">
              <input
                type="checkbox"
                checked={featured}
                onChange={(e) => setFeatured(e.target.checked)}
                className="no-zoom-input"
              />
              Featured
            </label>

            <label className="flex items-center gap-2 text-[11px] text-brand-textMuted">
              <input
                type="checkbox"
                checked={isPublished}
                onChange={(e) => setIsPublished(e.target.checked)}
                className="no-zoom-input"
              />
              Published
            </label>

            <div className="flex items-center gap-2">
              <span className="text-[11px] text-brand-textMuted">Trust:</span>
              <MenuSelect
                ariaLabel="Trust status"
                value={trustStatus}
                onChange={(v) => setTrustStatus(v as TrustStatus)}
                options={trustOptions as any}
                className="flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-black/40 px-3 text-xs text-brand-text outline-none transition-all hover:border-amber-400/80"
                menuClassName="mt-2 w-56 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
              />
            </div>
          </div>

          <div className="space-y-2 md:col-span-2">
            <label className="block text-[11px] text-brand-textMuted">Caution text (shown publicly)</label>
            <input
              value={warningText}
              onChange={(e) => setWarningText(e.target.value)}
              className={
                trustStatus === "untrusted"
                  ? "no-zoom-input w-full rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 outline-none focus:border-rose-300/60"
                  : "no-zoom-input w-full rounded-lg border border-amber-400/25 bg-amber-500/5 px-3 py-2 text-sm text-amber-100/90 outline-none focus:border-amber-300/40"
              }
              placeholder="Known scam reports / counterfeit risk / proceed at your own risk"
            />
          </div>
        </div>
      </section>

      {/* List */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
            {loading ? "Loading…" : `All shops (${filteredShops.length})`}
          </h2>

          {!loading && shops.length > 0 && (
            <input
              type="text"
              value={shopSearch}
              onChange={(e) => setShopSearch(e.target.value)}
              placeholder="Search shops..."
              className="no-zoom-input w-[240px] rounded-full border border-zinc-700 bg-black/40 px-3 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500 focus:border-amber-400/80"
            />
          )}
        </div>

        {loading ? (
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[12px] text-brand-textMuted">
            Loading…
          </div>
        ) : filteredShops.length === 0 ? (
          <div className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-[12px] text-brand-textMuted">
            {shops.length === 0 ? "No shops yet." : "No shops match your search."}
          </div>
        ) : (
          <div className="grid gap-3">
            {visibleShops.map((s) => {
              const isEditing = editingId === s.id;
              const disabled = busyId === s.id;
              const idxAll = shops.findIndex((x) => x.id === s.id);
              const upDisabled =
                disabled ||
                !canReorder ||
                idxAll <= 0 ||
                (idxAll > 0 && shops[idxAll - 1] && shops[idxAll - 1].featured !== s.featured);
              const downDisabled =
                disabled ||
                !canReorder ||
                idxAll === -1 ||
                idxAll >= shops.length - 1 ||
                (idxAll >= 0 && shops[idxAll + 1] && shops[idxAll + 1].featured !== s.featured);

              return (
                <div
                  key={s.id}
                  className={`rounded-xl border bg-black/40 p-4 transition hover:border-amber-400/80 ${
                    s.trust_status === "untrusted" ? "border-rose-400/30" : "border-zinc-800/80"
                  }`}
                >
                  <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <h3 className="text-[13px] font-semibold text-brand-text truncate">{s.name}</h3>

                        <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                          Slug: {s.slug}
                        </span>

                        {s.featured && (
                          <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                            Featured
                          </span>
                        )}

                        {!s.is_published && (
                          <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                            Unpublished
                          </span>
                        )}

                        {/* CHANGED: capitalized */}
                        <span
                          className={`rounded-full border bg-black/40 px-2 py-0.5 text-[10px] ${
                            s.trust_status === "trusted"
                              ? "border-emerald-400/40 text-emerald-200"
                              : s.trust_status === "untrusted"
                                ? "border-rose-400/40 text-rose-200"
                                : "border-zinc-700 text-brand-textMuted"
                          }`}
                        >
                          {prettyTrustStatus(s.trust_status)}
                        </span>

                        <span className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted">
                          Sort: {s.sort_order}
                        </span>
                      </div>

                      {!isEditing ? (
                        <>
                          {s.description && <p className="mt-1 text-[12px] text-brand-textMuted">{s.description}</p>}

                          {s.trust_status === "untrusted" && s.warning_text && (
                            <div className="mt-2 rounded-lg border border-rose-400/30 bg-rose-500/10 p-2 text-[11px] text-rose-200">
                              {s.warning_text}
                            </div>
                          )}

                          <a
                            href={s.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-2 inline-flex items-center gap-1 text-[11px] text-amber-200/90 hover:text-amber-200 underline-offset-2 hover:underline"
                          >
                            {s.url} →
                          </a>

                          {Array.isArray(s.tags) && s.tags.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {s.tags.slice(0, 12).map((tag) => (
                                <span
                                  key={`${s.id}-${tag}`}
                                  className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted"
                                >
                                  {tag}
                                </span>
                              ))}
                            </div>
                          )}
                        </>
                      ) : (
                        <div className={`mt-3 grid gap-3 md:grid-cols-2 ${canModify ? "" : "opacity-60 pointer-events-none"}`}>
                          <div className="space-y-2">
                            <label className="block text-[11px] text-brand-textMuted">Name</label>
                            <input
                              aria-label="Shop name"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value)}
                              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            />
                          </div>

                          <div className="space-y-2">
                            <label className="block text-[11px] text-brand-textMuted">Slug</label>
                            <input
                              aria-label="Shop slug"
                              value={editSlug}
                              onChange={(e) => setEditSlug(e.target.value)}
                              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <label className="block text-[11px] text-brand-textMuted">URL</label>
                            <input
                              aria-label="Shop URL"
                              value={editUrl}
                              onChange={(e) => setEditUrl(e.target.value)}
                              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <label className="block text-[11px] text-brand-textMuted">Description</label>
                            <input
                              aria-label="Shop description"
                              value={editDescription}
                              onChange={(e) => setEditDescription(e.target.value)}
                              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            />
                          </div>

                          <div className="space-y-2 md:col-span-2">
                            <label className="block text-[11px] text-brand-textMuted">Tags</label>
                            <input
                              aria-label="Shop tags"
                              value={editTagsText}
                              onChange={(e) => setEditTagsText(e.target.value)}
                              className="no-zoom-input w-full rounded-lg border border-zinc-700 bg-black/60 px-3 py-2 text-sm text-brand-text outline-none focus:border-amber-400/80"
                            />
                          </div>

                          <div className="flex flex-wrap items-center gap-3 md:col-span-2">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] text-brand-textMuted">Trust:</span>
                              <MenuSelect
                                ariaLabel="Trust status"
                                value={editTrustStatus}
                                onChange={(v) => setEditTrustStatus(v as TrustStatus)}
                                options={trustOptions as any}
                                className="flex h-9 items-center gap-2 rounded-xl border border-zinc-800 bg-black/40 px-3 text-xs text-brand-text outline-none transition-all hover:border-amber-400/80"
                                menuClassName="mt-2 w-56 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
                              />
                            </div>

                            <input
                              value={editWarningText}
                              onChange={(e) => setEditWarningText(e.target.value)}
                              className={
                                editTrustStatus === "untrusted"
                                  ? "no-zoom-input flex-1 min-w-[240px] rounded-lg border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100 outline-none focus:border-rose-300/60"
                                  : "no-zoom-input flex-1 min-w-[240px] rounded-lg border border-amber-400/25 bg-amber-500/5 px-3 py-2 text-sm text-amber-100/90 outline-none focus:border-amber-300/40"
                              }
                              placeholder="Caution text shown publicly"
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2 md:justify-end">
                      <div className="inline-flex overflow-hidden rounded-full border border-zinc-700 bg-black/40">
                        <button
                          type="button"
                          onClick={() => void move(s.id, "up")}
                          disabled={upDisabled}
                          className="px-2 py-1 text-[11px] text-brand-textMuted hover:text-brand-text disabled:opacity-50"
                          title="Move up"
                        >
                          ↑
                        </button>
                        <div className="w-px bg-zinc-700/70" />
                        <button
                          type="button"
                          onClick={() => void move(s.id, "down")}
                          disabled={downDisabled}
                          className="px-2 py-1 text-[11px] text-brand-textMuted hover:text-brand-text disabled:opacity-50"
                          title="Move down"
                        >
                          ↓
                        </button>
                      </div>

                      <CtaButton onClick={() => void toggleFeatured(s)} disabled={disabled || !canModify}>
                        {s.featured ? "Unfeature" : "Feature"}
                      </CtaButton>

                      <CtaButton onClick={() => void togglePublished(s)} disabled={disabled || !canPublish}>
                        {s.is_published ? "Unpublish" : "Publish"}
                      </CtaButton>

                      <CtaButton
                        onClick={() => router.push(`/shops/${encodeURIComponent(s.slug)}`)}
                        disabled={disabled || !s.slug}
                      >
                        View
                      </CtaButton>

                      {!isEditing ? (
                          <CtaButton onClick={() => beginEdit(s)} disabled={disabled || !canModify}>
                          Edit
                        </CtaButton>
                      ) : (
                        <>
                          <CtaButton variant="primary" onClick={() => void saveEdit(s.id)} disabled={disabled || !canModify}>
                            Save
                          </CtaButton>

                          <CtaButton onClick={cancelEdit} disabled={disabled}>
                            Cancel
                          </CtaButton>
                        </>
                      )}

                      <CtaButton variant="danger" onClick={() => void removeShop(s.id)} disabled={disabled || !canDelete}>
                        {disabled ? "Working…" : "Delete"}
                      </CtaButton>
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredShops.length > visibleCount && (
              <div className="flex items-center justify-center pt-1">
                <CtaButton
                  variant="secondary"
                  onClick={() => setVisibleCount((p) => p + 10)}
                >
                  Show more
                </CtaButton>
              </div>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
