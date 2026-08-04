import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { bucketJobs, type ProductionJobLike } from "../src/lib/production/jobs.ts";

/**
 * The production queue's grant repair.
 *
 * The queue failed in production with "Could not load the production queue."
 * for every request, on every filter, for admins included. The cause was not
 * RLS, not a permission key, and not a bad column: `20260804010000` created
 * four tables and a sequence and issued no `grant` statements at all.
 *
 * This project's default privileges hand new `public` tables only `Dxtm`
 * (TRUNCATE, REFERENCES, TRIGGER, MAINTAIN) to anon, authenticated and
 * service_role — no SELECT, INSERT, UPDATE or DELETE. Table privileges are
 * checked before row level security, and `service_role`'s BYPASSRLS bypasses
 * policies but not grants, so every service-role read died with
 * `42501: permission denied for table production_jobs` before a policy was
 * ever consulted.
 *
 * The last test here is the generalizable one: it derives what must be granted
 * from what the schema migration creates, so the next table added to this
 * system cannot repeat the omission.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const schema = read("supabase/migrations/20260804010000_production_jobs.sql");
const grants = read("supabase/migrations/20260804020000_production_job_grants.sql");

const listRoute = read("src/app/api/staff/production/jobs/route.ts");
const summaryRoute = read("src/app/api/staff/production/summary/route.ts");
const detailRoute = read("src/app/api/staff/production/jobs/[id]/route.ts");
const server = read("src/lib/production/server.ts");
const queuePage = read("src/app/staff/production/page.tsx");
const jobPage = read("src/app/staff/production/[id]/page.tsx");
const dashboardPanel = read("src/components/staff/production/ProductionDashboardPanel.tsx");
const orderPanel = read("src/components/staff/production/OrderProductionJobs.tsx");

/**
 * Executable SQL only.
 *
 * These migrations are heavily commented, and the comments necessarily name the
 * very things being asserted about — "TRUNCATE", "anon", "authenticated". A
 * check run against the raw file therefore tests the prose rather than the SQL,
 * which is worse than no check: it passes when the prose is right and the
 * statement is wrong.
 */
const sqlOf = (source: string) => source.replace(/--[^\n]*/g, "");

const grantsSql = sqlOf(grants);

/** Grant statements only, with the revokes and comments stripped out. */
const grantStatements = grantsSql
  .split(";")
  .map((statement) => statement.trim().replace(/\s+/g, " "))
  .filter((statement) => /^grant\s/i.test(statement));

// ---------------------------------------------------------------------------
// The grants themselves
// ---------------------------------------------------------------------------

test("the service role can read and write every production table", () => {
  for (const table of ["production_jobs", "production_job_tasks", "production_job_files"]) {
    assert.match(grantsSql,
      new RegExp(`grant select, insert, update, delete on public\\.${table} to service_role`),
      `${table} must be granted to the service role — the staff API reads it with that key`
    );
  }
});

test("the timeline is append-only at the privilege layer, not only by policy", () => {
  // 20260804010000 gives production_job_events select and insert policies and
  // deliberately no update or delete policy. Granting only select and insert
  // makes that true for the service role as well, which RLS never constrains.
  assert.match(grantsSql, /grant select, insert on public\.production_job_events to service_role/);

  const eventGrants = grantStatements.filter((statement) => statement.includes("production_job_events"));
  assert.equal(eventGrants.length, 1, "the timeline should have exactly one grant statement");
  assert.doesNotMatch(eventGrants[0], /\bupdate\b|\bdelete\b/, "a job's history must not be rewritable");
});

test("the job-number sequence is granted, so creating a job works", () => {
  // `job_number` defaults to next_production_job_number(), which calls nextval.
  // That function is not SECURITY DEFINER, so the sequence is touched as the
  // inserting role. Without this grant the table grants above are not enough:
  // INSERT fails with "permission denied for sequence".
  assert.match(grantsSql, /grant usage, select on sequence public\.production_job_number_seq to service_role/);
  assert.match(grantsSql, /grant execute on function public\.next_production_job_number\(\) to service_role/);
});

test("nothing is granted to anon or to authenticated", () => {
  for (const statement of grantStatements) {
    assert.doesNotMatch(statement, /\bto\b[^;]*\banon\b/i, `anon must never be granted: ${statement}`);
    assert.doesNotMatch(
      statement,
      /\bto\b[^;]*\bauthenticated\b/i,
      `authenticated must never be granted — every read goes through the staff API: ${statement}`
    );
  }
  assert.doesNotMatch(grantsSql, /to public\b/i, "nothing may be granted to PUBLIC");

  // Guard the guard: if the statement split ever stops matching, every
  // assertion above passes over an empty list and proves nothing.
  assert.ok(grantStatements.length >= 6, `expected the grant statements, parsed ${grantStatements.length}`);
});

test("anon and authenticated are revoked, including the TRUNCATE they inherit", () => {
  // Both roles pick up Dxtm from the default ACL, and TRUNCATE is not filtered
  // by row level security — so leaving it in place would be a real hole that no
  // policy closes.
  for (const table of [
    "production_jobs",
    "production_job_tasks",
    "production_job_files",
    "production_job_events",
  ]) {
    assert.match(grantsSql, new RegExp(`revoke all on public\\.${table} from anon, authenticated`));
  }
  assert.match(grantsSql, /revoke all on sequence public\.production_job_number_seq from anon, authenticated/);
});

test("the repair is additive and preserves the original migration and its data", () => {
  assert.doesNotMatch(grantsSql, /\bdrop\b/i, "no drop statements");
  assert.doesNotMatch(grantsSql, /\btruncate\b/i, "no truncate");
  assert.doesNotMatch(grantsSql, /delete\s+from/i, "no deletes");
  assert.doesNotMatch(grantsSql, /create\s+table/i, "no replacement table");
  assert.doesNotMatch(grantsSql, /alter\s+table/i, "no existing table is altered");
  assert.doesNotMatch(grantsSql, /drop\s+policy|create\s+policy/i, "RLS policies are left exactly as they were");

  // The original migration must still be present and untouched.
  assert.match(schema, /create table if not exists public\.production_jobs/);
  assert.match(schema, /alter table public\.production_jobs enable row level security/);
});

test("row level security stays enabled on all four tables", () => {
  for (const table of [
    "production_jobs",
    "production_job_tasks",
    "production_job_files",
    "production_job_events",
  ]) {
    assert.match(schema, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});

// ---------------------------------------------------------------------------
// The lesson, generalized
// ---------------------------------------------------------------------------

test("every table and sequence the schema creates is granted to the service role", () => {
  // This is the test that fails against the bug. It derives the requirement
  // from the schema rather than restating a list, so a fifth production table
  // added later cannot ship ungranted the way the first four did.
  const tables = [...schema.matchAll(/create table if not exists public\.(\w+)/g)].map((m) => m[1]);
  const sequences = [...schema.matchAll(/create sequence if not exists public\.(\w+)/g)].map((m) => m[1]);

  assert.ok(tables.length >= 4, "expected the four production tables");
  assert.ok(sequences.length >= 1, "expected the job-number sequence");

  for (const table of tables) {
    assert.ok(
      new RegExp(`grant [^;]*on public\\.${table} to service_role`).test(grantsSql),
      `public.${table} is created but never granted — the staff API cannot read it`
    );
  }
  for (const sequence of sequences) {
    assert.ok(
      new RegExp(`grant [^;]*on sequence public\\.${sequence} to service_role`).test(grantsSql),
      `public.${sequence} is created but never granted — inserting will fail on nextval`
    );
  }
});

// ---------------------------------------------------------------------------
// Failures are logged, not swallowed
// ---------------------------------------------------------------------------

test("a failed production query is logged server-side", () => {
  assert.match(server, /export function logProductionFailure/);
  for (const [name, source] of [
    ["list", listRoute],
    ["detail", detailRoute],
    ["summary", summaryRoute],
  ] as const) {
    assert.match(source, /logProductionFailure\(/, `${name} route must log the real failure`);
  }
});

test("the log records the error's shape and never its payload", () => {
  const body = server.slice(server.indexOf("export function logProductionFailure"));
  const call = body.slice(0, body.indexOf("}\n"));

  assert.match(call, /code/, "the SQLSTATE is what identifies the failure");
  assert.match(call, /message/);
  assert.match(call, /hint/);
  // `details` echoes row values back (a unique violation reports the conflicting
  // key), and a job carries internal notes, costs and customer identifiers.
  assert.doesNotMatch(call, /details/, "details echoes row values and must not be logged");

  for (const secret of ["SERVICE_ROLE", "ANON_KEY", "token", "cookie", "authorization"]) {
    assert.ok(!call.toLowerCase().includes(secret.toLowerCase()), `${secret} must never be logged`);
  }
});

test("a refused count is not reported as zero", () => {
  // PostgREST resolves rather than rejects on an error, so `count ?? 0` turns a
  // permission failure into a dashboard reading "0 open, 0 overdue" — which is
  // how this outage stayed invisible on the dashboard beside a queue that was
  // visibly erroring.
  assert.match(summaryRoute, /if \(result\.error\) throw result\.error/);
});

// ---------------------------------------------------------------------------
// Refusal reads as refusal, emptiness reads as emptiness
// ---------------------------------------------------------------------------

test("every production surface treats 403 as permission denied, not a load failure", () => {
  for (const [name, source] of [
    ["queue", queuePage],
    ["job workspace", jobPage],
    ["dashboard panel", dashboardPanel],
    ["order panel", orderPanel],
  ] as const) {
    assert.match(
      source,
      /response\.status === 403/,
      `${name} must distinguish a refusal from a failure`
    );
    assert.match(source, /setDenied\(true\)/, `${name} must render a permission-denied state`);
  }
});

test("the queue's denied state names the permission a staff member is missing", () => {
  assert.match(queuePage, /production\.view permission/);
  assert.match(jobPage, /production\.view permission/);
});

test("an empty queue is an empty state, never an error", () => {
  // The route distinguishes them: `error` is a failure, `data ?? []` is an
  // answer. The page renders EmptyState off the job count, not off `error`.
  assert.match(listRoute, /const jobs = data \?\? \[\]/);
  assert.match(queuePage, /No production jobs yet\./);
  assert.match(queuePage, /!jobs\.length \? \(/);

  const buckets = bucketJobs([], new Date(2026, 7, 4));
  assert.deepEqual(buckets, { overdue: [], blocked: [], active: [], finished: [] });
});

test("one job, and a job with no optional relationships, both bucket cleanly", () => {
  const NOW = new Date(2026, 7, 4, 13, 30, 0);
  const bare: ProductionJobLike = {
    status: "not_started",
    priority: "normal",
    due_date: null,
    created_at: "2026-08-01T00:00:00.000Z",
  };

  const one = bucketJobs([bare], NOW);
  assert.equal(one.active.length, 1, "a job with every link null is still queued");
  assert.equal(one.overdue.length + one.blocked.length + one.finished.length, 0);

  // The reference loader is what turns those nulls into names; it must not be
  // asked for any of them when there is nothing to resolve.
  assert.match(server, /if \(job\.order_id\) orderIds\.add/);
  assert.match(server, /orderIds\.size\s*\?/, "no query is issued when nothing is linked");
});
