"use client";

import {
  PRODUCTION_PRIORITIES,
  PRIORITY_META,
  STATUS_META,
  formatMinutes,
  labourVariance,
  type ProductionPriority,
  type ProductionStatus,
} from "@/lib/production/jobs";

/**
 * The job field set, shared by the create page and the job workspace.
 *
 * Both surfaces post to routes that run `parseJobDraft`, and both render this
 * component, so a field cannot exist on one form and be missing from the other.
 * Status is deliberately absent from the editable set on an existing job — it
 * moves through its own control, which enforces the transition rules.
 */

export type JobDraftState = {
  title: string;
  description: string;
  priority: ProductionPriority;
  quantity: string;
  dueDate: string;
  promisedDate: string;
  assignedTo: string;
  estimatedMinutes: string;
  actualMinutes: string;
  materialsRequired: string;
  materialsAcquired: boolean;
  externalServicesRequired: string;
  internalNotes: string;
  customerVisibleNotes: string;
};

export const emptyJobDraft: JobDraftState = {
  title: "",
  description: "",
  priority: "normal",
  quantity: "1",
  dueDate: "",
  promisedDate: "",
  assignedTo: "",
  estimatedMinutes: "",
  actualMinutes: "",
  materialsRequired: "",
  materialsAcquired: false,
  externalServicesRequired: "",
  internalNotes: "",
  customerVisibleNotes: "",
};

type Props = {
  draft: JobDraftState;
  onChange: (patch: Partial<JobDraftState>) => void;
  people: Record<string, string>;
  disabled?: boolean;
  /** Shown on an existing job so staff can see where the work currently sits. */
  status?: ProductionStatus;
};

const field = "ui-input min-h-10 w-full text-sm";
const label = "flex flex-col gap-1 text-xs";
const labelText = "font-medium";

export function JobForm({ draft, onChange, people, disabled, status }: Props) {
  const variance = labourVariance(
    draft.estimatedMinutes === "" ? null : Number(draft.estimatedMinutes),
    draft.actualMinutes === "" ? null : Number(draft.actualMinutes)
  );

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={`${label} sm:col-span-2`}>
          <span className={labelText}>Title</span>
          <input
            className={field}
            value={draft.title}
            maxLength={200}
            required
            disabled={disabled}
            onChange={(event) => onChange({ title: event.target.value })}
          />
        </label>

        <label className={`${label} sm:col-span-2`}>
          <span className={labelText}>Description</span>
          <textarea
            className={`${field} min-h-20`}
            value={draft.description}
            maxLength={5000}
            disabled={disabled}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </label>

        {status ? (
          <div className={label}>
            <span className={labelText}>Status</span>
            <p className="text-sm text-brand-textMuted">
              {STATUS_META[status].label} — change it below.
            </p>
          </div>
        ) : null}

        <label className={label}>
          <span className={labelText}>Priority</span>
          <select
            className={field}
            value={draft.priority}
            disabled={disabled}
            onChange={(event) => onChange({ priority: event.target.value as ProductionPriority })}
          >
            {PRODUCTION_PRIORITIES.map((option) => (
              <option key={option} value={option}>
                {PRIORITY_META[option].label}
              </option>
            ))}
          </select>
        </label>

        <label className={label}>
          <span className={labelText}>Quantity</span>
          <input
            className={field}
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={draft.quantity}
            disabled={disabled}
            onChange={(event) => onChange({ quantity: event.target.value })}
          />
        </label>

        <label className={label}>
          <span className={labelText}>Assigned to</span>
          <select
            className={field}
            value={draft.assignedTo}
            disabled={disabled}
            onChange={(event) => onChange({ assignedTo: event.target.value })}
          >
            <option value="">Unassigned</option>
            {Object.entries(people).map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </label>

        <label className={label}>
          <span className={labelText}>Due date</span>
          <input
            className={field}
            type="date"
            value={draft.dueDate}
            disabled={disabled}
            onChange={(event) => onChange({ dueDate: event.target.value })}
          />
        </label>

        <label className={label}>
          <span className={labelText}>Promised date</span>
          <input
            className={field}
            type="date"
            value={draft.promisedDate}
            disabled={disabled}
            onChange={(event) => onChange({ promisedDate: event.target.value })}
          />
          <span className="text-brand-textMuted">What the customer was told.</span>
        </label>
      </div>

      <fieldset className="space-y-3 rounded-[var(--control-radius)] border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide">Labour</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            <span className={labelText}>Estimated (minutes)</span>
            <input
              className={field}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft.estimatedMinutes}
              disabled={disabled}
              onChange={(event) => onChange({ estimatedMinutes: event.target.value })}
            />
          </label>
          <label className={label}>
            <span className={labelText}>Actual (minutes)</span>
            <input
              className={field}
              type="number"
              min={0}
              step={1}
              inputMode="numeric"
              value={draft.actualMinutes}
              disabled={disabled}
              onChange={(event) => onChange({ actualMinutes: event.target.value })}
            />
          </label>
        </div>
        {variance ? (
          <p className="text-xs text-brand-textMuted">
            {variance.over ? "Over" : "Under"} estimate by {formatMinutes(Math.abs(variance.deltaMinutes))}
            {variance.percent == null ? "" : ` (${Math.abs(variance.percent)}%)`}.
          </p>
        ) : (
          <p className="text-xs text-brand-textMuted">
            Recording both an estimate and an actual gives a variance here.
          </p>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-[var(--control-radius)] border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide">Materials and services</legend>
        <label className={label}>
          <span className={labelText}>Materials required</span>
          <textarea
            className={`${field} min-h-16`}
            value={draft.materialsRequired}
            maxLength={5000}
            disabled={disabled}
            onChange={(event) => onChange({ materialsRequired: event.target.value })}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={draft.materialsAcquired}
            disabled={disabled}
            onChange={(event) => onChange({ materialsAcquired: event.target.checked })}
          />
          <span>Materials acquired</span>
        </label>
        <label className={label}>
          <span className={labelText}>External services required</span>
          <textarea
            className={`${field} min-h-16`}
            value={draft.externalServicesRequired}
            maxLength={5000}
            disabled={disabled}
            onChange={(event) => onChange({ externalServicesRequired: event.target.value })}
          />
          <span className="text-brand-textMuted">Anodising, heat treatment, plating, and the like.</span>
        </label>
      </fieldset>

      <fieldset className="space-y-3 rounded-[var(--control-radius)] border p-3">
        <legend className="px-1 text-xs font-semibold uppercase tracking-wide">Notes</legend>

        <label className={label}>
          <span className={labelText}>Internal notes</span>
          <textarea
            className={`${field} min-h-20`}
            value={draft.internalNotes}
            maxLength={10000}
            disabled={disabled}
            onChange={(event) => onChange({ internalNotes: event.target.value })}
          />
          {/*
            Stated on the field rather than in a legend somewhere above it. The
            distinction between these two boxes is the one mistake on this page
            that reaches a customer, so it is written where it is being made.
          */}
          <span className="text-brand-textMuted">
            <strong>Never shown to the customer.</strong> Scrap, rework, costs, and anything else internal.
          </span>
        </label>

        <label className={label}>
          <span className={labelText}>Customer-visible notes</span>
          <textarea
            className={`${field} min-h-20`}
            value={draft.customerVisibleNotes}
            maxLength={5000}
            disabled={disabled}
            onChange={(event) => onChange({ customerVisibleNotes: event.target.value })}
          />
          <span className="text-brand-textMuted">
            Written for the customer. Keep it free of internal detail.
          </span>
        </label>
      </fieldset>
    </div>
  );
}
