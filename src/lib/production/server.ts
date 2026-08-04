import "server-only";

import { routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import type { ActorAccess } from "@/lib/permissions";
import type { ProductionStatus } from "./jobs";

/**
 * Server-side helpers shared by every production route.
 *
 * The column lists live here so a field added to a job is added in one place
 * rather than in five `select(...)` strings that slowly stop agreeing.
 */

export const JOB_COLUMNS =
  "id,job_number,title,description,status,priority,order_id,order_item_id,product_id,customer_id," +
  "quantity,due_date,promised_date,assigned_to,estimated_minutes,actual_minutes," +
  "materials_required,materials_acquired,external_services_required,internal_notes,customer_visible_notes," +
  "hold_reason,failure_reason,rework_count,started_at,ready_at,completed_at,cancelled_at," +
  "created_by,created_at,updated_at";

export const TASK_COLUMNS = "id,job_id,kind,label,detail,position,is_done,done_by,done_at,created_at";

export const FILE_COLUMNS =
  "id,job_id,kind,label,storage_path,external_url,is_customer_visible,uploaded_by,created_at";

export const EVENT_COLUMNS = "id,job_id,actor_id,event_type,from_status,to_status,note,metadata,created_at";

/**
 * Records why a production query failed, on the server, in one shape.
 *
 * This exists because of a real outage: the queue answered "Could not load the
 * production queue." for every request while the actual cause —
 * `42501: permission denied for table production_jobs`, the migration having
 * created the tables without granting them — appeared nowhere in the
 * application's own logs. The generic sentence is the right thing to show a
 * machinist; it is the wrong and only thing to have when diagnosing it.
 *
 * What is logged is the error's shape, never its payload: `code`, `message` and
 * `hint` describe what Postgres refused and why. `details` is deliberately
 * omitted — it is the one field that echoes row values back (a unique violation
 * reports the conflicting key), and a job carries internal notes, costs and
 * customer identifiers. No token, key, cookie or row body is ever logged.
 */
export function logProductionFailure(operation: string, error: unknown): void {
  const shape = error as { code?: unknown; message?: unknown; hint?: unknown } | null;

  console.error("[production] query failed", {
    operation,
    code: typeof shape?.code === "string" ? shape.code : undefined,
    message: typeof shape?.message === "string" ? shape.message : undefined,
    hint: typeof shape?.hint === "string" ? shape.hint : undefined,
  });
}

/**
 * Appends to a job's own timeline.
 *
 * Separate from `logAuditEvent` on purpose — see the migration's header. This
 * one is what staff read on the job page; the audit event is the security
 * record. Consequential actions write both.
 *
 * Failures are swallowed: a timeline row that could not be written must not
 * roll back the status change a machinist just made on the shop floor. The
 * status change itself is the thing that has to succeed.
 */
export async function recordJobEvent(params: {
  jobId: string;
  actorId: string | null;
  eventType: string;
  fromStatus?: ProductionStatus | null;
  toStatus?: ProductionStatus | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await routeServiceClient.from("production_job_events").insert({
      job_id: params.jobId,
      actor_id: params.actorId,
      event_type: params.eventType,
      from_status: params.fromStatus ?? null,
      to_status: params.toStatus ?? null,
      note: params.note ?? null,
      metadata: params.metadata ?? {},
    });
  } catch (error) {
    console.error("Failed to record production job event", error);
  }
}

/**
 * Writes the job timeline and the staff audit log together.
 *
 * `metadata` must stay free of customer PII and of internal note bodies — the
 * audit log is read by a wider group than the job page. Callers pass counts and
 * identifiers, not content.
 */
export async function recordJobAction(params: {
  actor: ActorAccess;
  jobId: string;
  jobNumber: string;
  eventType: string;
  auditType: string;
  fromStatus?: ProductionStatus | null;
  toStatus?: ProductionStatus | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await Promise.all([
    recordJobEvent({
      jobId: params.jobId,
      actorId: params.actor.userId,
      eventType: params.eventType,
      fromStatus: params.fromStatus,
      toStatus: params.toStatus,
      note: params.note,
      metadata: params.metadata,
    }),
    logAuditEvent({
      actorUserId: params.actor.userId,
      actorRole: params.actor.role,
      eventType: params.auditType,
      targetTable: "production_jobs",
      targetId: params.jobId,
      metadata: {
        jobNumber: params.jobNumber,
        ...(params.fromStatus ? { from: params.fromStatus } : {}),
        ...(params.toStatus ? { to: params.toStatus } : {}),
        ...(params.metadata ?? {}),
      },
    }),
  ]);
}

export type JobRow = {
  id: string;
  job_number: string;
  title: string;
  status: ProductionStatus;
  priority: "low" | "normal" | "high" | "urgent";
  order_id: string | null;
  product_id: string | null;
  customer_id: string | null;
  assigned_to: string | null;
  due_date: string | null;
  materials_acquired: boolean;
  actual_minutes: number | null;
  estimated_minutes: number | null;
  created_at: string;
  updated_at: string;
  [key: string]: unknown;
};

/**
 * Resolves display names for the people and records a set of jobs points at.
 *
 * Batched by design: three queries for a page of jobs regardless of how many
 * rows it holds. Doing it per row is the N+1 the queue would otherwise ship
 * with, and it is the reason this is a helper rather than inline code.
 */
export async function loadJobReferences(jobs: readonly JobRow[]) {
  const userIds = new Set<string>();
  const orderIds = new Set<string>();
  const productIds = new Set<string>();

  for (const job of jobs) {
    if (job.assigned_to) userIds.add(job.assigned_to);
    if (job.customer_id) userIds.add(job.customer_id);
    if (job.order_id) orderIds.add(job.order_id);
    if (job.product_id) productIds.add(job.product_id);
  }

  const [people, orders, products] = await Promise.all([
    userIds.size
      ? routeServiceClient.from("profiles").select("id,username,display_name").in("id", [...userIds])
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    orderIds.size
      ? routeServiceClient.from("orders").select("id,order_number,status,order_kind").in("id", [...orderIds])
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
    productIds.size
      ? routeServiceClient.from("products").select("id,name,slug").in("id", [...productIds])
      : Promise.resolve({ data: [] as Array<Record<string, unknown>>, error: null }),
  ]);

  // A reference that cannot be resolved is not fatal — a job whose customer was
  // deleted still belongs in the queue, and every link is nullable by design.
  // It is logged rather than swallowed, because "names silently stopped
  // appearing" is otherwise invisible until somebody notices column of uuids.
  if (people.error) logProductionFailure("references.people", people.error);
  if (orders.error) logProductionFailure("references.orders", orders.error);
  if (products.error) logProductionFailure("references.products", products.error);

  const nameFor = (row: Record<string, unknown>) =>
    (row.display_name as string | null) || (row.username as string | null) || "Unknown";

  return {
    people: Object.fromEntries((people.data ?? []).map((row) => [row.id as string, nameFor(row)])),
    orders: Object.fromEntries((orders.data ?? []).map((row) => [row.id as string, row])),
    products: Object.fromEntries((products.data ?? []).map((row) => [row.id as string, row])),
  };
}
