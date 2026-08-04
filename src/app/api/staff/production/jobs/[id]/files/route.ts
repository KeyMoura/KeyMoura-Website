import { NextRequest, NextResponse } from "next/server";

import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { isProductionFileKind } from "@/lib/production/jobs";
import { FILE_COLUMNS, JOB_COLUMNS, recordJobAction, type JobRow } from "@/lib/production/server";

/**
 * Files attached to a job: CAD, CAM, drawings, reference images, and the
 * customer-approved set.
 *
 * This endpoint records *references*, it does not accept uploads. A CAD or CAM
 * file is not something to stream through a JSON route, and the storage bucket
 * and its signed-URL policy are not part of this pass — see the ledger. What
 * exists here is the catalogue: what a job needs, where it lives, and whether a
 * customer is allowed to see it.
 *
 * `is_customer_visible` defaults to false in the database and has to be set
 * deliberately. Manufacturing files are internal until somebody says otherwise.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

const MAX_FILES = 100;

/**
 * A reference must be a site-relative path or an https URL, matching the rule
 * the Appearance and category asset fields already use. `javascript:` and
 * `data:` are the reason this is a whitelist rather than a blacklist.
 */
function cleanExternalUrl(value: unknown): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, 2000);
  if (!text) return null;
  return text.startsWith("/") || /^https:\/\//i.test(text) ? text : undefined;
}

function cleanStoragePath(value: unknown): string | null | undefined {
  if (value == null || value === "") return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, 1000);
  if (!text) return null;
  // No scheme, no traversal. A storage path is a key inside a bucket.
  if (/^[a-z][a-z0-9+.-]*:/i.test(text) || text.includes("..")) return undefined;
  return text.replace(/^\/+/, "");
}

async function loadJob(id: string): Promise<JobRow | null> {
  const { data } = await routeServiceClient
    .from("production_jobs")
    .select(JOB_COLUMNS)
    .eq("id", id)
    .maybeSingle<JobRow>();
  return data ?? null;
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const kind = body?.kind ?? "other";
  if (!isProductionFileKind(kind)) return NextResponse.json({ error: "That is not a file kind." }, { status: 400 });

  const label = typeof body?.label === "string" ? body.label.trim().slice(0, 300) : "";
  if (!label) return NextResponse.json({ error: "Give the file a label." }, { status: 400 });

  const externalUrl = cleanExternalUrl(body?.externalUrl);
  if (externalUrl === undefined) {
    return NextResponse.json({ error: "A link must start with / or https://." }, { status: 400 });
  }

  const storagePath = cleanStoragePath(body?.storagePath);
  if (storagePath === undefined) {
    return NextResponse.json({ error: "That storage path is not valid." }, { status: 400 });
  }

  if (!externalUrl && !storagePath) {
    return NextResponse.json({ error: "Give the file a link or a storage path." }, { status: 400 });
  }

  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const { count } = await routeServiceClient
    .from("production_job_files")
    .select("id", { count: "exact", head: true })
    .eq("job_id", id);

  if ((count ?? 0) >= MAX_FILES) {
    return NextResponse.json({ error: `A job holds at most ${MAX_FILES} files.` }, { status: 400 });
  }

  const { data, error } = await routeServiceClient
    .from("production_job_files")
    .insert({
      job_id: id,
      kind,
      label,
      external_url: externalUrl,
      storage_path: storagePath,
      is_customer_visible: body?.isCustomerVisible === true,
      uploaded_by: actor.userId,
    })
    .select(FILE_COLUMNS)
    .single();

  if (error) return NextResponse.json({ error: error.message || "Could not attach the file." }, { status: 400 });

  await recordJobAction({
    actor,
    jobId: job.id,
    jobNumber: job.job_number,
    eventType: "job.file_attached",
    auditType: "staff.production.job.file_add",
    metadata: { kind, label, customerVisible: body?.isCustomerVisible === true },
  });

  return NextResponse.json({ file: data }, { status: 201 });
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;

  const fileId = typeof body?.fileId === "string" ? body.fileId : "";
  if (!fileId) return NextResponse.json({ error: "Say which file to update." }, { status: 400 });
  if (typeof body?.isCustomerVisible !== "boolean") {
    return NextResponse.json({ error: "Nothing to change." }, { status: 400 });
  }

  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const { data, error } = await routeServiceClient
    .from("production_job_files")
    .update({ is_customer_visible: body.isCustomerVisible })
    .eq("id", fileId)
    .eq("job_id", id)
    .select(FILE_COLUMNS)
    .maybeSingle();

  if (error) return NextResponse.json({ error: "Could not update the file." }, { status: 400 });
  if (!data) return NextResponse.json({ error: "That file no longer exists." }, { status: 404 });

  // Changing who can see a manufacturing file is exactly the kind of action the
  // audit log exists for.
  await recordJobAction({
    actor,
    jobId: job.id,
    jobNumber: job.job_number,
    eventType: body.isCustomerVisible ? "job.file_shared" : "job.file_unshared",
    auditType: "staff.production.job.file_visibility",
    metadata: { label: data.label, kind: data.kind, customerVisible: body.isCustomerVisible },
  });

  return NextResponse.json({ file: data });
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const actor = await requirePermission(req, "production.manage");
  if (!actor) return forbidden();

  const { id } = await context.params;
  const fileId = req.nextUrl.searchParams.get("fileId") ?? "";
  if (!fileId) return NextResponse.json({ error: "Say which file to remove." }, { status: 400 });

  const job = await loadJob(id);
  if (!job) return NextResponse.json({ error: "That job no longer exists." }, { status: 404 });

  const { data: existing } = await routeServiceClient
    .from("production_job_files")
    .select(FILE_COLUMNS)
    .eq("id", fileId)
    .eq("job_id", id)
    .maybeSingle();

  if (!existing) return NextResponse.json({ error: "That file no longer exists." }, { status: 404 });

  const { error } = await routeServiceClient
    .from("production_job_files")
    .delete()
    .eq("id", fileId)
    .eq("job_id", id);

  if (error) return NextResponse.json({ error: "Could not remove the file." }, { status: 400 });

  await recordJobAction({
    actor,
    jobId: job.id,
    jobNumber: job.job_number,
    eventType: "job.file_removed",
    auditType: "staff.production.job.file_remove",
    metadata: { label: existing.label, kind: existing.kind },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
