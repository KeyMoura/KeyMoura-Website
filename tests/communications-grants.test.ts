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
