import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PERMISSIONS, PERMISSION_META } from "../src/lib/permissions.ts";
import {
  PRODUCTION_FILE_KINDS,
  PRODUCTION_STATUSES,
  PRODUCTION_TASK_KINDS,
} from "../src/lib/production/jobs.ts";

/**
 * Wiring checks.
 *
 * The domain suite proves the rules are right; this one proves they are
 * actually reachable — that the routes are permission-gated, that the database
 * agrees with the TypeScript about what a status is, and that the separations
 * the design depends on are still separate.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/20260804010000_production_jobs.sql");
const listRoute = read("src/app/api/staff/production/jobs/route.ts");
const detailRoute = read("src/app/api/staff/production/jobs/[id]/route.ts");
const statusRoute = read("src/app/api/staff/production/jobs/[id]/status/route.ts");
const tasksRoute = read("src/app/api/staff/production/jobs/[id]/tasks/route.ts");
const filesRoute = read("src/app/api/staff/production/jobs/[id]/files/route.ts");
const summaryRoute = read("src/app/api/staff/production/summary/route.ts");
const printPage = read("src/app/staff/production/[id]/print/page.tsx");
const jobPage = read("src/app/staff/production/[id]/page.tsx");
const staffNav = read("src/components/staff/StaffNav.tsx");
const dashboardPanel = read("src/components/staff/production/ProductionDashboardPanel.tsx");
const jobForm = read("src/components/staff/production/JobForm.tsx");
const globals = read("src/app/globals.css");
const layout = read("src/app/layout.tsx");

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

test("the production permissions are registered and described", () => {
  for (const key of ["production.view", "production.manage"] as const) {
    assert.ok((PERMISSIONS as readonly string[]).includes(key), `${key} must be a real permission`);
    assert.ok(PERMISSION_META[key]?.label, `${key} needs a label`);
    assert.ok(PERMISSION_META[key]?.description, `${key} needs a description`);
  }
});

test("every production route is permission-gated", () => {
  // A staff route that forgets its check is the whole failure mode this guards.
  const routes: Array<[string, string]> = [
    ["list", listRoute],
    ["detail", detailRoute],
    ["status", statusRoute],
    ["tasks", tasksRoute],
    ["files", filesRoute],
    ["summary", summaryRoute],
  ];
  for (const [name, source] of routes) {
    assert.match(source, /require(Permission|AnyPermission)\(/, `${name} route must check a permission`);
    assert.match(source, /production\.(view|manage)/, `${name} route must check a production permission`);
  }
});

test("reading is separated from writing", () => {
  // Every mutating handler demands `production.manage`; only reads accept `view`.
  for (const [name, source] of [
    ["status", statusRoute],
    ["tasks", tasksRoute],
    ["files", filesRoute],
  ] as const) {
    assert.ok(
      source.includes(`requirePermission(req, "production.manage")`),
      `${name} route must require production.manage to write`
    );
    assert.ok(
      !source.includes(`requireAnyPermission(req, ["production.view"`),
      `${name} route must not let a read-only permission write`
    );
  }
});

test("the print page is gated too, not just the API behind it", () => {
  assert.match(printPage, /getServerActorAccess\(\)/);
  assert.match(printPage, /production\.view|production\.manage/);
});

// ---------------------------------------------------------------------------
// The database and the TypeScript must agree
// ---------------------------------------------------------------------------

test("the status check constraint lists exactly the statuses the code knows", () => {
  const block = /production_jobs_status_check[\s\S]*?check \(status in \(([\s\S]*?)\)\)/.exec(migration);
  assert.ok(block, "the status constraint must exist in the migration");

  const fromSql = [...block[1].matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(fromSql, [...PRODUCTION_STATUSES].sort(), "a status the UI offers must be one Postgres accepts");
});

test("the priority, task-kind and file-kind constraints agree with the code", () => {
  const pairs: Array<[RegExp, readonly string[]]> = [
    [/production_jobs_priority_check[\s\S]*?check \(priority in \(([\s\S]*?)\)\)/, ["low", "normal", "high", "urgent"]],
    [/production_job_tasks_kind_check check \(kind in \(([\s\S]*?)\)\)/, PRODUCTION_TASK_KINDS],
    [/production_job_files_kind_check\s*\n?\s*check \(kind in \(([\s\S]*?)\)\)/, PRODUCTION_FILE_KINDS],
  ];

  for (const [pattern, expected] of pairs) {
    const match = pattern.exec(migration);
    assert.ok(match, `constraint not found for ${expected.join(",")}`);
    const fromSql = [...match[1].matchAll(/'([a-z_]+)'/g)].map((entry) => entry[1]).sort();
    assert.deepEqual(fromSql, [...expected].sort());
  }
});

test("the migration is additive and touches nothing that already exists", () => {
  // Anything that would rewrite existing data or drop an object would make this
  // migration unsafe to apply to a live database.
  assert.ok(!/\bdrop table\b/i.test(migration), "no table may be dropped");
  assert.ok(!/\bdrop column\b/i.test(migration), "no column may be dropped");
  assert.ok(!/\btruncate\b/i.test(migration), "nothing may be truncated");
  assert.ok(!/\bdelete from\b/i.test(migration), "nothing may be deleted");
  assert.ok(!/alter table public\.(orders|products|profiles|order_items)\b/i.test(migration),
    "existing commerce tables must not be altered");
});

test("every production table enables row level security", () => {
  for (const table of [
    "production_jobs",
    "production_job_tasks",
    "production_job_files",
    "production_job_events",
  ]) {
    assert.ok(
      migration.includes(`alter table public.${table} enable row level security`),
      `${table} must have RLS enabled`
    );
  }
});

test("production tables are staff-only — no customer or anon policy", () => {
  assert.ok(!/to (anon|public)\b/.test(migration), "no policy may be granted to anon or public");
  assert.ok(!/customer_id = \(select auth\.uid\(\)\)/.test(migration), "customers must not read manufacturing data");
  const policies = migration.match(/create policy/g) ?? [];
  const staffChecks = migration.match(/is_staff_user\(\)/g) ?? [];
  assert.ok(staffChecks.length >= policies.length, "every policy must be gated on is_staff_user()");
});

test("the job timeline has no update or delete policy", () => {
  // Staff may append to a job's history and read it; rewriting it through
  // PostgREST must not be possible.
  const eventPolicies = migration
    .split("production_job_events")
    .filter((chunk) => chunk.includes("create policy"));
  assert.ok(eventPolicies.length > 0);
  assert.ok(
    !/on public\.production_job_events\s+for (update|delete|all)/.test(migration),
    "the timeline must be append-only"
  );
});

// ---------------------------------------------------------------------------
// The separations the design depends on
// ---------------------------------------------------------------------------

test("saving fields cannot change status", () => {
  // PATCH pins the status to whatever the row already holds and strips it from
  // the update, so a field save can never move a job through the workflow.
  assert.match(detailRoute, /status: before\.status/);
  assert.match(detailRoute, /const \{ status: _ignored, \.\.\.fields \} = draft/);
});

test("a status change is guarded against a stale page", () => {
  assert.match(statusRoute, /expectedStatus/);
  // And again in the WHERE clause, which closes the read-then-write gap.
  assert.match(statusRoute, /\.eq\("status", from\)/);
  assert.match(statusRoute, /status: 409/);
});

test("field saves are guarded against a stale page too", () => {
  assert.match(detailRoute, /expectedUpdatedAt/);
  assert.match(detailRoute, /status: 409/);
});

test("selecting a status in the dropdown does not write", () => {
  // The select only sets local state; the write lives on a separate button.
  assert.match(jobPage, /onChange=\{\(event\) => \{\s*setTargetStatus/);
  assert.match(jobPage, /onClick=\{\(\) => void changeStatus\(false\)\}/);
  assert.ok(
    !/onChange=\{[^}]*changeStatus/.test(jobPage),
    "changing the dropdown must never call changeStatus directly"
  );
});

test("saving details is explicit and disabled until something changed", () => {
  assert.match(jobPage, /type="submit"[\s\S]{0,120}disabled=\{busy \|\| !dirty\}/);

  // The real property: the only thing that calls saveFields is the form's own
  // submit handler. A timer or an effect calling it would be an autosave, which
  // this form deliberately does not do.
  const callSites = [...jobPage.matchAll(/void saveFields\(\)/g)];
  assert.equal(callSites.length, 1, "saveFields must have exactly one call site");
  assert.match(jobPage, /onSubmit=\{\(event\) => \{\s*event\.preventDefault\(\);\s*void saveFields\(\);/);
  assert.ok(!/setTimeout\([^)]*saveFields/.test(jobPage), "no debounced save");
  assert.ok(
    !/useEffect\([\s\S]{0,400}saveFields\(/.test(jobPage),
    "no effect may save the form"
  );
});

test("destructive actions confirm first", () => {
  const confirms = jobPage.match(/window\.confirm\(/g) ?? [];
  assert.ok(confirms.length >= 3, `expected removal and sharing to confirm, found ${confirms.length}`);
  assert.match(jobPage, /Make “\$\{file\.label\}” visible to the customer\?/);
});

test("completion warnings are advisory, not a block", () => {
  // The route answers 409 with the warnings once, and the same call with
  // `acknowledge` goes through. Nothing refuses completion outright.
  assert.match(statusRoute, /requiresAcknowledgement: true/);
  assert.match(statusRoute, /body\.acknowledge !== true/);
  assert.match(jobPage, /changeStatus\(true\)/);
});

// ---------------------------------------------------------------------------
// Internal versus customer-visible
// ---------------------------------------------------------------------------

test("the printable document is marked internal on every section", () => {
  const stamps = printPage.match(/<InternalStamp \/>/g) ?? [];
  assert.equal(stamps.length, 3, "the traveller, work order and QC sheet each carry the stamp");
  assert.match(printPage, /Internal document — not for the customer/);
});

test("attached files are internal until deliberately shared", () => {
  assert.match(migration, /is_customer_visible boolean not null default false/);
  assert.match(filesRoute, /is_customer_visible: body\?\.isCustomerVisible === true/);
});

test("the two notes fields say which is which where they are edited", () => {
  assert.match(jobForm, /Never shown to the customer/);
  assert.match(jobForm, /Written for the customer/);
});

test("a file's visibility change is audited", () => {
  assert.match(filesRoute, /staff\.production\.job\.file_visibility/);
});

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

test("every consequential job action writes an audit event", () => {
  const expected = [
    "staff.production.job.create",
    "staff.production.job.update",
    "staff.production.job.status",
    "staff.production.job.task_add",
    "staff.production.job.task_update",
    "staff.production.job.task_remove",
    "staff.production.job.file_add",
    "staff.production.job.file_visibility",
    "staff.production.job.file_remove",
  ];
  const all = [listRoute, detailRoute, statusRoute, tasksRoute, filesRoute].join("\n");
  for (const type of expected) {
    assert.ok(all.includes(type), `${type} must be emitted`);
  }
});

test("audit event types use the staff. prefix the logger retains", () => {
  // `logAuditEvent` drops anything that is not an admin/security/staff event,
  // so a differently-prefixed type would be silently discarded.
  const types = [...[listRoute, detailRoute, statusRoute, tasksRoute, filesRoute]
    .join("\n")
    .matchAll(/auditType: "([^"]+)"/g)].map((match) => match[1]);
  assert.ok(types.length >= 9);
  for (const type of types) assert.match(type, /^staff\./);
});

test("free-text note bodies are not copied into audit metadata", () => {
  // The audit log is read more widely than the job page. It records which
  // fields changed, not what was written in them.
  assert.match(detailRoute, /metadata: \{ fields: changed \}/);
  assert.ok(!/metadata:.*internal_notes/.test(detailRoute));
});

// ---------------------------------------------------------------------------
// Navigation, dashboard, print CSS
// ---------------------------------------------------------------------------

test("production appears in the staff navigation behind its permission", () => {
  assert.match(staffNav, /href: "\/staff\/production"/);
  assert.match(staffNav, /anyOf: \["production\.view", "production\.manage"\]/);
});

test("every dashboard card links to a queue filter the API understands", () => {
  const hrefs = [...dashboardPanel.matchAll(/href: "\/staff\/production\?([^"]+)"/g)].map((match) => match[1]);
  assert.ok(hrefs.length >= 5, `expected several cards, found ${hrefs.length}`);

  const supported = new Set(["scope", "status", "priority", "assignedTo", "overdue", "orderId", "q"]);
  for (const href of hrefs) {
    for (const [key, value] of new URLSearchParams(href)) {
      assert.ok(supported.has(key), `the queue does not filter on "${key}"`);
      if (key === "status") {
        assert.ok(
          (PRODUCTION_STATUSES as readonly string[]).includes(value),
          `"${value}" is not a production status`
        );
      }
    }
  }
});

test("print styles drop the navigation chrome", () => {
  const printBlock = /@media print \{([\s\S]*?)\n\}/.exec(globals);
  assert.ok(printBlock, "globals.css must carry a print block");
  for (const selector of ["header", "footer", "nav", ".staff-nav", ".print-hidden"]) {
    assert.ok(printBlock[1].includes(selector), `${selector} must be hidden when printing`);
  }
  assert.match(globals, /@page \{\s*margin/);
});

test("the printable page uses no header, footer or nav element of its own", () => {
  // The blanket print rules above are only safe because of this.
  assert.ok(!/<header[\s>]/.test(printPage), "the print page must not use <header>");
  assert.ok(!/<footer[\s>]/.test(printPage), "the print page must not use <footer>");
  assert.ok(!/<nav[\s>]/.test(printPage), "the print page must not use <nav>");
});

test("checklists print with empty boxes so they are signed at the machine", () => {
  assert.match(printPage, /☐/);
});

// ---------------------------------------------------------------------------
// Customer-facing carryover
// ---------------------------------------------------------------------------

test("Vercel Analytics and Speed Insights are both mounted", () => {
  assert.match(layout, /from "@vercel\/analytics\/next"/);
  assert.match(layout, /<Analytics \/>/);
  assert.match(layout, /from "@vercel\/speed-insights\/next"/);
  assert.match(layout, /<SpeedInsights \/>/);
});

test("the analytics package is a real dependency", () => {
  const pkg = JSON.parse(read("package.json")) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies["@vercel/analytics"], "@vercel/analytics must be installed");
});

// ---------------------------------------------------------------------------
// Query shape
// ---------------------------------------------------------------------------

test("the dashboard counts without transferring rows", () => {
  const heads = summaryRoute.match(/head: true/g) ?? [];
  assert.ok(heads.length >= 1, "counts must use head: true");
  assert.ok(!/\.select\("\*"\)/.test(summaryRoute), "the summary must never select rows");
});

test("the queue is paginated and capped", () => {
  assert.match(listRoute, /MAX_LIMIT/);
  assert.match(listRoute, /\.range\(offset, offset \+ limit - 1\)/);
});

test("job references are resolved in batches rather than per row", () => {
  const server = read("src/lib/production/server.ts");
  assert.match(server, /\.in\("id", \[\.\.\.userIds\]\)/);

  // Scoped to the loop's own body rather than to the rest of the file, which is
  // what the previous greedy pattern was really matching.
  const loop = /for \(const job of jobs\) \{([\s\S]*?)\n  \}/.exec(server);
  assert.ok(loop, "the collect-ids loop should still exist");
  assert.ok(!/await|routeServiceClient/.test(loop[1]), "the loop only collects ids; it must not query");
});

test("the search box cannot inject extra PostgREST filters", () => {
  assert.match(listRoute, /replace\(\/\[,\(\)\\\\\]\/g, " "\)/);
});
