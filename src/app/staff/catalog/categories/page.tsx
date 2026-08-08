"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { LoadingState, PageHeader, StaffPage } from "@/components/staff/StaffPage";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { Notice } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import {
  buildCategoryTree,
  categoryNameProblem,
  deletionProblem,
  normalizeCategoryName,
  parentProblem,
  type CategoryRow,
} from "@/lib/commerce/categories";

/**
 * Category management.
 *
 * The API for this has existed since pass 6 with no page in front of it, so
 * the only way to add a category was a hand-written request. Everything here
 * drives `/api/staff/catalog/categories`; nothing writes the table directly,
 * so the route's rules — one level of nesting, unique sibling names, deletion
 * refused while anything still points at the category — apply whether the
 * change comes from this page or anywhere else.
 *
 * The domain rules are imported from `categories.ts`, the same module the
 * route imports. A disabled control and a refused request therefore agree by
 * construction rather than by both being kept up to date.
 *
 * **A failed load is never rendered as an empty catalog.** `categories` stays
 * null until a request actually succeeds, so "No categories yet" cannot be
 * reached by a 500 — the defect pass 10 audited the whole staff area for.
 */

type Loaded = {
  categories: CategoryRow[];
  productCounts: Record<string, number>;
  uncategorized: number;
};

type Draft = {
  name: string;
  slug: string;
  description: string;
  parentId: string | null;
  isActive: boolean;
};

const emptyDraft = (): Draft => ({ name: "", slug: "", description: "", parentId: null, isActive: true });

export default function StaffCategoriesPage() {
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canManage = permissions.has("catalog.categories.manage");

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const [newDraft, setNewDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Draft>(emptyDraft);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/staff/catalog/categories");
      if (!response.ok) throw new Error(String(response.status));
      const body = (await response.json()) as Loaded;
      setLoaded({
        categories: body.categories ?? [],
        productCounts: body.productCounts ?? {},
        uncategorized: body.uncategorized ?? 0,
      });
      setLoadFailed(false);
    } catch {
      // The rows are cleared rather than left stale: a list from two minutes
      // ago sitting under a red banner is read as the current list.
      setLoaded(null);
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (accessLoading || !canManage) return;
    void load();
  }, [accessLoading, canManage, load]);

  const rows = loaded?.categories ?? null;

  const tree = useMemo(() => {
    if (!rows) return null;
    const counts = new Map(Object.entries(loaded?.productCounts ?? {}));
    return buildCategoryTree(rows, counts);
  }, [rows, loaded]);

  const parentOptions = useMemo(() => {
    const tops = (rows ?? []).filter((row) => !row.parent_id);
    return [
      { value: "", label: "Top level" },
      ...tops.map((row) => ({ value: row.id, label: row.name })),
    ];
  }, [rows]);

  async function send(url: string, init: RequestInit, key: string) {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      const response = await fetch(url, {
        ...init,
        headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        // The route's own sentence: it names the category, the conflict or the
        // rule, and is written to be shown. A 500 has no such sentence, so it
        // gets a generic one rather than whatever Postgres said.
        setError(response.status >= 500 ? "That did not save. Try again." : body.error || "That did not save.");
        return false;
      }
      await load();
      return true;
    } catch {
      setError("That did not save. Check your connection and try again.");
      return false;
    } finally {
      setBusy(null);
    }
  }

  const createProblem = rows ? categoryNameProblem(newDraft.name, rows, newDraft.parentId) : null;

  async function create() {
    if (!rows) return;
    if (createProblem === "blank") return setError("Give the category a name.");
    if (createProblem === "duplicate") return setError(`A category named “${normalizeCategoryName(newDraft.name)}” already exists here.`);
    const ok = await send(
      "/api/staff/catalog/categories",
      {
        method: "POST",
        body: JSON.stringify({
          name: newDraft.name,
          description: newDraft.description,
          parentId: newDraft.parentId,
        }),
      },
      "create"
    );
    if (ok) {
      setNewDraft(emptyDraft());
      setNotice("Category created.");
    }
  }

  function beginEdit(row: CategoryRow) {
    setEditingId(row.id);
    setEditDraft({
      name: row.name,
      slug: row.slug,
      description: row.description ?? "",
      parentId: row.parent_id,
      isActive: row.is_active,
    });
    setError("");
    setNotice("");
  }

  const editParentProblem =
    rows && editingId ? parentProblem(editingId, editDraft.parentId, rows) : null;

  async function saveEdit() {
    if (!editingId || !rows) return;
    if (editParentProblem) return setError(editParentProblem);
    const ok = await send(
      `/api/staff/catalog/categories/${editingId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          name: editDraft.name,
          slug: editDraft.slug,
          description: editDraft.description,
          parentId: editDraft.parentId,
          isActive: editDraft.isActive,
        }),
      },
      `save-${editingId}`
    );
    if (ok) {
      setEditingId(null);
      setNotice("Category saved.");
    }
  }

  async function setArchived(row: CategoryRow, archived: boolean) {
    if (
      archived &&
      !window.confirm(
        `Archive “${row.name}”? It disappears from the storefront browse menu. Products stay where they are and nothing is deleted.`
      )
    ) {
      return;
    }
    const ok = await send(
      `/api/staff/catalog/categories/${row.id}`,
      { method: "PATCH", body: JSON.stringify({ archived }) },
      `archive-${row.id}`
    );
    if (ok) setNotice(archived ? "Category archived." : "Category restored. Set it active to show it again.");
  }

  async function remove(row: CategoryRow, directCount: number) {
    if (!rows) return;
    // The route re-checks this; showing it first turns a refusal into an
    // explanation before the click rather than after it.
    const blocked = deletionProblem(row, rows, directCount);
    if (blocked) return setError(blocked);
    if (!window.confirm(`Delete “${row.name}” permanently? This cannot be undone.`)) return;
    const ok = await send(`/api/staff/catalog/categories/${row.id}`, { method: "DELETE" }, `delete-${row.id}`);
    if (ok) setNotice("Category deleted.");
  }

  async function move(row: CategoryRow, siblings: CategoryRow[], direction: -1 | 1) {
    const index = siblings.findIndex((item) => item.id === row.id);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= siblings.length) return;
    const reordered = [...siblings];
    [reordered[index], reordered[target]] = [reordered[target], reordered[index]];
    await send(
      "/api/staff/catalog/categories",
      {
        method: "PUT",
        body: JSON.stringify({
          order: reordered.map((item, position) => ({ id: item.id, displayOrder: position })),
        }),
      },
      `move-${row.id}`
    );
  }

  if (accessLoading) return <LoadingState>Checking access…</LoadingState>;
  if (!canManage) {
    return (
      <AccessDeniedCard
        title="Categories need a permission you do not have"
        message="Ask an administrator for catalog.categories.manage."
      />
    );
  }

  const counts = loaded?.productCounts ?? {};

  return (
    /*
     * The page wrapper was `page-container` — a *second* max-width container
     * inside the staff shell's own `page-container-wide`, so this page was
     * measurably narrower than Products beside it in the same menu group and
     * its gutters did not line up. Every staff page now uses `StaffPage`,
     * which sets no width of its own and inherits the shell's.
     */
    <StaffPage>
      <PageHeader
        title="Categories"
        description="The storefront browse menu. A top-level category becomes /catalog/<slug>, and a subcategory becomes /catalog/<parent>/<slug> — one level of nesting only, because the database refuses a parent that already has one."
      >
        <p className="staff-page-description">
          A category with no products in it and no subcategories is hidden from the storefront menu, so an
          empty category never becomes a dead click for a customer.
        </p>
      </PageHeader>

      {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      {notice ? <Notice tone="success" role="status">{notice}</Notice> : null}

      <section className="ui-card p-5">
        <h2 className="text-lg font-semibold">Add a category</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-sm">
            Name
            <input
              className="ui-input mt-1 w-full"
              value={newDraft.name}
              maxLength={80}
              onChange={(event) => setNewDraft((current) => ({ ...current, name: event.target.value }))}
              placeholder="Interior"
            />
          </label>
          <label className="text-sm">
            Parent
            <MenuSelect
              ariaLabel="Parent category"
              className="ui-select-trigger mt-1 w-full"
              value={newDraft.parentId ?? ""}
              onChange={(value) => setNewDraft((current) => ({ ...current, parentId: value || null }))}
              options={parentOptions}
            />
          </label>
          <label className="text-sm sm:col-span-2">
            Description <span className="text-brand-textMuted">(shown on the category page)</span>
            <input
              className="ui-input mt-1 w-full"
              value={newDraft.description}
              maxLength={500}
              onChange={(event) => setNewDraft((current) => ({ ...current, description: event.target.value }))}
              placeholder="Shift knobs, trim and cabin hardware."
            />
          </label>
        </div>
        <div className="ui-action-row mt-4">
          <button
            type="button"
            onClick={() => void create()}
            disabled={busy === "create" || !newDraft.name.trim() || !rows}
            className="ui-btn ui-btn-primary disabled:opacity-50"
          >
            {busy === "create" ? "Adding…" : "Add category"}
          </button>
          {/* The slug is derived from the name and can be edited afterwards.
              Offering it here would invite a slug that does not match a name
              still being typed. */}
          <span className="text-xs text-brand-textMuted">The address is derived from the name; edit it after.</span>
        </div>
      </section>

      {loading && !loaded ? (
        <p className="mt-6 text-brand-textMuted">Loading categories…</p>
      ) : loadFailed ? (
        <Notice tone="danger" role="alert" className="mt-6">
          The categories could not be loaded, so none are listed below. This is not an empty catalog.{" "}
          <button type="button" onClick={() => void load()} className="underline hover:no-underline">
            Try again
          </button>
        </Notice>
      ) : tree && tree.length === 0 ? (
        <div className="ui-empty-state mt-6 !p-10">
          <h2 className="text-lg font-semibold text-brand-text">No categories yet.</h2>
          <p className="mt-2">
            That is a complete answer — the query succeeded and found none. Add one above, then assign
            products to it from <Link href="/staff/catalog" className="underline">Products</Link>.
          </p>
        </div>
      ) : tree ? (
        <section className="mt-6 grid gap-3">
          {tree.map((parent, parentIndex) => {
            const parentSiblings = tree.map((node) => node as CategoryRow);
            return (
              <div key={parent.id} className="ui-card p-4">
                <CategoryHeader
                  row={parent}
                  directCount={counts[parent.id] ?? 0}
                  totalCount={parent.totalProductCount}
                  path={`/catalog/${parent.slug}`}
                  canMoveUp={parentIndex > 0}
                  canMoveDown={parentIndex < tree.length - 1}
                  busy={busy}
                  onMove={(direction) => void move(parent, parentSiblings, direction)}
                  onEdit={() => beginEdit(parent)}
                  onArchive={(archived) => void setArchived(parent, archived)}
                  onDelete={() => void remove(parent, counts[parent.id] ?? 0)}
                />

                {editingId === parent.id ? (
                  <EditForm
                    draft={editDraft}
                    setDraft={setEditDraft}
                    parentOptions={parentOptions.filter((option) => option.value !== parent.id)}
                    problem={editParentProblem}
                    busy={busy === `save-${parent.id}`}
                    onCancel={() => setEditingId(null)}
                    onSave={() => void saveEdit()}
                  />
                ) : null}

                {parent.children.length ? (
                  <ul className="mt-3 grid gap-2 border-t border-brand-border pt-3">
                    {parent.children.map((child, childIndex) => (
                      <li key={child.id} className="rounded-xl border border-brand-border p-3">
                        <CategoryHeader
                          row={child}
                          directCount={counts[child.id] ?? 0}
                          totalCount={counts[child.id] ?? 0}
                          path={`/catalog/${parent.slug}/${child.slug}`}
                          canMoveUp={childIndex > 0}
                          canMoveDown={childIndex < parent.children.length - 1}
                          busy={busy}
                          onMove={(direction) => void move(child, parent.children, direction)}
                          onEdit={() => beginEdit(child)}
                          onArchive={(archived) => void setArchived(child, archived)}
                          onDelete={() => void remove(child, counts[child.id] ?? 0)}
                        />
                        {editingId === child.id ? (
                          <EditForm
                            draft={editDraft}
                            setDraft={setEditDraft}
                            parentOptions={parentOptions}
                            problem={editParentProblem}
                            busy={busy === `save-${child.id}`}
                            onCancel={() => setEditingId(null)}
                            onSave={() => void saveEdit()}
                          />
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            );
          })}

          {loaded && loaded.uncategorized > 0 ? (
            <p className="text-sm text-brand-textMuted">
              {loaded.uncategorized} product{loaded.uncategorized === 1 ? " is" : "s are"} in no category. They
              still appear under All products, but not in any category page.
            </p>
          ) : null}
        </section>
      ) : null}
    </StaffPage>
  );
}

function CategoryHeader({
  row,
  directCount,
  totalCount,
  path,
  canMoveUp,
  canMoveDown,
  busy,
  onMove,
  onEdit,
  onArchive,
  onDelete,
}: {
  row: CategoryRow;
  directCount: number;
  totalCount: number;
  path: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  busy: string | null;
  onMove: (direction: -1 | 1) => void;
  onEdit: () => void;
  onArchive: (archived: boolean) => void;
  onDelete: () => void;
}) {
  const archived = Boolean(row.archived_at);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-brand-text">{row.name}</span>
          {archived ? <span className="ui-badge ui-badge-danger">Archived</span> : null}
          {!archived && !row.is_active ? <span className="ui-badge">Hidden</span> : null}
        </div>
        <p className="mt-1 text-xs text-brand-textMuted">
          <Link href={path} className="underline hover:no-underline">
            {path}
          </Link>
          {" · "}
          {directCount} direct
          {totalCount !== directCount ? ` · ${totalCount} including subcategories` : null}
        </p>
        {row.description ? <p className="mt-1 text-sm text-brand-textMuted">{row.description}</p> : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onMove(-1)}
          disabled={!canMoveUp || busy === `move-${row.id}`}
          aria-label={`Move ${row.name} up`}
          className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-40"
        >
          ↑
        </button>
        <button
          type="button"
          onClick={() => onMove(1)}
          disabled={!canMoveDown || busy === `move-${row.id}`}
          aria-label={`Move ${row.name} down`}
          className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-40"
        >
          ↓
        </button>
        <button type="button" onClick={onEdit} className="ui-btn ui-btn-secondary !py-1.5 text-sm">
          Edit
        </button>
        <button
          type="button"
          onClick={() => onArchive(!archived)}
          disabled={busy === `archive-${row.id}`}
          className="ui-btn ui-btn-ghost !py-1.5 text-sm disabled:opacity-50"
        >
          {archived ? "Restore" : "Archive"}
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={busy === `delete-${row.id}`}
          className="ui-btn ui-btn-danger !py-1.5 text-sm disabled:opacity-50"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function EditForm({
  draft,
  setDraft,
  parentOptions,
  problem,
  busy,
  onCancel,
  onSave,
}: {
  draft: Draft;
  setDraft: (updater: (current: Draft) => Draft) => void;
  parentOptions: { value: string; label: string }[];
  problem: string | null;
  busy: boolean;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <div className="mt-3 grid gap-3 border-t border-brand-border pt-3 sm:grid-cols-2">
      <label className="text-sm">
        Name
        <input
          className="ui-input mt-1 w-full"
          value={draft.name}
          maxLength={80}
          onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
        />
      </label>
      <label className="text-sm">
        Address slug
        <input
          className="ui-input mt-1 w-full"
          value={draft.slug}
          maxLength={60}
          onChange={(event) => setDraft((current) => ({ ...current, slug: event.target.value }))}
        />
        {/* Stated where it is edited, because the refusal comes from a trigger
            and would otherwise arrive as a bare conflict. */}
        <span className="mt-1 block text-xs text-brand-textMuted">
          Must not match a product address; /catalog holds one address space.
        </span>
      </label>
      <label className="text-sm">
        Parent
        <MenuSelect
          ariaLabel="Parent category"
          className="ui-select-trigger mt-1 w-full"
          value={draft.parentId ?? ""}
          onChange={(value) => setDraft((current) => ({ ...current, parentId: value || null }))}
          options={parentOptions}
        />
      </label>
      <label className="flex items-center gap-2 text-sm sm:mt-6">
        <input
          type="checkbox"
          checked={draft.isActive}
          onChange={(event) => setDraft((current) => ({ ...current, isActive: event.target.checked }))}
        />
        Show in the storefront browse menu
      </label>
      <label className="text-sm sm:col-span-2">
        Description
        <input
          className="ui-input mt-1 w-full"
          value={draft.description}
          maxLength={500}
          onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
        />
      </label>

      {problem ? (
        <p role="alert" className="text-sm text-amber-200 sm:col-span-2">
          {problem}
        </p>
      ) : null}

      <div className="ui-action-row sm:col-span-2">
        <button
          type="button"
          onClick={onSave}
          disabled={busy || Boolean(problem) || !draft.name.trim()}
          className="ui-btn ui-btn-primary disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} className="ui-btn ui-btn-ghost">
          Cancel
        </button>
      </div>
    </div>
  );
}
