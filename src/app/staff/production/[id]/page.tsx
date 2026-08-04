"use client";

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { Badge, EmptyState, Notice, Panel } from "@/components/ui/DesignSystem";
import { PriorityBadge, StatusBadge, DueDate } from "@/components/staff/production/JobBadges";
import { JobForm, type JobDraftState } from "@/components/staff/production/JobForm";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import {
  FILE_KIND_META,
  PRODUCTION_FILE_KINDS,
  PRODUCTION_TASK_KINDS,
  STATUS_META,
  TASK_KIND_META,
  checklistProgress,
  isTerminalStatus,
  nextStatusOptions,
  statusNeedsReason,
  transitionProblem,
  type ProductionFileKind,
  type ProductionStatus,
  type ProductionTaskKind,
} from "@/lib/production/jobs";

/**
 * The production job workspace.
 *
 * Everything about one job on one page: what it is, where it sits, what has to
 * happen to it, what it is made of, and what has been done to it. The
 * separations that matter are enforced rather than described —
 *
 *   · saving fields cannot move the job through the workflow
 *   · moving the job asks for confirmation and, where the state demands it, a reason
 *   · a stale page is refused rather than allowed to overwrite somebody else's change
 *   · internal and customer-visible content are labelled where they are edited
 */

const primary = "ui-btn ui-btn-primary disabled:opacity-50";
const subtle = "ui-btn ui-btn-ghost text-sm disabled:opacity-50";

type Job = {
  id: string;
  job_number: string;
  title: string;
  description: string | null;
  status: ProductionStatus;
  priority: "low" | "normal" | "high" | "urgent";
  order_id: string | null;
  product_id: string | null;
  customer_id: string | null;
  quantity: number;
  due_date: string | null;
  promised_date: string | null;
  assigned_to: string | null;
  estimated_minutes: number | null;
  actual_minutes: number | null;
  materials_required: string | null;
  materials_acquired: boolean;
  external_services_required: string | null;
  internal_notes: string | null;
  customer_visible_notes: string | null;
  hold_reason: string | null;
  failure_reason: string | null;
  rework_count: number;
  created_at: string;
  updated_at: string;
};

type Task = {
  id: string;
  kind: ProductionTaskKind;
  label: string;
  detail: string | null;
  is_done: boolean;
  done_by: string | null;
  done_at: string | null;
};

type JobFile = {
  id: string;
  kind: ProductionFileKind;
  label: string;
  storage_path: string | null;
  external_url: string | null;
  is_customer_visible: boolean;
};

type JobEvent = {
  id: string;
  actor_id: string | null;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  note: string | null;
  created_at: string;
};

type Payload = {
  job: Job;
  tasks: Task[];
  files: JobFile[];
  events: JobEvent[];
  people: Record<string, string>;
  orders: Record<string, { order_number: string | null; status: string }>;
  products: Record<string, { name: string; slug: string }>;
  canManage: boolean;
};

const toDraft = (job: Job): JobDraftState => ({
  title: job.title,
  description: job.description ?? "",
  priority: job.priority,
  quantity: String(job.quantity),
  dueDate: job.due_date ?? "",
  promisedDate: job.promised_date ?? "",
  assignedTo: job.assigned_to ?? "",
  estimatedMinutes: job.estimated_minutes == null ? "" : String(job.estimated_minutes),
  actualMinutes: job.actual_minutes == null ? "" : String(job.actual_minutes),
  materialsRequired: job.materials_required ?? "",
  materialsAcquired: job.materials_acquired,
  externalServicesRequired: job.external_services_required ?? "",
  internalNotes: job.internal_notes ?? "",
  customerVisibleNotes: job.customer_visible_notes ?? "",
});

export default function ProductionJobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("production.view") || permissions.has("production.manage");
  const canManage = permissions.has("production.manage");

  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  // A refusal is not a load failure — see the same note on the queue page.
  const [denied, setDenied] = useState(false);

  const [draft, setDraft] = useState<JobDraftState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<string[]>([]);

  const [targetStatus, setTargetStatus] = useState<ProductionStatus | "">("");
  const [reason, setReason] = useState("");
  const [pendingWarnings, setPendingWarnings] = useState<string[] | null>(null);

  const [now] = useState(() => new Date());
  const errorRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    setDenied(false);
    try {
      const response = await fetch(`/api/staff/production/jobs/${id}`, { credentials: "same-origin" });
      const body = await response.json().catch(() => null);
      if (response.status === 403) {
        setDenied(true);
        return;
      }
      if (!response.ok) throw new Error(body?.error || "Could not load the job.");
      setPayload(body as Payload);
      setDraft(toDraft((body as Payload).job));
      setTargetStatus("");
      setReason("");
      setPendingWarnings(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load the job.");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    if (canView) void load();
  }, [canView, load]);

  const job = payload?.job;

  // Comparing against the server's own view of the job, so "unsaved changes"
  // means the form differs from what is stored — not merely that it was typed in.
  const dirty = useMemo(() => {
    if (!job || !draft) return false;
    return JSON.stringify(draft) !== JSON.stringify(toDraft(job));
  }, [job, draft]);

  // A browser-level guard for the tab being closed mid-edit. The in-page guards
  // cover navigation we control; this covers the rest.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const patchDraft = useCallback((patch: Partial<JobDraftState>) => {
    setDraft((current) => (current ? { ...current, ...patch } : current));
    setFieldErrors([]);
  }, []);

  const saveFields = useCallback(async () => {
    if (!job || !draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    setFieldErrors([]);
    try {
      const response = await fetch(`/api/staff/production/jobs/${job.id}`, {
        method: "PATCH",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...draft, expectedUpdatedAt: job.updated_at }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        if (Array.isArray(body?.errors) && body.errors.length) setFieldErrors(body.errors);
        throw new Error(body?.error || "Could not save the job.");
      }
      setPayload((current) => (current ? { ...current, job: body.job } : current));
      setDraft(toDraft(body.job));
      setMessage(body.changed?.length ? "Saved." : "Nothing had changed.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the job.");
      errorRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }, [job, draft]);

  const changeStatus = useCallback(
    async (acknowledge: boolean) => {
      if (!job || !targetStatus) return;
      setBusy(true);
      setError("");
      setMessage("");
      try {
        const response = await fetch(`/api/staff/production/jobs/${job.id}/status`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            status: targetStatus,
            reason,
            reopen: isTerminalStatus(job.status),
            expectedStatus: job.status,
            acknowledge,
          }),
        });
        const body = await response.json().catch(() => null);

        if (response.status === 409 && body?.requiresAcknowledgement) {
          setPendingWarnings(body.warnings ?? []);
          return;
        }
        if (!response.ok) throw new Error(body?.error || "Could not change the status.");

        setPayload((current) => (current ? { ...current, job: body.job } : current));
        setDraft(toDraft(body.job));
        setMessage(`Moved to ${STATUS_META[targetStatus as ProductionStatus].label.toLowerCase()}.`);
        setTargetStatus("");
        setReason("");
        setPendingWarnings(null);
        void load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not change the status.");
        errorRef.current?.focus();
      } finally {
        setBusy(false);
      }
    },
    [job, targetStatus, reason, load]
  );

  const mutateTask = useCallback(
    async (init: RequestInit, query = "") => {
      if (!job) return;
      setBusy(true);
      setError("");
      try {
        const response = await fetch(`/api/staff/production/jobs/${job.id}/tasks${query}`, {
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          ...init,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Could not update the checklist.");
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update the checklist.");
      } finally {
        setBusy(false);
      }
    },
    [job, load]
  );

  const mutateFile = useCallback(
    async (init: RequestInit, query = "") => {
      if (!job) return;
      setBusy(true);
      setError("");
      try {
        const response = await fetch(`/api/staff/production/jobs/${job.id}/files${query}`, {
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          ...init,
        });
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error || "Could not update the files.");
        await load();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not update the files.");
      } finally {
        setBusy(false);
      }
    },
    [job, load]
  );

  if (accessLoading) {
    return (
      <div className="page-container">
        <p className="text-sm text-brand-textMuted" role="status">
          Checking your access…
        </p>
      </div>
    );
  }

  if (!canView || denied) {
    return (
      <AccessDeniedCard
        title="Production is restricted"
        message="You need the production.view permission to see this job. Ask an administrator to grant it to your role."
      />
    );
  }

  if (loading && !payload) {
    return (
      <div className="page-container">
        <p className="text-sm text-brand-textMuted" role="status">
          Loading the job…
        </p>
      </div>
    );
  }

  if (!payload || !job || !draft) {
    return (
      <div className="page-container space-y-4">
        <Notice tone="danger" role="alert">
          {error || "That job could not be found."}
        </Notice>
        <Link href="/staff/production" className={subtle}>
          Back to the queue
        </Link>
      </div>
    );
  }

  const proposedProblem =
    targetStatus && targetStatus !== job.status
      ? transitionProblem(job.status, targetStatus, { reason, reopen: isTerminalStatus(job.status) })
      : null;

  return (
    <div className="page-container space-y-6">
      <nav aria-label="Breadcrumb">
        <Link href="/staff/production" className="text-sm text-brand-textMuted underline">
          ← Production queue
        </Link>
      </nav>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-xs text-brand-textMuted">{job.job_number}</p>
          <h1 className="text-2xl font-semibold">{job.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusBadge status={job.status} />
            <PriorityBadge priority={job.priority} />
            <span className="text-xs">
              <DueDate job={job} now={now} />
            </span>
            {job.rework_count > 0 ? (
              <Badge tone="danger">
                Reworked {job.rework_count}×
              </Badge>
            ) : null}
          </div>
        </div>
        <Link href={`/staff/production/${job.id}/print`} className={subtle}>
          Print work order
        </Link>
      </header>

      <div
        ref={errorRef}
        tabIndex={-1}
        aria-live="assertive"
        className={error ? undefined : "sr-only"}
      >
        {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      </div>

      {message ? (
        <Notice tone="success" role="status">
          {message}
        </Notice>
      ) : null}

      {job.hold_reason ? (
        <Notice tone="warning">
          <strong>On hold:</strong> {job.hold_reason}
        </Notice>
      ) : null}

      {job.failure_reason && job.status === "rework_required" ? (
        <Notice tone="danger">
          <strong>Rework:</strong> {job.failure_reason}
        </Notice>
      ) : null}

      {/* ------------------------------------------------------------------ */}
      {/* Linked records                                                      */}
      {/* ------------------------------------------------------------------ */}
      <Panel className="space-y-2 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Linked to</h2>
        <dl className="grid gap-2 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-brand-textMuted">Order</dt>
            <dd>
              {job.order_id && payload.orders[job.order_id] ? (
                <Link href={`/staff/orders/${job.order_id}`} className="underline">
                  {payload.orders[job.order_id].order_number ?? "View order"}
                </Link>
              ) : (
                <span className="text-brand-textMuted">Not linked</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-brand-textMuted">Product</dt>
            <dd>
              {job.product_id && payload.products[job.product_id] ? (
                payload.products[job.product_id].name
              ) : (
                <span className="text-brand-textMuted">Not linked</span>
              )}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-brand-textMuted">Customer</dt>
            <dd>
              {job.customer_id ? (
                payload.people[job.customer_id] ?? "Unknown"
              ) : (
                <span className="text-brand-textMuted">Not linked</span>
              )}
            </dd>
          </div>
        </dl>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/* Status                                                              */}
      {/* ------------------------------------------------------------------ */}
      <Panel className="space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Move this job</h2>

        {!canManage ? (
          <p className="text-sm text-brand-textMuted">
            You can see this job but not change it.
          </p>
        ) : isTerminalStatus(job.status) ? (
          <div className="space-y-3">
            <p className="text-sm text-brand-textMuted">
              This job is {STATUS_META[job.status].label.toLowerCase()}. Reopening puts it back into live work
              and is recorded on the timeline.
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Reopen as</span>
                <select
                  className="ui-input min-h-10 text-sm"
                  value={targetStatus}
                  onChange={(event) => setTargetStatus(event.target.value as ProductionStatus | "")}
                >
                  <option value="">Choose a status…</option>
                  {["not_started", "planning", "in_progress", "on_hold"].map((option) => (
                    <option key={option} value={option}>
                      {STATUS_META[option as ProductionStatus].label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className={primary}
                disabled={busy || !targetStatus || Boolean(proposedProblem)}
                onClick={() => void changeStatus(false)}
              >
                Reopen job
              </button>
            </div>
            {proposedProblem ? (
              <p className="text-xs text-rose-300" role="alert">
                {proposedProblem}
              </p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1 text-xs">
                <span className="font-medium">Move to</span>
                <select
                  className="ui-input min-h-10 text-sm"
                  value={targetStatus}
                  onChange={(event) => {
                    setTargetStatus(event.target.value as ProductionStatus | "");
                    setPendingWarnings(null);
                  }}
                >
                  {/*
                    Choosing here changes nothing. The write happens on the
                    button below, so a mis-click in a dropdown cannot move work
                    through the shop.
                  */}
                  <option value="">Choose a status…</option>
                  {nextStatusOptions(job.status).map((option) => (
                    <option key={option} value={option}>
                      {STATUS_META[option].label}
                    </option>
                  ))}
                </select>
              </label>

              {targetStatus && statusNeedsReason(targetStatus) ? (
                <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs">
                  <span className="font-medium">
                    Why? <span className="text-brand-textMuted">(required)</span>
                  </span>
                  <input
                    className="ui-input min-h-10 text-sm"
                    value={reason}
                    maxLength={1000}
                    required
                    onChange={(event) => setReason(event.target.value)}
                  />
                </label>
              ) : null}

              <button
                type="button"
                className={primary}
                disabled={busy || !targetStatus || Boolean(proposedProblem)}
                onClick={() => void changeStatus(false)}
              >
                Change status
              </button>
            </div>

            {targetStatus ? (
              <p className="text-xs text-brand-textMuted">
                {STATUS_META[targetStatus as ProductionStatus].description} No customer notification is sent
                from this page.
              </p>
            ) : null}

            {proposedProblem ? (
              <p className="text-xs text-rose-300" role="alert">
                {proposedProblem}
              </p>
            ) : null}

            {pendingWarnings ? (
              <Notice tone="warning" role="alertdialog" aria-label="Confirm completion">
                <p className="font-medium">Finish this job anyway?</p>
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {pendingWarnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={primary}
                    disabled={busy}
                    onClick={() => void changeStatus(true)}
                  >
                    Yes, mark it completed
                  </button>
                  <button type="button" className={subtle} onClick={() => setPendingWarnings(null)}>
                    Cancel
                  </button>
                </div>
              </Notice>
            ) : null}
          </div>
        )}
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/* Checklists                                                          */}
      {/* ------------------------------------------------------------------ */}
      {PRODUCTION_TASK_KINDS.map((kind) => {
        const items = payload.tasks.filter((task) => task.kind === kind);
        const progress = checklistProgress(payload.tasks, kind);
        return (
          <Panel key={kind} className="space-y-3 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold uppercase tracking-wide">{TASK_KIND_META[kind].heading}</h2>
              <span className="text-xs text-brand-textMuted">
                {progress.total ? `${progress.done} of ${progress.total} done` : "Nothing listed"}
              </span>
            </div>

            {items.length ? (
              <ul className="space-y-1">
                {items.map((task) => (
                  <li key={task.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
                    <label className="flex min-w-0 flex-1 items-center gap-2">
                      <input
                        type="checkbox"
                        checked={task.is_done}
                        disabled={!canManage || busy}
                        onChange={(event) =>
                          void mutateTask({
                            method: "PATCH",
                            body: JSON.stringify({ taskId: task.id, isDone: event.target.checked }),
                          })
                        }
                      />
                      <span className={task.is_done ? "line-through opacity-70" : undefined}>{task.label}</span>
                    </label>
                    {task.done_at ? (
                      <span className="text-xs text-brand-textMuted">
                        {task.done_by ? `${payload.people[task.done_by] ?? "Someone"} · ` : ""}
                        {new Date(task.done_at).toLocaleDateString()}
                      </span>
                    ) : null}
                    {canManage ? (
                      <button
                        type="button"
                        className={subtle}
                        disabled={busy}
                        aria-label={`Remove “${task.label}”`}
                        onClick={() => {
                          if (!window.confirm(`Remove “${task.label}” from this list?`)) return;
                          void mutateTask({ method: "DELETE" }, `?taskId=${encodeURIComponent(task.id)}`);
                        }}
                      >
                        Remove
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-brand-textMuted">
                No {TASK_KIND_META[kind].label.toLowerCase()} items. A job does not need one.
              </p>
            )}

            {canManage ? (
              <form
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  const input = form.elements.namedItem("label") as HTMLInputElement;
                  const value = input.value.trim();
                  if (!value) return;
                  void mutateTask({ method: "POST", body: JSON.stringify({ kind, label: value }) });
                  input.value = "";
                }}
              >
                <label className="flex min-w-60 flex-1 flex-col gap-1 text-xs">
                  <span className="font-medium">Add an item</span>
                  <input name="label" className="ui-input min-h-10 text-sm" maxLength={300} />
                </label>
                <button type="submit" className={subtle} disabled={busy}>
                  Add
                </button>
              </form>
            ) : null}
          </Panel>
        );
      })}

      {/* ------------------------------------------------------------------ */}
      {/* Files                                                               */}
      {/* ------------------------------------------------------------------ */}
      <Panel className="space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">Files</h2>
        <p className="text-xs text-brand-textMuted">
          References to CAD, CAM, drawings and approvals. Internal unless marked otherwise.
        </p>

        {payload.files.length ? (
          <ul className="space-y-1">
            {payload.files.map((file) => (
              <li key={file.id} className="flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 text-sm">
                <Badge tone="neutral">{FILE_KIND_META[file.kind].label}</Badge>
                <span className="min-w-0 flex-1 truncate">
                  {file.external_url ? (
                    <a href={file.external_url} className="underline" rel="noreferrer noopener" target="_blank">
                      {file.label}
                    </a>
                  ) : (
                    file.label
                  )}
                </span>
                {file.storage_path ? (
                  <span className="font-mono text-xs text-brand-textMuted">{file.storage_path}</span>
                ) : null}
                <Badge tone={file.is_customer_visible ? "warning" : "neutral"}>
                  {file.is_customer_visible ? "Customer-visible" : "Internal"}
                </Badge>
                {canManage ? (
                  <>
                    <button
                      type="button"
                      className={subtle}
                      disabled={busy}
                      onClick={() => {
                        const next = !file.is_customer_visible;
                        if (
                          next &&
                          !window.confirm(
                            `Make “${file.label}” visible to the customer? Manufacturing files are internal by default.`
                          )
                        ) {
                          return;
                        }
                        void mutateFile({
                          method: "PATCH",
                          body: JSON.stringify({ fileId: file.id, isCustomerVisible: next }),
                        });
                      }}
                    >
                      {file.is_customer_visible ? "Make internal" : "Share with customer"}
                    </button>
                    <button
                      type="button"
                      className={subtle}
                      disabled={busy}
                      aria-label={`Remove “${file.label}”`}
                      onClick={() => {
                        if (!window.confirm(`Remove “${file.label}” from this job?`)) return;
                        void mutateFile({ method: "DELETE" }, `?fileId=${encodeURIComponent(file.id)}`);
                      }}
                    >
                      Remove
                    </button>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-brand-textMuted">Nothing attached.</p>
        )}

        {canManage ? (
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const label = (form.elements.namedItem("label") as HTMLInputElement).value.trim();
              const kind = (form.elements.namedItem("kind") as HTMLSelectElement).value;
              const url = (form.elements.namedItem("externalUrl") as HTMLInputElement).value.trim();
              const path = (form.elements.namedItem("storagePath") as HTMLInputElement).value.trim();
              if (!label || (!url && !path)) return;
              void mutateFile({
                method: "POST",
                body: JSON.stringify({ label, kind, externalUrl: url || null, storagePath: path || null }),
              });
              form.reset();
            }}
          >
            <label className="flex flex-col gap-1 text-xs">
              <span className="font-medium">Kind</span>
              <select name="kind" className="ui-input min-h-10 text-sm" defaultValue="cad">
                {PRODUCTION_FILE_KINDS.map((option) => (
                  <option key={option} value={option}>
                    {FILE_KIND_META[option].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
              <span className="font-medium">Label</span>
              <input name="label" className="ui-input min-h-10 text-sm" maxLength={300} />
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
              <span className="font-medium">Link</span>
              <input name="externalUrl" className="ui-input min-h-10 text-sm" placeholder="https://…" />
            </label>
            <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs">
              <span className="font-medium">Or storage path</span>
              <input name="storagePath" className="ui-input min-h-10 text-sm" placeholder="jobs/…" />
            </label>
            <button type="submit" className={subtle} disabled={busy}>
              Attach
            </button>
          </form>
        ) : null}
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/* Details                                                             */}
      {/* ------------------------------------------------------------------ */}
      <Panel className="space-y-4 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Details</h2>
          {dirty ? (
            <span className="text-xs text-amber-300" role="status">
              Unsaved changes
            </span>
          ) : null}
        </div>

        {fieldErrors.length ? (
          <Notice tone="danger" role="alert">
            <p className="font-medium">Fix these before saving:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
              {fieldErrors.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </Notice>
        ) : null}

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void saveFields();
          }}
        >
          <JobForm
            draft={draft}
            onChange={patchDraft}
            people={payload.people}
            disabled={!canManage || busy}
            status={job.status}
          />

          {canManage ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {/* Saving is always an explicit act; nothing on this form autosaves. */}
              <button type="submit" className={primary} disabled={busy || !dirty}>
                {busy ? "Saving…" : "Save details"}
              </button>
              <button
                type="button"
                className={subtle}
                disabled={busy || !dirty}
                onClick={() => setDraft(toDraft(job))}
              >
                Discard changes
              </button>
            </div>
          ) : null}
        </form>
      </Panel>

      {/* ------------------------------------------------------------------ */}
      {/* Timeline                                                            */}
      {/* ------------------------------------------------------------------ */}
      <Panel className="space-y-3 p-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide">History</h2>
        {payload.events.length ? (
          <ol className="space-y-2 text-sm">
            {payload.events.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline gap-2 border-b pb-2 last:border-0">
                <time dateTime={event.created_at} className="text-xs text-brand-textMuted">
                  {new Date(event.created_at).toLocaleString()}
                </time>
                <span className="font-medium">{event.event_type.replace(/^job\./, "").replace(/_/g, " ")}</span>
                {event.from_status && event.to_status ? (
                  <span className="text-xs text-brand-textMuted">
                    {STATUS_META[event.from_status as ProductionStatus]?.label ?? event.from_status} →{" "}
                    {STATUS_META[event.to_status as ProductionStatus]?.label ?? event.to_status}
                  </span>
                ) : null}
                {event.actor_id ? (
                  <span className="text-xs text-brand-textMuted">{payload.people[event.actor_id] ?? "Staff"}</span>
                ) : null}
                {event.note ? <span className="w-full text-xs text-brand-textMuted">“{event.note}”</span> : null}
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState>Nothing has happened to this job yet.</EmptyState>
        )}
      </Panel>
    </div>
  );
}
