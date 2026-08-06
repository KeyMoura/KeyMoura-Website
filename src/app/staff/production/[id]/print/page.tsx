import Link from "next/link";
import { notFound } from "next/navigation";

import { AccessDenied } from "@/components/AccessDenied";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { getServerActorAccess } from "@/lib/staff/serverAccess";
import {
  FILE_KIND_META,
  PRIORITY_META,
  STATUS_META,
  formatMinutes,
  type ProductionFileKind,
  type ProductionStatus,
  type ProductionTaskKind,
} from "@/lib/production/jobs";
import { FILE_COLUMNS, JOB_COLUMNS, TASK_COLUMNS } from "@/lib/production/server";

/**
 * The printable job traveller, work order and quality-control checklist.
 *
 * One document in three sections, each starting on its own sheet, because that
 * is how they are used: the traveller rides with the part, the work order goes
 * to whoever is cutting, and the QC sheet is signed and filed.
 *
 * **This is an internal document.** It carries internal notes, scrap and rework
 * history, and materials detail. It is marked as such on every section, and it
 * is never reachable by a customer: the route requires a staff permission and
 * the underlying tables are staff-only under RLS.
 *
 * Rendered on the server so that printing does not depend on client JavaScript
 * having run — Ctrl+P on a half-hydrated page is a blank sheet.
 */

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

type TaskRow = {
  id: string;
  kind: ProductionTaskKind;
  label: string;
  detail: string | null;
  is_done: boolean;
  done_at: string | null;
};

type FileRow = {
  id: string;
  kind: ProductionFileKind;
  label: string;
  storage_path: string | null;
  external_url: string | null;
  is_customer_visible: boolean;
};

const cell = "align-top";

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="text-[9pt] uppercase tracking-wide opacity-70">{label}</div>
      <div className="text-[11pt]">{value ?? "—"}</div>
    </div>
  );
}

function InternalStamp() {
  return (
    <div className="mb-3 border-2 border-black px-2 py-1 text-[10pt] font-bold uppercase tracking-widest">
      Internal document — not for the customer
    </div>
  );
}

/** An empty box for a signature or a measured value taken at the machine. */
function WriteIn({ label }: { label: string }) {
  return (
    <div className="mt-4">
      <div className="text-[9pt] uppercase tracking-wide opacity-70">{label}</div>
      <div className="mt-6 border-b border-black" />
    </div>
  );
}

export default async function PrintableWorkOrderPage({ params }: Params) {
  const { id } = await params;

  const actor = await getServerActorAccess();
  if (!actor || !(actor.permissions.has("production.view") || actor.permissions.has("production.manage"))) {
    return (
      <div className="page-container">
        <AccessDenied
          title="Production is restricted"
          description="You need the production access permission to print a work order."
          backHref="/staff"
          backLabel="Back to Staff"
        />
      </div>
    );
  }

  const [{ data: job }, { data: tasks }, { data: files }] = await Promise.all([
    supabaseAdmin
      .from("production_jobs")
      .select(JOB_COLUMNS)
      .eq("id", id)
      .maybeSingle<Record<string, unknown>>(),
    supabaseAdmin
      .from("production_job_tasks")
      .select(TASK_COLUMNS)
      .eq("job_id", id)
      .order("kind")
      .order("position")
      .order("created_at")
      .returns<TaskRow[]>(),
    supabaseAdmin.from("production_job_files").select(FILE_COLUMNS).eq("job_id", id).returns<FileRow[]>(),
  ]);

  if (!job) notFound();

  const record = job;
  const status = record.status as ProductionStatus;
  const priority = record.priority as "low" | "normal" | "high" | "urgent";

  const [assignee, customer, order, product] = await Promise.all([
    record.assigned_to
      ? supabaseAdmin.from("profiles").select("display_name,username").eq("id", record.assigned_to).maybeSingle()
      : Promise.resolve({ data: null }),
    record.customer_id
      ? supabaseAdmin.from("profiles").select("display_name,username").eq("id", record.customer_id).maybeSingle()
      : Promise.resolve({ data: null }),
    record.order_id
      ? supabaseAdmin.from("orders").select("order_number").eq("id", record.order_id).maybeSingle()
      : Promise.resolve({ data: null }),
    record.product_id
      ? supabaseAdmin.from("products").select("name,sku").eq("id", record.product_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  const personName = (row: { display_name?: string | null; username?: string | null } | null) =>
    row ? row.display_name || row.username || "Unknown" : null;

  const byKind = (kind: ProductionTaskKind) => (tasks ?? []).filter((task) => task.kind === kind);
  const steps = byKind("step");
  const completion = byKind("completion");
  const quality = byKind("quality");

  const jobNumber = String(record.job_number);
  const title = String(record.title);

  return (
    <div className="print-document page-container space-y-6 py-6">
      <div className="print-hidden flex flex-wrap items-center justify-between gap-3">
        <Link href={`/staff/production/${id}`} className="text-sm underline">
          ← Back to the job
        </Link>
        <p className="text-sm opacity-70">Use your browser’s print command. Nav and footer are dropped on paper.</p>
      </div>

      {/* ================================================================= */}
      {/* 1. Job traveller                                                   */}
      {/* ================================================================= */}
      <section className="print-block space-y-3 p-4">
        <InternalStamp />

        <div className="flex flex-wrap items-baseline justify-between gap-3 border-b border-black pb-2">
          <div>
            <div className="text-[9pt] uppercase tracking-widest">Job traveller</div>
            <div className="text-[20pt] font-bold leading-tight">{jobNumber}</div>
          </div>
          <div className="text-right">
            <div className="text-[14pt] font-semibold">{title}</div>
            <div className="text-[10pt]">
              {STATUS_META[status].label} · {PRIORITY_META[priority].label} priority
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Quantity" value={String(record.quantity ?? 1)} />
          <Field label="Due" value={(record.due_date as string | null) ?? "—"} />
          <Field label="Promised" value={(record.promised_date as string | null) ?? "—"} />
          <Field label="Assigned" value={personName(assignee.data) ?? "Unassigned"} />
          <Field label="Order" value={(order.data?.order_number as string | null) ?? "—"} />
          <Field label="Customer" value={personName(customer.data) ?? "—"} />
          <Field label="Product" value={(product.data?.name as string | null) ?? "—"} />
          <Field label="SKU" value={(product.data?.sku as string | null) ?? "—"} />
          <Field label="Estimated labour" value={formatMinutes(record.estimated_minutes as number | null)} />
          <Field label="Actual labour" value={formatMinutes(record.actual_minutes as number | null)} />
          <Field label="Materials acquired" value={record.materials_acquired ? "Yes" : "No"} />
          <Field label="Rework count" value={String(record.rework_count ?? 0)} />
        </div>

        {record.description ? (
          <div>
            <div className="text-[9pt] uppercase tracking-wide opacity-70">Description</div>
            <p className="whitespace-pre-wrap text-[11pt]">{String(record.description)}</p>
          </div>
        ) : null}

        {record.materials_required ? (
          <div>
            <div className="text-[9pt] uppercase tracking-wide opacity-70">Materials required</div>
            <p className="whitespace-pre-wrap text-[11pt]">{String(record.materials_required)}</p>
          </div>
        ) : null}

        {record.external_services_required ? (
          <div>
            <div className="text-[9pt] uppercase tracking-wide opacity-70">External services</div>
            <p className="whitespace-pre-wrap text-[11pt]">{String(record.external_services_required)}</p>
          </div>
        ) : null}

        {record.internal_notes ? (
          <div>
            <div className="text-[9pt] uppercase tracking-wide opacity-70">Internal notes</div>
            <p className="whitespace-pre-wrap text-[11pt]">{String(record.internal_notes)}</p>
          </div>
        ) : null}

        {record.hold_reason ? (
          <div>
            <div className="text-[9pt] uppercase tracking-wide opacity-70">On hold because</div>
            <p className="whitespace-pre-wrap text-[11pt]">{String(record.hold_reason)}</p>
          </div>
        ) : null}

        {files?.length ? (
          <div>
            <div className="text-[9pt] uppercase tracking-wide opacity-70">Files</div>
            <ul className="text-[10pt]">
              {files.map((file) => (
                <li key={file.id}>
                  {FILE_KIND_META[file.kind].label}: {file.label}
                  {file.storage_path ? ` — ${file.storage_path}` : ""}
                  {file.is_customer_visible ? " (customer-visible)" : ""}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      {/* ================================================================= */}
      {/* 2. Work order — the manufacturing steps                            */}
      {/* ================================================================= */}
      <section className="print-block print-break-before space-y-3 p-4">
        <InternalStamp />
        <div className="flex items-baseline justify-between border-b border-black pb-2">
          <div className="text-[14pt] font-bold">Work order — {jobNumber}</div>
          <div className="text-[10pt]">{title}</div>
        </div>

        {steps.length ? (
          <table>
            <thead>
              <tr>
                <th style={{ width: "6%" }}>#</th>
                <th style={{ width: "44%" }}>Operation</th>
                <th style={{ width: "26%" }}>Notes</th>
                <th style={{ width: "12%" }}>Done</th>
                <th style={{ width: "12%" }}>Initials</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((step, index) => (
                <tr key={step.id}>
                  <td className={cell}>{index + 1}</td>
                  <td className={cell}>{step.label}</td>
                  <td className={cell}>{step.detail ?? ""}</td>
                  {/* Printed empty even when ticked on screen: the sheet that
                      travels with the part is signed at the machine. */}
                  <td className={cell}>☐</td>
                  <td className={cell} />
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[11pt] italic">No manufacturing steps were listed for this job.</p>
        )}

        {completion.length ? (
          <div className="mt-4">
            <div className="text-[11pt] font-semibold">Completion checklist</div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: "76%" }}>Check</th>
                  <th style={{ width: "12%" }}>Done</th>
                  <th style={{ width: "12%" }}>Initials</th>
                </tr>
              </thead>
              <tbody>
                {completion.map((item) => (
                  <tr key={item.id}>
                    <td className={cell}>{item.label}</td>
                    <td className={cell}>☐</td>
                    <td className={cell} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        <WriteIn label="Machinist signature and date" />
      </section>

      {/* ================================================================= */}
      {/* 3. Quality control                                                 */}
      {/* ================================================================= */}
      <section className="print-block print-break-before space-y-3 p-4">
        <InternalStamp />
        <div className="flex items-baseline justify-between border-b border-black pb-2">
          <div className="text-[14pt] font-bold">Quality control — {jobNumber}</div>
          <div className="text-[10pt]">{title}</div>
        </div>

        {quality.length ? (
          <table>
            <thead>
              <tr>
                <th style={{ width: "46%" }}>Check</th>
                <th style={{ width: "26%" }}>Specification / note</th>
                <th style={{ width: "16%" }}>Measured</th>
                <th style={{ width: "6%" }}>Pass</th>
                <th style={{ width: "6%" }}>Fail</th>
              </tr>
            </thead>
            <tbody>
              {quality.map((item) => (
                <tr key={item.id}>
                  <td className={cell}>{item.label}</td>
                  <td className={cell}>{item.detail ?? ""}</td>
                  <td className={cell} />
                  <td className={cell}>☐</td>
                  <td className={cell}>☐</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-[11pt] italic">
            No quality checks were listed for this job. Add them on the job page before inspection.
          </p>
        )}

        {record.failure_reason ? (
          <div className="mt-3">
            <div className="text-[9pt] uppercase tracking-wide opacity-70">Previous failure / rework reason</div>
            <p className="whitespace-pre-wrap text-[11pt]">{String(record.failure_reason)}</p>
          </div>
        ) : null}

        <div className="grid grid-cols-2 gap-6">
          <WriteIn label="Inspected by and date" />
          <WriteIn label="Accepted / rejected" />
        </div>
      </section>
    </div>
  );
}
