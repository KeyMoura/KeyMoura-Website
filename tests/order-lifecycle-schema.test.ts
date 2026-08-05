import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The lifecycle migration's safety properties, asserted from its own text.
 *
 * Two failures this suite exists to prevent:
 *
 * 1. **The pass-5a outage.** `20260804010000` created four tables and issued no
 *    grants. This database's default privileges give new `public` tables only
 *    `Dxtm` — no SELECT/INSERT/UPDATE/DELETE for any PostgREST role — and table
 *    privileges are checked *before* RLS, so `service_role`'s BYPASSRLS did not
 *    help. The last tests here derive what must be granted from what the
 *    migration creates, so a table cannot ship ungranted again.
 * 2. **A destructive "additive" migration.** Nothing may drop or truncate an
 *    existing table, column or row.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const migration = read("supabase/migrations/20260805010000_order_lifecycle_cancellations_refunds_returns.sql");
const sql = migration.toLowerCase();

const NEW_TABLES = ["order_cancellation_requests", "order_returns", "order_return_items", "inventory_adjustments"];

const NEW_FUNCTIONS = [
  "begin_order_refund",
  "settle_order_refund",
  "reconcile_stripe_refund",
  "adjust_product_inventory",
  "commit_order_inventory",
  "restore_order_inventory",
  "create_order_return",
  "restock_return_items",
  "release_order_discount",
];

/** Statements outside string literals and comments, roughly. Good enough to catch a stray DROP TABLE. */
const statements = sql
  .split("\n")
  .filter((line) => !line.trim().startsWith("--"))
  .join("\n");

// ---------------------------------------------------------------------------
// Additive
// ---------------------------------------------------------------------------

test("the migration drops no table", () => {
  assert.equal(/\bdrop\s+table\b/.test(statements), false);
});

test("the migration drops no column", () => {
  assert.equal(/\bdrop\s+column\b/.test(statements), false);
});

test("the migration truncates nothing and deletes no rows", () => {
  assert.equal(/\btruncate\b/.test(statements), false);
  assert.equal(/\bdelete\s+from\s+public\.(orders|products|order_items|order_payments|profiles)\b/.test(statements), false);
});

test("the only constraints dropped are ones the migration immediately re-adds, widened", () => {
  const dropped = [...statements.matchAll(/drop\s+constraint\s+if\s+exists\s+([a-z_0-9]+)/g)].map((match) => match[1]);
  const added = [...statements.matchAll(/add\s+constraint\s+([a-z_0-9]+)/g)].map((match) => match[1]);
  for (const name of dropped) {
    assert.equal(added.includes(name), true, `${name} is dropped but never re-added`);
  }
});

test("the widened payment_status check keeps every value that was already legal", () => {
  // Widening cannot reject a stored row; narrowing can. Every pre-existing
  // value has to survive or the migration fails against live data.
  const previouslyLegal = ["not_required", "unpaid", "partial", "paid", "refunded"];
  const clause = statements.slice(statements.indexOf("orders_payment_status_check check"));
  for (const value of previouslyLegal) {
    assert.equal(clause.includes(`'${value}'`), true, `${value} was dropped from the check`);
  }
});

test("relaxing stripe_refund_id is a DROP NOT NULL, never a column drop", () => {
  assert.equal(statements.includes("alter column stripe_refund_id drop not null"), true);
});

test("new order columns are all nullable or defaulted, so existing rows stay valid", () => {
  const block = statements.slice(statements.indexOf("alter table public.orders"), statements.indexOf("update public.orders"));
  const notNullAdds = [...block.matchAll(/add column if not exists\s+\w+\s+[a-z ]+not null(?!\s+default)/g)];
  assert.deepEqual(notNullAdds.map((match) => match[0]), []);
});

// ---------------------------------------------------------------------------
// Grants — the pass-5a lesson, generalized
// ---------------------------------------------------------------------------

test("every new table is granted to service_role", () => {
  for (const table of NEW_TABLES) {
    const pattern = new RegExp(`grant[^;]*on\\s+public\\.${table}[^;]*to\\s+service_role`, "s");
    const combined = new RegExp(`grant[^;]*\\bpublic\\.${table}\\b[^;]*to service_role`, "s");
    assert.equal(
      pattern.test(statements) || combined.test(statements),
      true,
      `${table} has no service_role grant — it would be unreadable even by the service role`
    );
  }
});

test("every new table has row level security enabled", () => {
  for (const table of NEW_TABLES) {
    assert.equal(
      statements.includes(`alter table public.${table} enable row level security`),
      true,
      `${table} does not enable RLS`
    );
  }
});

test("every new table has at least one policy", () => {
  for (const table of NEW_TABLES) {
    assert.equal(
      new RegExp(`create policy[^;]*on public\\.${table}`, "s").test(statements),
      true,
      `${table} has RLS on and no policy, which locks everyone out silently`
    );
  }
});

test("anon is revoked on every new table, which also removes its inherited TRUNCATE", () => {
  // TRUNCATE is in the default ACL and is *not* filtered by RLS, so a policy
  // does not close it. Only a revoke does.
  for (const table of NEW_TABLES) {
    assert.equal(
      new RegExp(`revoke all on public\\.${table}[^;]*from[^;]*anon`, "s").test(statements),
      true,
      `${table} leaves anon its default privileges`
    );
  }
});

test("the inventory ledger is not readable by ordinary authenticated callers", () => {
  // Stock movements expose purchase volumes and operational detail; no
  // customer surface reads them.
  assert.equal(
    /revoke all on public\.inventory_adjustments from anon, authenticated/.test(statements),
    true
  );
  assert.equal(/grant select on public\.inventory_adjustments to authenticated/.test(statements), false);
});

test("the new sequence carries an explicit usage grant", () => {
  // The production job sequence shipped with `relacl` null and creating a job
  // would have failed on nextval. Same shape of bug, same guard.
  assert.equal(/grant usage, select on sequence public\.order_return_number_seq to service_role/.test(statements), true);
  assert.equal(/revoke all on sequence public\.order_return_number_seq from anon, authenticated/.test(statements), true);
});

test("every new function is revoked from public/anon/authenticated and granted only to service_role", () => {
  for (const fn of NEW_FUNCTIONS) {
    assert.equal(
      new RegExp(`revoke all on function public\\.${fn}\\(`, "s").test(statements),
      true,
      `${fn} is not revoked from public`
    );
    assert.equal(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`, "s").test(statements),
      true,
      `${fn} has no service_role execute grant`
    );
  }
});

test("no new function is executable by anon or authenticated", () => {
  for (const fn of NEW_FUNCTIONS) {
    assert.equal(
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to (anon|authenticated)`, "s").test(statements),
      false,
      `${fn} is callable straight from PostgREST`
    );
  }
});

test("every security definer function pins its search_path", () => {
  // A SECURITY DEFINER function without a pinned search_path is a privilege
  // escalation waiting for a caller who can create a schema.
  const definers = [...migration.matchAll(/create or replace function public\.(\w+)[\s\S]*?as \$/g)];
  assert.equal(definers.length >= NEW_FUNCTIONS.length, true);
  for (const fn of NEW_FUNCTIONS) {
    const start = migration.indexOf(`create or replace function public.${fn}`);
    assert.notEqual(start, -1, `${fn} not found`);
    const header = migration.slice(start, migration.indexOf("as $", start));
    if (header.includes("security definer")) {
      assert.equal(
        header.includes("set search_path = public, pg_temp"),
        true,
        `${fn} is SECURITY DEFINER without a pinned search_path`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Concurrency and duplicate suppression, as schema facts
// ---------------------------------------------------------------------------

test("one open cancellation request per order is enforced by a unique index, not by a route", () => {
  assert.equal(
    /create unique index[^;]*order_cancellation_requests_open_idx[^;]*where status = 'pending'/s.test(statements),
    true
  );
});

test("refund idempotency keys are unique", () => {
  assert.equal(
    /create unique index[^;]*order_refunds_idempotency_key_idx[^;]*where idempotency_key is not null/s.test(statements),
    true
  );
});

test("inventory adjustments are idempotent on their key", () => {
  assert.equal(
    /create unique index[^;]*inventory_adjustments_idempotency_idx[^;]*where idempotency_key is not null/s.test(statements),
    true
  );
});

test("refundable inside begin_order_refund subtracts pending refunds", () => {
  const fn = migration.slice(
    migration.indexOf("create or replace function public.begin_order_refund"),
    migration.indexOf("create or replace function public.settle_order_refund")
  );
  assert.match(fn, /refundable := coalesce\(selected_order\.amount_paid_cents, 0\) - settled - pending/);
  assert.match(fn, /for update/);
});

test("settle_order_refund is the only place order refund totals grow", () => {
  const settle = migration.slice(
    migration.indexOf("create or replace function public.settle_order_refund"),
    migration.indexOf("create or replace function public.reconcile_stripe_refund")
  );
  assert.match(settle, /update public\.orders set\s*\n\s*amount_refunded_cents = new_order_refunded/);

  const begin = migration.slice(
    migration.indexOf("create or replace function public.begin_order_refund"),
    migration.indexOf("create or replace function public.settle_order_refund")
  );
  assert.equal(/amount_refunded_cents\s*=/.test(begin), false, "begin_order_refund must not move money");
});

test("settling a refund twice is a no-op rather than a second payout", () => {
  const settle = migration.slice(
    migration.indexOf("create or replace function public.settle_order_refund"),
    migration.indexOf("create or replace function public.reconcile_stripe_refund")
  );
  assert.match(settle, /if refund_row\.status <> 'pending' then[\s\S]*?'duplicate', true/);
});

test("a settled refund cannot exceed its payment", () => {
  const settle = migration.slice(
    migration.indexOf("create or replace function public.settle_order_refund"),
    migration.indexOf("create or replace function public.reconcile_stripe_refund")
  );
  assert.match(settle, /raise exception 'refund_exceeds_payment'/);
});

test("inventory restoration reads the ledger rather than the order lines", () => {
  // An order that never decremented stock must not be able to invent it on
  // cancellation. Summing what was actually committed makes that structural.
  const restore = migration.slice(
    migration.indexOf("create or replace function public.restore_order_inventory"),
    migration.indexOf("create or replace function public.create_order_return")
  );
  assert.match(restore, /from public\.inventory_adjustments/);
  assert.match(restore, /having sum\(delta\) < 0/);
  assert.equal(/from public\.order_items/.test(restore), false);
});

test("return quantities are validated under a row lock inside the database", () => {
  const create = migration.slice(
    migration.indexOf("create or replace function public.create_order_return"),
    migration.indexOf("create or replace function public.restock_return_items")
  );
  assert.match(create, /from public\.orders where id = p_order_id for update/);
  assert.match(create, /raise exception 'return_quantity_exceeds_purchased'/);
  assert.match(create, /r\.status not in \('denied', 'closed'\)/);
});

test("made-to-order products are skipped rather than driven negative", () => {
  const adjust = migration.slice(
    migration.indexOf("create or replace function public.adjust_product_inventory"),
    migration.indexOf("create or replace function public.commit_order_inventory")
  );
  assert.match(adjust, /inventory_policy <> 'track'/);
  assert.match(adjust, /greatest\(0, product_row\.inventory_quantity \+ p_delta\)/);
});

test("committing inventory keys each movement to its order item", () => {
  const commit = migration.slice(
    migration.indexOf("create or replace function public.commit_order_inventory"),
    migration.indexOf("create or replace function public.restore_order_inventory")
  );
  assert.match(commit, /'-item-' \|\| item\.id::text \|\| '-commit'/);
});

test("the backfill maps existing orders onto the new state columns", () => {
  assert.match(migration, /update public\.orders set fulfillment_status =/);
  assert.match(migration, /when delivered_at is not null and fulfillment_method = 'pickup' then 'picked_up'/);
  assert.match(migration, /cancellation_status = 'completed'/);
});

test("email templates are seeded without overwriting owner edits", () => {
  const insert = migration.slice(migration.indexOf("insert into public.email_templates"));
  assert.match(insert, /on conflict \(key\) do nothing/);
});
