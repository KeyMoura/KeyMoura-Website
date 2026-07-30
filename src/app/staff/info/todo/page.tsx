"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { isString } from "@/lib/typeGuards";
import { MenuSelect } from "@/components/ui/MenuSelect";


type TodoStatus = "open" | "in_progress" | "done";
type TodoPriority = "low" | "normal" | "high";

type AdminTodo = {
  id: string;
  created_at: string;
  updated_at: string | null;
  created_by: string | null;
  created_by_name: string | null;
  status: TodoStatus | string | null;
  title: string;
  description: string | null;
  priority: TodoPriority | string | null;
  related_info_page_id: string | null;
  related_info_page_slug: string | null;
  done_at: string | null;
  done_by: string | null;
  done_by_name: string | null;
  resolution_notes: string | null;
  // Optional. When present, this tracks edits to content fields only.
  content_updated_at?: string | null;
};

const priorityOptions = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
] as const;

type LoadState = "idle" | "loading" | "loaded" | "error";

type CurrentUser = {
  id: string;
  email: string | null;
};

function formatDateShort(value: string | null | undefined) {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function StatusBadge({ status }: { status: TodoStatus | string | null }) {
  const s = (status ?? "open").toLowerCase() as TodoStatus | string;

  let label = s;
  let cls =
    "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide";

  if (s === "done") {
    label = "Done";
    cls += " border-emerald-500/70 bg-emerald-500/15 text-emerald-300";
  } else if (s === "in_progress") {
    label = "In progress";
    cls += " border-sky-400/70 bg-sky-500/15 text-sky-300";
  } else {
    label = "Open";
    cls += " border-amber-400/70 bg-amber-500/15 text-amber-300";
  }

  return <span className={cls}>{label}</span>;
}

function PriorityBadge({
  priority,
}: {
  priority: TodoPriority | string | null;
}) {
  const p = (priority ?? "normal").toLowerCase() as TodoPriority | string;

  let label = p;
  let cls =
    "rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide";

  if (p === "high") {
    label = "High";
    cls += " border-rose-500/80 bg-rose-500/15 text-rose-300";
  } else if (p === "low") {
    label = "Low";
    cls += " border-zinc-500/80 bg-zinc-500/10 text-zinc-300";
  } else {
    label = "Normal";
    cls += " border-sky-400/70 bg-sky-500/10 text-sky-300";
  }

  return <span className={cls}>{label}</span>;
}

export default function InfoAdminTodoPage() {
  const [state, setState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [todos, setTodos] = useState<AdminTodo[]>([]);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);

  // staff guard (admin / moderator / support)
  const [isAllowed, setIsAllowed] = useState<boolean | null>(null);
  const [mePermissions, setMePermissions] = useState<Set<string>>(new Set());
  const [guardError, setGuardError] = useState<string | null>(null);

  // new task form
  const [newTitle, setNewTitle] = useState("");
  const [newDescription, setNewDescription] = useState("");
  const [newPriority, setNewPriority] = useState<TodoPriority>("normal");
  const [newRelatedSlug, setNewRelatedSlug] = useState("");

  // which todo is being edited for notes
  const [editingNotesId, setEditingNotesId] = useState<string | null>(null);
  const [editingNotesText, setEditingNotesText] = useState("");

  // inline edit for open tasks
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  const [editingDescription, setEditingDescription] = useState("");
  const [editingPriority, setEditingPriority] = useState<TodoPriority>("normal");
  const [editingRelatedSlug, setEditingRelatedSlug] = useState("");

  // --- staff & user check ---

  useEffect(() => {
    const checkStaffAndUser = async () => {
      try {
        const supabase = supabaseBrowser();

        const {
          data: { user },
          error: userError,
        } = await supabase.auth.getUser();

        if (userError || !user) {
          setIsAllowed(false);
          setGuardError("You must be logged in as staff to view this page.");
          return;
        }

        // Permission-based gate (no role checks)
        const accessRes = await fetch("/api/me/access", { method: "GET" });
        const accessJson = (await accessRes.json().catch(() => null)) as
          | { permissions?: string[] | null }
          | null;
        const perms = new Set(
          Array.isArray(accessJson?.permissions)
            ? accessJson!.permissions!.map(String)
            : []
        );
        // Page access is .view-only; moderation perms don't imply visibility.
        const allowed = perms.has("todo.view");
        if (!accessRes.ok || !allowed) {
          setIsAllowed(false);
          setGuardError("Access denied.");
          return;
        }

        setMePermissions(perms);

        setIsAllowed(true);
        setCurrentUser({
          id: user.id,
          email: user.email ?? null,
        });
      } catch (err) {
        console.error("Failed to check staff for todo page", err);
        setIsAllowed(false);
        setGuardError("Unexpected error checking staff status.");
      }
    };

    void checkStaffAndUser();
  }, []);

  // --- load todos (only if staff) ---

  useEffect(() => {
    if (isAllowed !== true) return;

    const load = async () => {
      setState("loading");
      setErrorMessage(null);

      try {
        const res = await fetch("/api/staff/info/todo", { method: "GET" });
        const json = (await res.json().catch(() => null)) as any;
        if (!res.ok) {
          console.error("Error loading todo", json);
          setErrorMessage(isString(json?.error) ? json.error : "Failed to load todo list.");
          setTodos([]);
          setState("error");
          return;
        }
        setTodos(((json?.items as unknown) ?? []) as AdminTodo[]);
        setState("loaded");
      } catch (err) {
        console.error("Unexpected error loading info_admin_todos", err);
        setErrorMessage("Unexpected error loading todo list.");
        setTodos([]);
        setState("error");
      }
    };

    void load();
  }, [isAllowed]);

  const isLoading = state === "loading";

  // derived groups
  const openAndInProgress = useMemo(
    () =>
      todos.filter((t) => {
        const s = (t.status ?? "open").toLowerCase();
        return s === "open" || s === "in_progress";
      }),
    [todos]
  );

  const completed = useMemo(
    () => todos.filter((t) => (t.status ?? "").toLowerCase() === "done"),
    [todos]
  );

  // create new todo
  const handleCreateTodo = async () => {
    const title = newTitle.trim();
    if (!title) return;

    try {
      const res = await fetch("/api/staff/info/todo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          description: newDescription.trim() || null,
          priority: newPriority,
          related_info_page_slug: newRelatedSlug.trim() || null,
        }),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        console.error("Failed to create todo", json);
        setErrorMessage(isString(json?.error) ? json.error : "Failed to create todo.");
        return;
      }
      const item = (json?.item as AdminTodo) ?? null;
      if (!item) {
        setErrorMessage("Failed to create todo.");
        return;
      }
      setTodos((prev) => [item, ...prev]);
    } catch (err) {
      console.error("Failed to create todo", err);
      setErrorMessage("Failed to create todo.");
      return;
    }
    setNewTitle("");
    setNewDescription("");
    setNewPriority("normal");
    setNewRelatedSlug("");
  };

  // change status helper
  const updateTodoStatus = async (todo: AdminTodo, status: TodoStatus) => {
    const nowISO = new Date().toISOString();

    const isDone = status === "done";

    try {
      const res = await fetch("/api/staff/info/todo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: todo.id,
          status,
          done_at: isDone ? nowISO : null,
          done_by: isDone ? currentUser?.id ?? null : null,
          done_by_name: isDone ? currentUser?.email ?? null : null,
        }),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        console.error("Failed to update todo status", json);
        setErrorMessage(isString(json?.error) ? json.error : "Failed to update todo status.");
        return;
      }
      const item = (json?.item as AdminTodo) ?? null;
      if (!item) {
        setErrorMessage("Failed to update todo status.");
        return;
      }
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? item : t)));
    } catch (err) {
      console.error("Failed to update todo status", err);
      setErrorMessage("Failed to update todo status.");
    }
  };

  // edit notes (description + resolution_notes)
  const startEditingNotes = (todo: AdminTodo) => {
    setEditingNotesId(todo.id);
    setEditingNotesText(todo.resolution_notes ?? todo.description ?? "");
  };

  const cancelEditingNotes = () => {
    setEditingNotesId(null);
    setEditingNotesText("");
  };

  const startEditingTask = (todo: AdminTodo) => {
    setEditingTaskId(todo.id);
    setEditingTitle(todo.title ?? "");
    setEditingDescription(todo.description ?? "");
    setEditingPriority((todo.priority ?? "normal") as TodoPriority);
    setEditingRelatedSlug(todo.related_info_page_slug ?? "");
  };

  const cancelEditingTask = () => {
    setEditingTaskId(null);
    setEditingTitle("");
    setEditingDescription("");
    setEditingPriority("normal");
    setEditingRelatedSlug("");
  };

  const saveTaskEdits = async (todo: AdminTodo) => {
    if (!canEditTask) return;
    const title = editingTitle.trim();
    if (!title) {
      setErrorMessage("Title is required.");
      return;
    }

    try {
      const res = await fetch("/api/staff/info/todo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: todo.id,
          title,
          description: editingDescription.trim() || null,
          priority: editingPriority,
          related_info_page_slug: editingRelatedSlug.trim() || null,
        }),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        console.error("Failed to update task", json);
        setErrorMessage(isString(json?.error) ? json.error : "Failed to update task.");
        return;
      }
      const item = (json?.item as AdminTodo) ?? null;
      if (!item) {
        setErrorMessage("Failed to update task.");
        return;
      }
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? item : t)));
    } catch (err) {
      console.error("Failed to update task", err);
      setErrorMessage("Failed to update task.");
      return;
    }
    cancelEditingTask();
  };

  const saveNotes = async (todo: AdminTodo) => {
    const text = editingNotesText.trim();

    try {
      const res = await fetch("/api/staff/info/todo", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: todo.id, resolution_notes: text || null }),
      });
      const json = (await res.json().catch(() => null)) as any;
      if (!res.ok) {
        console.error("Failed to save notes", json);
        setErrorMessage(isString(json?.error) ? json.error : "Failed to save notes.");
        return;
      }
      const item = (json?.item as AdminTodo) ?? null;
      if (!item) {
        setErrorMessage("Failed to save notes.");
        return;
      }
      setTodos((prev) => prev.map((t) => (t.id === todo.id ? item : t)));
    } catch (err) {
      console.error("Failed to save notes", err);
      setErrorMessage("Failed to save notes.");
      return;
    }
    setEditingNotesId(null);
    setEditingNotesText("");
  };

  const canCreateTask = mePermissions.has("todo.create_task");
  const canEditTask = mePermissions.has("todo.edit");
  const canMarkDone = mePermissions.has("todo.mark_done");

  const renderTodoCard = (todo: AdminTodo, completedSection = false) => {
    const status = (todo.status ?? "open").toLowerCase() as
      | TodoStatus
      | string;
    const priority = (todo.priority ?? "normal") as TodoPriority | string;

    const isEditing = editingNotesId === todo.id;

    return (
      <div
        key={todo.id}
        className="flex flex-col rounded-lg border border-zinc-800/80 bg-black/40 p-3 text-[12px] text-brand-text"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {editingTaskId === todo.id ? (
                <input
                  value={editingTitle}
                  onChange={(e) => setEditingTitle(e.target.value)}
                  className="h-8 w-full max-w-[520px] rounded-lg border border-zinc-800 bg-black/40 px-3 text-[13px] font-semibold text-brand-text outline-none focus:border-amber-400"
                  placeholder="Title"
                />
              ) : (
                <span className="text-[13px] font-semibold text-brand-text">
                  {todo.title}
                </span>
              )}
              <StatusBadge status={status} />
              <PriorityBadge priority={priority} />
            </div>
            <div className="mt-1 text-[11px] text-brand-textMuted">
              Created {formatDateShort(todo.created_at)}{" "}
              {(() => {
                const editedAt = todo.content_updated_at ?? null;
                if (!editedAt) return null;
                if (editedAt === todo.created_at) return null;
                return <span className="ml-1 text-[11px] text-brand-textMuted">• Edited {formatDateShort(editedAt)}</span>;
              })()}
              {todo.created_by_name && (
                <>
                  by{" "}
                  <span className="font-medium">
                    {todo.created_by_name}
                  </span>
                </>
              )}
            </div>
            {status === "done" && (todo.done_at || todo.done_by_name) && (
              <div className="mt-0.5 text-[11px] text-emerald-300/80">
                Done {formatDateShort(todo.done_at)}{" "}
                {todo.done_by_name && (
                  <>
                    by{" "}
                    <span className="font-medium">
                      {todo.done_by_name}
                    </span>
                  </>
                )}
              </div>
            )}

            {editingTaskId === todo.id ? (
              <div className="mt-3 space-y-2">
                <textarea
                  value={editingDescription}
                  onChange={(e) => setEditingDescription(e.target.value)}
                  rows={4}
                  className="w-full rounded-lg border border-zinc-800 bg-black/40 px-3 py-2 text-[12px] text-brand-text outline-none focus:border-amber-400"
                  placeholder="Description"
                />
                <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
                  <div className="flex flex-col">
                    <span className="mb-1 text-[11px] text-brand-textMuted">Priority</span>
                    <MenuSelect
                      ariaLabel="Priority"
                      value={editingPriority}
                      onChange={(v) => setEditingPriority(v as TodoPriority)}
                      options={priorityOptions as any}
                      className="flex h-9 items-center gap-2 rounded-lg border border-zinc-800 bg-black/40 px-3 text-[12px] text-brand-text outline-none transition hover:border-amber-400"
                      menuClassName="mt-2 w-44 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
                      align="left"
                    />
                  </div>
                  <div className="flex flex-col md:col-span-2">
                    <span className="mb-1 text-[11px] text-brand-textMuted">Related page slug (optional)</span>
                    <input
                      value={editingRelatedSlug}
                      onChange={(e) => setEditingRelatedSlug(e.target.value)}
                      className="h-9 rounded-lg border border-zinc-800 bg-black/40 px-3 text-[12px] text-brand-text outline-none focus:border-amber-400"
                      placeholder="example-page-slug"
                    />
                  </div>
                </div>
              </div>
            ) : null}
          </div>

          {/* Links to related info page */}
          <div className="flex flex-col items-end gap-1 text-[11px]">
            {todo.related_info_page_slug && (
              <Link
                href={`/${todo.related_info_page_slug}`}
                className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted hover:text-brand-text"
              >
                View page
              </Link>
            )}

            {!completedSection && status !== "done" && canEditTask && (
              <>
                {editingTaskId === todo.id ? (
                  <div className="flex flex-wrap items-center justify-end gap-1">
                    <button
                      type="button"
                      onClick={() => saveTaskEdits(todo)}
                      className="rounded-full border border-amber-400/70 bg-amber-500/15 px-2 py-0.5 text-amber-200 hover:bg-amber-500/25"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelEditingTask()}
                      className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-brand-textMuted hover:text-brand-text"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => startEditingTask(todo)}
                    className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2 py-0.5 text-amber-200 hover:bg-amber-500/20"
                  >
                    Edit task
                  </button>
                )}
              </>
            )}
            {!completedSection && status !== "done" && canMarkDone && (
              <>
                {status === "open" && (
                  <button
                    type="button"
                    onClick={() => updateTodoStatus(todo, "in_progress")}
                    className="rounded-full border border-sky-400/70 bg-sky-500/15 px-2 py-0.5 text-sky-200 hover:bg-sky-500/25"
                  >
                    Mark in progress
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => updateTodoStatus(todo, "done")}
                  className="rounded-full border border-emerald-500/70 bg-emerald-500/15 px-2 py-0.5 text-emerald-200 hover:bg-emerald-500/25"
                >
                  Mark done
                </button>
              </>
            )}
            {completedSection && canMarkDone && (
              <button
                type="button"
                onClick={() => updateTodoStatus(todo, "open")}
                className="rounded-full border border-amber-400/70 bg-amber-500/15 px-2 py-0.5 text-amber-200 hover:bg-amber-500/25"
              >
                Reopen
              </button>
            )}
          </div>
        </div>
        {/* Description / notes */}
        {todo.description && editingTaskId !== todo.id && (
          <p className="mt-2 text-[12px] text-brand-textMuted">
            {todo.description}
          </p>
        )}
        {todo.resolution_notes && !isEditing && editingTaskId !== todo.id && (
          <p className="mt-1 text-[11px] text-emerald-200/90">
            <span className="font-semibold">Notes:</span>{" "}
            {todo.resolution_notes}
          </p>
        )}
        {isEditing && canEditTask && (
          <div className="mt-2 space-y-1">
            <textarea
              value={editingNotesText}
              onChange={(e) => setEditingNotesText(e.target.value)}
              rows={3}
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1 text-[11px] text-brand-text outline-none"
              placeholder="Add resolution notes / extra context..."
            />
            <div className="flex justify-end gap-2 text-[11px]">
              <button
                type="button"
                onClick={() => saveNotes(todo)}
                disabled={!canEditTask}
                className="rounded-full border border-emerald-500/70 bg-emerald-500/15 px-3 py-0.5 text-emerald-200 hover:bg-emerald-500/25"
              >
                Save notes
              </button>
              <button
                type="button"
                onClick={cancelEditingNotes}
                className="rounded-full border border-zinc-700 bg-black/40 px-3 py-0.5 text-brand-textMuted hover:text-brand-text"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        {!isEditing && (
          <div className="mt-2 flex justify-between text-[10px] text-brand-textMuted">
            <div className="flex flex-wrap gap-2">
              <span>id: {todo.id}</span>
              {todo.related_info_page_slug && (
                <span className="rounded-full border border-zinc-700 bg-black/40 px-1.5 py-0.5">
                  related: /{todo.related_info_page_slug}
                </span>
              )}
            </div>
            {canEditTask ? (
              <button
                type="button"
                onClick={() => startEditingNotes(todo)}
                className="rounded-full border border-zinc-700 bg-black/40 px-2 py-0.5 text-[10px] text-brand-textMuted hover:text-brand-text"
              >
                {todo.resolution_notes ? "Edit notes" : "Add notes"}
              </button>
            ) : null}
          </div>
        )}
      </div>
    );
  };

  // --- staff gate render ---

  if (isAllowed === null) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
        <p className="text-sm text-brand-textMuted">Checking staff access…</p>
      </div>
    );
  }

  if (isAllowed === false) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 text-brand-text">
        <h1 className="mb-2 text-xl font-semibold">Staff Only</h1>
        <p className="text-sm text-brand-textMuted">
          {guardError ?? "You do not have permission to view this page."}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-8">
      {/* Header */}
      <section className="space-y-2">
        <p className="text-[11px] uppercase tracking-[0.15em] text-brand-textMuted">
          Staff • Info
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-brand-text sm:text-3xl">
          To-do list
        </h1>
        <p className="text-[12px] text-brand-textMuted sm:text-sm">
          Shared checklist for tasks related to the website.
        </p>
        <div className="mt-1 text-[11px] text-brand-textMuted">
          <Link
            href="/staff"
            className="underline underline-offset-2 text-amber-300 hover:text-amber-200"
          >
            ← Back to admin overview
          </Link>
        </div>
      </section>
      {/* Error */}
      {state === "error" && (
        <section>
          <p className="rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {errorMessage ?? "Failed to load todo list."}
          </p>
        </section>
      )}
      {/* New task form */}
      <section className="rounded-xl border border-zinc-800/80 bg-black/40 p-4 text-sm text-brand-text">
        <h2 className="text-sm font-semibold text-brand-text">
          Add a new task
        </h2>
        <p className="mb-2 text-[11px] text-brand-textMuted">
          Use this for things like “Write S13 subframe bushing guide” or
          “Review wiring page for mistakes”.
        </p>

        <div className="space-y-3">
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="flex-1">
              <label className="mb-1 block text-[11px] text-brand-textMuted">
                Title<span className="text-rose-400">*</span>
              </label>
              <input
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                disabled={!canCreateTask}
                placeholder="Write new S14 rear subframe install guide"
                className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
              />
            </div>

            <div className="w-full sm:w-40">
              <label className="mb-1 block text-[11px] text-brand-textMuted">
                Priority
              </label>
              <MenuSelect
                ariaLabel="Priority"
                value={newPriority}
                onChange={(v) => setNewPriority(v as TodoPriority)}
                options={priorityOptions as any}
                className={`flex h-9 w-full items-center gap-2 rounded-md border border-zinc-700 bg-black/60 px-2 text-[12px] text-brand-text outline-none transition hover:border-amber-400/80 ${
                  !canCreateTask ? "opacity-60 pointer-events-none" : ""
                }`}
                menuClassName="mt-2 w-44 overflow-hidden rounded-2xl border border-zinc-800 bg-black/95 shadow-2xl"
                align="left"
              />
            </div>
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Notes / description
            </label>
            <textarea
              value={newDescription}
              onChange={(e) => setNewDescription(e.target.value)}
              disabled={!canCreateTask}
              rows={3}
              placeholder="What needs to be done, any context, links, etc."
              className="no-zoom-input w-full rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
          </div>

          <div>
            <label className="mb-1 block text-[11px] text-brand-textMuted">
              Related info page slug (optional)
            </label>
            <input
              value={newRelatedSlug}
              onChange={(e) => setNewRelatedSlug(e.target.value)}
              disabled={!canCreateTask}
              placeholder="info/s14-subframe-bushings"
              className="w-full no-zoom-input rounded-md border border-zinc-700 bg-black/60 px-2 py-1.5 text-[12px] text-brand-text outline-none placeholder:text-zinc-500"
            />
            {newRelatedSlug.trim() && (
              <p className="mt-1 text-[10px] text-brand-textMuted">
                Will link to:{" "}
                <span className="text-amber-300">
                  /info/{newRelatedSlug.trim()}
                </span>
              </p>
            )}
          </div>

          <div className="flex items-center justify-between">
            <p className="text-[11px] text-brand-textMuted">
              Tasks will be attributed to your Supabase user (email) when
              created and when marked done.
            </p>
            <button
              type="button"
              onClick={handleCreateTodo}
              disabled={!canCreateTask || !newTitle.trim()}
              className="inline-flex items-center justify-center rounded-full border border-amber-400/80 bg-amber-500/20 px-4 py-1.5 text-[12px] font-medium text-amber-200 shadow-sm shadow-black/60 hover:bg-amber-500/30 disabled:cursor-not-allowed disabled:border-zinc-700 disabled:bg-black/40 disabled:text-zinc-500"
            >
              Add task
            </button>
          </div>
        </div>
      </section>
      {/* Open + in-progress */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-brand-text">
            Open & in progress
          </h2>
          <span className="text-[11px] text-brand-textMuted">
            {openAndInProgress.length} task
            {openAndInProgress.length === 1 ? "" : "s"}
          </span>
        </div>

        {isLoading ? (
          <p className="text-[12px] text-brand-textMuted">
            Loading todo list…
          </p>
        ) : openAndInProgress.length === 0 ? (
          <p className="text-[12px] text-brand-textMuted">
            Nothing open right now. New tasks will appear here.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {openAndInProgress.map((todo) =>
              renderTodoCard(todo, false)
            )}
          </div>
        )}
      </section>
      {/* Completed */}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-brand-text">
            Completed
          </h2>
          <span className="text-[11px] text-brand-textMuted">
            {completed.length} task
            {completed.length === 1 ? "" : "s"}
          </span>
        </div>

        {completed.length === 0 ? (
          <p className="text-[12px] text-brand-textMuted">
            No completed tasks yet.
          </p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {completed.map((todo) => renderTodoCard(todo, true))}
          </div>
        )}
      </section>
    </div>
  );
}
