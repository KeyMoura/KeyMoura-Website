import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * Grants and RLS for the communications migration, tested **separately**.
 *
 * They are separate because they fail separately, and pass 5a is the proof: four
 * tables shipped with correct RLS, correct permission keys and correct queries,
 * and every read died with `42501` because the migration issued no grants. Table
 * privileges are checked *before* row level security, and `service_role`'s
 * BYPASSRLS bypasses policies but **not** grants — so a policy test passing
 * tells you nothing about whether anybody can read the table.
 *
 * The last test in the grants section is the generalizable one: it derives what
 * must be granted from what the migration *creates*, so the next table added
 * here cannot ship ungranted the way the first four did.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Executable SQL only.
 *
 * This migration is heavily commented and the comments necessarily name the
 * very things under assertion — "TRUNCATE", "anon", "authenticated", "grant".
 * A check against the raw file would test the prose rather than the statement,
 * which is worse than no check: it passes when the comment is right and the SQL
 * is wrong.
 */
const sqlOf = (source: string) => source.replace(/--[^\n]*/g, "");

const RAW = read("supabase/migrations/20260806030000_communications_center.sql");
const SQL = sqlOf(RAW);

const statements = SQL.split(";")
  .map((statement) => statement.trim().replace(/\s+/g, " "))
  .filter(Boolean);

const grantStatements = statements.filter((statement) => /^grant\s/i.test(statement));
const revokeStatements = statements.filter((statement) => /^revoke\s/i.test(statement));

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/** Tables this migration creates, derived rather than listed. */
const createdTables = [...SQL.matchAll(/create table if not exists public\.([a-z_]+)/g)].map((m) => m[1]);
/** Sequences this migration creates, via `generated always as identity`. */
const createdIdentityTables = [...SQL.matchAll(/create table if not exists public\.([a-z_]+) \(\s*id bigint generated always as identity/g)].map((m) => m[1]);
/** Functions this migration creates. */
const createdFunctions = [...SQL.matchAll(/create or replace function public\.([a-z_]+)\(/g)].map((m) => m[1]);

test("the migration creates what this pass says it creates", () => {
  assert.deepEqual(
    createdTables.sort(),
    ["integration_health_events", "launch_readiness_acknowledgements", "payment_discrepancy_reviews"],
    "the derived table list is what every other assertion here is built from"
  );
  assert.deepEqual(createdFunctions, ["migration_ledger_versions"]);
  assert.deepEqual(createdIdentityTables, ["integration_health_events"]);
});

test("every new table grants service_role what the application needs", () => {
  for (const table of createdTables) {
    const granted = grantStatements.filter((statement) => statement.includes(`public.${table} `) || statement.includes(`public.${table} to`));
    assert.ok(
      granted.some((statement) => /to service_role/.test(statement) && /select/.test(statement)),
      `public.${table} has no SELECT grant for service_role, so every read would fail with 42501`
    );
  }
});

test("every new table revokes anon, authenticated and public first", () => {
  for (const table of createdTables) {
    assert.ok(
      revokeStatements.some(
        (statement) =>
          statement.includes(`public.${table}`) &&
          statement.includes("anon") &&
          statement.includes("authenticated") &&
          statement.includes("public")
      ),
      `public.${table} does not revoke the default ACL, which carries TRUNCATE — and TRUNCATE is not filtered by RLS`
    );
  }
});

test("no new table grants DELETE to anybody", () => {
  /*
   * An acknowledgement is cleared, a review is superseded and an observation is
   * history. None of the three is ever removed by the application, so the
   * privilege that would let it is not granted.
   */
  for (const statement of grantStatements) {
    assert.ok(!/\bdelete\b/i.test(statement), `a DELETE grant appeared: ${statement}`);
  }
});

test("integration_health_events is append-only at the grant level", () => {
  const granted = grantStatements.find(
    (statement) => statement.includes("public.integration_health_events") && statement.includes("to service_role")
  );
  assert.ok(granted, "no service_role grant for integration_health_events");
  assert.match(granted!, /grant select, insert on/i, "an observation is history and must not be updatable");
  assert.ok(!/update/i.test(granted!), "health observations must not be rewritable");
});

test("the identity sequence is granted, because pass 5a's second outage was an ungranted sequence", () => {
  for (const table of createdIdentityTables) {
    assert.ok(
      grantStatements.some(
        (statement) => statement.includes(`sequence public.${table}_id_seq`) && statement.includes("to service_role")
      ),
      `public.${table}_id_seq has no usage grant, so the first insert would fail on nextval`
    );
    assert.ok(
      revokeStatements.some((statement) => statement.includes(`sequence public.${table}_id_seq`)),
      `public.${table}_id_seq does not revoke the default ACL`
    );
  }
});

test("every new function is revoked from public before being granted narrowly", () => {
  /*
   * A `security definer` function defaults to EXECUTE for PUBLIC. Skipping the
   * revoke is what puts a function in the Supabase advisor's "executable by
   * anon/authenticated" warning — and this one reads a schema PostgREST does
   * not expose.
   */
  for (const fn of createdFunctions) {
    assert.ok(
      revokeStatements.some(
        (statement) =>
          statement.includes(`function public.${fn}(`) &&
          statement.includes("public") &&
          statement.includes("anon") &&
          statement.includes("authenticated")
      ),
      `public.${fn} is not revoked from public/anon/authenticated`
    );
    assert.ok(
      grantStatements.some(
        (statement) => statement.includes(`function public.${fn}(`) && statement.includes("to service_role")
      ),
      `public.${fn} has no execute grant for service_role`
    );
  }
});

test("the ledger function pins its search_path and reads only versions", () => {
  const declaration = SQL.slice(
    SQL.indexOf("create or replace function public.migration_ledger_versions"),
    SQL.indexOf("comment on function public.migration_ledger_versions")
  );
  assert.match(declaration, /security definer/);
  // Unpinned, a caller's search_path could redirect what a definer function reads.
  assert.match(declaration, /set search_path = public, pg_temp/);
  assert.match(declaration, /stable/);

  /*
   * The body only, between the dollar quotes. Scoping matters: the `comment on`
   * statement immediately below the function legitimately contains the words
   * "statements" and "rollback" while promising the opposite, so a check over
   * the surrounding text tests the prose rather than the query.
   */
  const body = /as \$\$([\s\S]*?)\$\$/.exec(declaration)?.[1] ?? "";
  assert.ok(body.length > 0, "the function body could not be located");
  assert.match(body, /select m\.version::text/);
  // Versions only: never the statements, the rollback SQL or the idempotency key.
  for (const column of ["statements", "rollback", "idempotency_key", "created_by"]) {
    assert.ok(!body.includes(column), `the ledger function exposes ${column}`);
  }
  assert.ok(!/insert|update|delete/i.test(body), "a definer function that reads must not also write");
});

test("no grant is issued to anon or authenticated beyond a deliberate SELECT", () => {
  for (const statement of grantStatements) {
    if (/to anon/.test(statement)) {
      assert.fail(`anon must never be granted anything here: ${statement}`);
    }
    if (/to authenticated/.test(statement)) {
      assert.match(
        statement,
        /^grant select on table/i,
        `authenticated may only ever hold SELECT, behind an RLS policy: ${statement}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// RLS — tested separately from the grants above
// ---------------------------------------------------------------------------

test("every new table enables row level security", () => {
  for (const table of createdTables) {
    assert.match(
      SQL,
      new RegExp(`alter table public\\.${table} enable row level security`),
      `public.${table} does not enable RLS`
    );
  }
});

test("every new table carries at least one policy", () => {
  for (const table of createdTables) {
    assert.match(SQL, new RegExp(`on public\\.${table}\\s+for select`), `public.${table} has RLS on and no policy`);
  }
});

test("no policy is granted to anon or to public", () => {
  const policies = [...SQL.matchAll(/create policy[\s\S]*?;/g)].map((m) => m[0].replace(/\s+/g, " "));
  assert.ok(policies.length >= 3, `expected a policy per new table, found ${policies.length}`);
  for (const policy of policies) {
    assert.match(policy, /to authenticated/, `a policy is not scoped to authenticated: ${policy}`);
    assert.ok(!/to anon|to public/.test(policy), `a policy reaches anon or public: ${policy}`);
  }
});

test("every policy is gated on is_staff_user()", () => {
  const policies = [...SQL.matchAll(/create policy[\s\S]*?;/g)].map((m) => m[0].replace(/\s+/g, " "));
  for (const policy of policies) {
    assert.match(policy, /is_staff_user\(\)/, `a policy is not gated on staff: ${policy}`);
  }
});

test("no new table gets an insert, update or delete policy", () => {
  /*
   * Every writer is a server route holding the service role, and each of those
   * checks a permission first. An `authenticated` write policy would be a
   * second write path with only `is_staff_user()` behind it — which is a much
   * broader test than the permission the route actually requires.
   */
  for (const verb of ["for insert", "for update", "for delete", "for all"]) {
    assert.ok(!SQL.includes(verb), `a ${verb} policy would open a second write path`);
  }
});

// ---------------------------------------------------------------------------
// Additivity
// ---------------------------------------------------------------------------

test("the migration is additive: nothing is dropped, truncated or deleted", () => {
  assert.ok(!/\btruncate\b/i.test(SQL), "truncate has no place in an additive migration");
  assert.ok(!/\bdelete\s+from\b/i.test(SQL), "delete from has no place in an additive migration");
  assert.ok(!/drop\s+table/i.test(SQL));
  assert.ok(!/drop\s+column/i.test(SQL));
  assert.ok(!/drop\s+index/i.test(SQL));
  /*
   * The one `drop constraint` is the status CHECK being *widened*: the wider
   * constraint is added first and validates every stored row, and only then is
   * the narrower one retired. Asserted explicitly rather than allowed by a
   * blanket exception.
   */
  const drops = [...SQL.matchAll(/drop constraint[^;]*/g)].map((m) => m[0].replace(/\s+/g, " ").trim());
  assert.deepEqual(drops, ["drop constraint if exists email_deliveries_status_check"]);
});

test("no existing table is altered beyond adding a column or widening a check", () => {
  const alters = [...SQL.matchAll(/alter table public\.([a-z_]+)([\s\S]*?);/g)];
  for (const [, table, body] of alters) {
    if (["notifications", "email_deliveries"].includes(table)) {
      assert.ok(
        /add column if not exists|add constraint|drop constraint if exists|rename constraint|enable row level security/.test(body),
        `unexpected alteration of public.${table}: ${body.trim().slice(0, 120)}`
      );
      assert.ok(!/alter column|set not null/i.test(body), `public.${table} must not have a column narrowed`);
    }
  }
});

test("every added column is nullable or defaulted, so no row needs a backfill", () => {
  const added = [...SQL.matchAll(/add column if not exists (\w+) ([^,;]+)/g)];
  assert.ok(added.length >= 8, `expected the new columns, found ${added.length}`);
  for (const [, column, definition] of added) {
    if (/not null/i.test(definition)) {
      assert.match(
        definition,
        /default/i,
        `${column} is NOT NULL with no default, which would fail on every existing row`
      );
    }
  }
});

test("template seeds cannot overwrite wording an owner has edited", () => {
  assert.match(SQL, /on conflict \(key\) do nothing/);
  assert.ok(!/on conflict[^;]*do update/i.test(SQL), "re-running must never rewrite an edited template");
});

test("the notification index is partial, so existing rows need no backfill", () => {
  assert.match(SQL, /create unique index if not exists notifications_user_event_key_idx[\s\S]*?where event_key is not null/);
});

test("nothing in the migration touches an order, a payment or a refund", () => {
  /*
   * KM-0001 and KM-0002 are the reason this assertion exists. The migration
   * creates a table that *records a review of* an order; it must never write to
   * the order itself.
   */
  for (const forbidden of [
    /update public\.orders/i,
    /insert into public\.orders/i,
    /update public\.order_payments/i,
    /insert into public\.order_payments/i,
    /update public\.order_refunds/i,
  ]) {
    assert.ok(!forbidden.test(SQL), `the migration writes to financial data: ${forbidden}`);
  }
});

// ---------------------------------------------------------------------------
// Selected columns must exist
// ---------------------------------------------------------------------------

/**
 * A column that does not exist is a 42703, and a 42703 handled by `data ?? []`
 * is a confident wrong answer.
 *
 * This pass shipped `select("order_id,amount_cents,status")` against
 * `order_payments`, which has no `status` column — the two-phase accounting
 * added in pass 7 records a payment row only once the money is real, so there
 * is no status to carry. The read would have failed on every request, the
 * discrepancy finder would have read zero payments for every order, and the
 * launch-readiness page would have announced that **every paid order in the
 * shop** has no payment record behind it. Caught by a live production probe.
 *
 * `installer.test.ts` already proves every `.from("…")` relation exists. This is
 * the column-level equivalent, scoped to the modules this pass added — which is
 * where the defect was, and where a false claim about money would surface.
 */

const SCOPED_DIRS = [
  "src/lib/ops",
  "src/lib/comms",
  "src/app/api/staff/emails/deliveries",
  "src/app/api/staff/integrations",
  "src/app/api/staff/launch-readiness",
];

function walk(dir: string): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const entry of readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(path));
    else if (/\.tsx?$/.test(entry.name)) out.push(path);
  }
  return out;
}

/** Columns each table is given by any migration or installer file in the repo. */
function schemaColumns(): Map<string, Set<string>> {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const files: string[] = [];
  for (const dir of ["supabase/migrations", "supabase/installer"]) {
    const collect = (d: string) => {
      for (const entry of readdirSync(new URL(`../${d}`, import.meta.url), { withFileTypes: true })) {
        if (entry.isDirectory()) collect(`${d}/${entry.name}`);
        else if (entry.name.endsWith(".sql")) files.push(`${d}/${entry.name}`);
      }
    };
    try { collect(dir); } catch { /* installer subdirs vary */ }
  }
  const sql = files.map(read).join("\n").replace(/--[^\n]*/g, "");
  const map = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    if (!map.has(table)) map.set(table, new Set());
    map.get(table)!.add(column);
  };

  for (const match of sql.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\s*\);/g)) {
    const [, table, body] = match;
    for (const line of body.split("\n")) {
      const column = /^\s*(\w+)\s+(uuid|text|boolean|integer|bigint|numeric|jsonb|timestamptz|timestamp|date|serial|bigserial)/i.exec(line);
      if (column) add(table, column[1]);
      const identity = /^\s*(\w+)\s+bigint generated always as identity/i.exec(line);
      if (identity) add(table, identity[1]);
    }
  }
  for (const match of sql.matchAll(/alter table (?:only )?public\.(\w+)([\s\S]*?);/g)) {
    const [, table, body] = match;
    for (const col of body.matchAll(/add column (?:if not exists )?(\w+)/g)) add(table, col[1]);
  }
  return map;
}

test("no scoped module selects a column its table does not have", () => {
  const columns = schemaColumns();
  const offenders: string[] = [];

  for (const file of SCOPED_DIRS.flatMap(walk)) {
    const source = read(file);
    for (const call of source.matchAll(/\.from\("(\w+)"\)\s*\n?\s*\.select\(\s*"([^"]+)"/g)) {
      const [, table, selection] = call;
      const known = columns.get(table);
      // A table this repo never creates is the installer test's problem, not this one.
      if (!known || known.size === 0) continue;
      for (const raw of selection.split(",")) {
        const column = raw.trim().split(/[:(!]/)[0].trim();
        // `*`, embedded resources and counts are not plain columns.
        if (!column || column === "*" || column.includes("*")) continue;
        if (!known.has(column)) offenders.push(`${file}: ${table}.${column}`);
      }
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these selects name a column the schema never creates, which is a 42703 on every request:\n${offenders.join("\n")}`
  );
});

test("REGRESSION order_payments has no status column, and nothing selects one", () => {
  const columns = schemaColumns().get("order_payments");
  assert.ok(columns, "order_payments should be created by a migration");
  assert.ok(!columns!.has("status"), "order_payments has no status column");
  assert.ok(columns!.has("amount_cents") && columns!.has("received_at"));

  for (const file of SCOPED_DIRS.flatMap(walk)) {
    // Whitespace is collapsed first so the check reaches the `.select(...)`
    // that belongs to this `.from(...)`, and only that one — an unbounded
    // lookahead runs straight into the next query's `order_status_history`.
    const collapsed = read(file).replace(/\s+/g, " ");
    assert.ok(
      !/from\("order_payments"\) ?\.select\( ?"[^"]*status/.test(collapsed),
      `${file} still selects a status column from order_payments`
    );
  }
});

test("REGRESSION a failed payments read is not reported as 'no payments exist'", () => {
  /*
   * The finder guards *both* reads. Guarding only `orders` was what would have
   * turned a 42703 into "every paid order has no payment record" — the
   * `data ?? []` defect, in a file the staff-page audit does not walk.
   */
  const source = read("src/lib/ops/evidence.ts");
  assert.match(source, /if \(orders\.error \|\| payments\.error\) return \[\];/);
});
