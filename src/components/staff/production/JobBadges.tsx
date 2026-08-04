import Link from "next/link";

import { Badge } from "@/components/ui/DesignSystem";
import {
  PRIORITY_META,
  STATUS_META,
  daysUntilDue,
  jobIsOverdue,
  type ProductionJobLike,
  type ProductionPriority,
  type ProductionStatus,
} from "@/lib/production/jobs";

/**
 * Shared job chrome.
 *
 * The queue, the job page, the dashboard cards and the order panel all render a
 * job's status and priority. One definition of which tone belongs to which
 * state keeps "urgent" the same colour everywhere it appears.
 */

const STATUS_TONE: Record<ProductionStatus, "neutral" | "accent" | "warning" | "danger" | "success"> = {
  not_started: "neutral",
  planning: "neutral",
  waiting_on_customer: "warning",
  waiting_on_materials: "warning",
  scheduled: "accent",
  in_progress: "accent",
  quality_check: "accent",
  rework_required: "danger",
  ready_for_pickup: "success",
  ready_to_ship: "success",
  completed: "success",
  on_hold: "warning",
  cancelled: "neutral",
};

const PRIORITY_TONE: Record<ProductionPriority, "neutral" | "accent" | "warning" | "danger" | "success"> = {
  low: "neutral",
  normal: "neutral",
  high: "warning",
  urgent: "danger",
};

export function StatusBadge({ status }: { status: ProductionStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{STATUS_META[status].label}</Badge>;
}

export function PriorityBadge({ priority }: { priority: ProductionPriority }) {
  // Normal is the default and says nothing useful, so it stays silent rather
  // than adding a chip to every row in the queue.
  if (priority === "normal") return null;
  return <Badge tone={PRIORITY_TONE[priority]}>{PRIORITY_META[priority].label}</Badge>;
}

/**
 * Due date with its own urgency wording.
 *
 * Uses the shared date rules, so "due today" means the same thing here as it
 * does in the queue's sort order and in the overdue filter.
 */
export function DueDate({ job, now }: { job: ProductionJobLike; now: Date }) {
  if (!job.due_date) return <span className="text-brand-textMuted">No due date</span>;

  const days = daysUntilDue(job, now);
  const overdue = jobIsOverdue(job, now);

  const wording =
    days == null
      ? job.due_date
      : overdue
        ? `${Math.abs(days)} day${Math.abs(days) === 1 ? "" : "s"} overdue`
        : days === 0
          ? "Due today"
          : days === 1
            ? "Due tomorrow"
            : `Due in ${days} days`;

  return (
    <span className={overdue ? "font-semibold text-rose-300" : undefined}>
      <time dateTime={job.due_date}>{wording}</time>
    </span>
  );
}

export type JobSummary = ProductionJobLike & {
  id: string;
  job_number: string;
  title: string;
};

/** One row of the queue. Used by the queue page and by the dashboard cards. */
export function JobRowLink({
  job,
  now,
  assignee,
  trailing,
}: {
  job: JobSummary;
  now: Date;
  assignee?: string | null;
  trailing?: React.ReactNode;
}) {
  return (
    <Link
      href={`/staff/production/${job.id}`}
      className="ui-card flex flex-wrap items-center gap-x-3 gap-y-2 p-3 transition hover:border-brand-accent focus-visible:border-brand-accent"
    >
      <span className="font-mono text-xs text-brand-textMuted">{job.job_number}</span>
      <span className="min-w-0 flex-1 basis-48 truncate font-medium">{job.title}</span>
      <StatusBadge status={job.status} />
      <PriorityBadge priority={job.priority} />
      <span className="text-xs">
        <DueDate job={job} now={now} />
      </span>
      {assignee ? <span className="text-xs text-brand-textMuted">{assignee}</span> : null}
      {trailing}
    </Link>
  );
}
