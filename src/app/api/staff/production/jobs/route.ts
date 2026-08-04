import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  isProductionPriority,
  isProductionStatus,
  parseJobDraft,
  TERMINAL_STATUSES,
} from "@/lib/production/jobs";
import {
  JOB_COLUMNS,
  loadJobReferences,
  logProductionFailure,
  recordJobAction,
  type JobRow,
} from "@/lib/production/server";

/**
 * Production job listing and creation.
 *
 * Reading needs `production.view`; creating needs `production.manage`. The two
 * are separate so a machinist can be given the queue without being given the
 * ability to raise or retire work.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

/** Hard ceiling on a page. An unbounded list is how a queue page becomes a table dump. */
const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 50;

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["production.view", "production.manage"]);
  if (!actor) return forbidden();

  const params = req.nextUrl.searchParams;

  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.trunc(Number(params.get("limit")) || DEFAULT_LIMIT))
  );
  const offset = Math.max(0, Math.trunc(Number(params.get("offset")) || 0));

  let query = routeServiceClient.from("production_jobs").select(JOB_COLUMNS, { count: "exact" });

  // `open` is the queue's default: everything that is not finished. Sending it
  // as a named scope rather than thirteen status parameters keeps the common
  // case a short URL that staff can bookmark.
  const scope = params.get("scope");
  if (scope === "open") query = query.not("status", "in", `(${TERMINAL_STATUSES.join(",")})`);
  if (scope === "finished") query = query.in("status", [...TERMINAL_STATUSES]);

  const status = params.get("status");
  if (status && isProductionStatus(status)) query = query.eq("status", status);

  const priority = params.get("priority");
  if (priority && isProductionPriority(priority)) query = query.eq("priority", priority);

  const assignedTo = params.get("assignedTo");
  if (assignedTo === "unassigned") query = query.is("assigned_to", null);
  else if (assignedTo) query = query.eq("assigned_to", assignedTo);

  const orderId = params.get("orderId");
  if (orderId) query = query.eq("order_id", orderId);

  const customerId = params.get("customerId");
  if (customerId) query = query.eq("customer_id", customerId);

  const productId = params.get("productId");
  if (productId) query = query.eq("product_id", productId);

  // Overdue is computed against the caller's day so a shop west of UTC does not
  // see tomorrow's work flagged red overnight.
  if (params.get("overdue") === "true") {
    const today = params.get("today");
    const day = /^\d{4}-\d{2}-\d{2}$/.test(today ?? "") ? today! : new Date().toISOString().slice(0, 10);
    query = query
      .lt("due_date", day)
      .not("status", "in", `(${TERMINAL_STATUSES.join(",")})`);
  }

  const search = (params.get("q") ?? "").trim().slice(0, 100);
  if (search) {
    // Escaped because `,` and `)` are PostgREST's own `or()` separators; an
    // unescaped comma in a search box would otherwise become a second filter.
    const safe = search.replace(/[,()\\]/g, " ").trim();
    if (safe) query = query.or(`title.ilike.%${safe}%,job_number.ilike.%${safe}%`);
  }

  const { data, error, count } = await query
    .order("updated_at", { ascending: false })
    .range(offset, offset + limit - 1)
    .returns<JobRow[]>();

  if (error) {
    logProductionFailure("jobs.list", error);
    return NextResponse.json({ error: "Could not load the production queue." }, { status: 500 });
  }

  // An empty table is a real answer, not a failure: `data` is `[]` and the
  // queue renders its empty state. Only `error` above is a failure.
  const jobs = data ?? [];
  const references = await loadJobReferences(jobs);

  return NextResponse.json({
    jobs,
    ...references,
    total: count ?? jobs.length,
    limit,
    offset,
    canManage: actor.permissions.has("production.manage"),
  });
}

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Send a job to create." }, { status: 400 });

  const { draft, errors } = parseJobDraft(body);
  if (!draft) return NextResponse.json({ error: errors[0], errors }, { status: 400 });

  // A job may be created directly into a state that needs explaining; the
  // explanation is stored on the row rather than being demanded as a
  // transition, because there is no transition yet.
  const holdReason =
    typeof body.holdReason === "string" ? body.holdReason.trim().slice(0, 1000) || null : null;

  const { data, error } = await routeServiceClient
    .from("production_jobs")
    .insert({ ...draft, hold_reason: holdReason, created_by: actor.userId })
    .select(JOB_COLUMNS)
    .single<JobRow>();

  if (error || !data) {
    logProductionFailure("jobs.create", error);
    return NextResponse.json({ error: error?.message || "Could not create the job." }, { status: 400 });
  }

  const job = data;

  await recordJobAction({
    actor,
    jobId: job.id,
    jobNumber: job.job_number,
    eventType: "job.created",
    auditType: "staff.production.job.create",
    toStatus: job.status,
    metadata: {
      priority: job.priority,
      linkedOrder: Boolean(job.order_id),
      linkedProduct: Boolean(job.product_id),
    },
  });

  return NextResponse.json({ job }, { status: 201 });
}

export const dynamic = "force-dynamic";
