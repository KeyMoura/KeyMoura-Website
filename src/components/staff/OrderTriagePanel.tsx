"use client";

import { Notice } from "@/components/ui/DesignSystem";
import { useOrderWorkspace } from "@/components/staff/useOrderWorkspace";

/**
 * Who owns this order, and how urgent it is.
 *
 * ## Why this is on Overview and not on Production
 *
 * These two values are the only part of the retired "Production workspace" that
 * is genuinely about the **order**. `staff_order_queue` reads them — the
 * priority filter and the priority sort on `/staff/orders` are
 * `order_workspaces.priority`, ranked in SQL — so they are the order queue's
 * triage fields, not a production state machine.
 *
 * Putting them back on the Production tab would have recreated the exact defect
 * this pass exists to remove: `production_jobs` carries its *own* `priority` and
 * `assigned_to`, shown a few pixels away by `OrderProductionJobs`. Two priority
 * dropdowns on one tab, writing two different tables, is not a workspace — it is
 * a question with two answers. So the order's urgency lives with the order, the
 * job's urgency lives with the job, and each is labelled with the thing it
 * actually moves.
 *
 * **Production start is deliberately absent.** The old panel had a "Production
 * started" checkbox writing `order_workspaces.started_at`; whether something is
 * being made is `production_jobs.started_at`, which the job board, the job
 * badges and the order's own production summary all already read. The endpoint
 * now preserves the retired column instead of letting this panel null it.
 */

const PRIORITIES = [
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
] as const;

const staffName = (person: { display_name: string | null; username: string | null; id: string }) =>
  person.display_name || (person.username ? `@${person.username}` : person.id);

export function OrderTriagePanel({ orderId, canManage }: { orderId: string; canManage: boolean }) {
  const { workspace, setWorkspace, staff, error, loading, saving, act } = useOrderWorkspace(orderId);

  return (
    <div className="ui-card">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm">
          Priority
          <select
            disabled={!canManage || loading}
            className="ui-input mt-1 w-full"
            value={workspace.priority}
            onChange={(event) =>
              setWorkspace({ ...workspace, priority: event.target.value as typeof workspace.priority })
            }
          >
            {PRIORITIES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-brand-textMuted">
            Sorts and filters this order on the Orders queue.
          </span>
        </label>

        <label className="text-sm">
          Owned by
          <select
            disabled={!canManage || loading}
            className="ui-input mt-1 w-full"
            value={workspace.assigned_to ?? ""}
            onChange={(event) => setWorkspace({ ...workspace, assigned_to: event.target.value || null })}
          >
            <option value="">Unassigned</option>
            {staff.map((person) => (
              <option key={person.id} value={person.id}>
                {staffName(person)}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-brand-textMuted">
            The staff member answerable for this order. Shop work is assigned on the job.
          </span>
        </label>
      </div>

      {canManage ? (
        <button
          type="button"
          disabled={saving || loading}
          onClick={() =>
            void act({
              action: "save_workspace",
              priority: workspace.priority,
              assigned_to: workspace.assigned_to,
            })
          }
          className="ui-btn ui-btn-secondary mt-3 text-sm disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save triage"}
        </button>
      ) : null}

      {error ? (
        <Notice tone="danger" role="alert" className="mt-4">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
