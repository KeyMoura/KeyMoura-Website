import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * The two pass-8 migrations, asserted from their own text.
 *
 * This suite exists to prevent the two failures this repository has actually
 * had:
 *
 * 1. **The pass-5a outage.** `20260804010000` created four tables and issued no
 *    grants. This database's default privileges give a new `public` table only
 *    `Dxtm` — TRUNCATE, REFERENCES, TRIGGER, MAINTAIN — and no SELECT, INSERT,
 *    UPDATE or DELETE for any PostgREST role. Table privileges are checked
 *    *before* row level security, and `service_role`'s BYPASSRLS skips policies
 *    but not grants, so every read died with 42501 before a policy was ever
 *    consulted. The grant tests below derive what must be granted from what the
 *    migration *creates*, so a new table cannot ship ungranted again.
 * 2. **A destructive "additive" migration.** Nothing may drop or truncate an
 *    existing table, column or row.
 */

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

const shipping = read("supabase/migrations/20260805020000_commerce_settings_shipping_fulfillment.sql");
const reservations = read("supabase/migrations/20260805030000_inventory_reservations_and_alerts.sql");
const both = `${shipping}\n${reservations}`.toLowerCase();

const NEW_TABLES = ["order_fulfillment_events", "inventory_reservations", "inventory_alerts"];

const NEW_FUNCTIONS = [
  "transition_order_fulfillment",
  "reserved_product_quantity",
  "available_product_inventory",
  "expire_inventory_reservations",
  "reserve_cart_inventory",
  "link_cart_reservations_to_order",
  "commit_order_reservations",
  "release_inventory_reservations",
  "evaluate_inventory_alert",
  "mark_inventory_alert_notified",
];

/**
 * Statements outside function bodies and comments, roughly. Enough to catch a
 * stray DROP TABLE, and comment-stripped so that *explaining* why TRUNCATE has
 * to be revoked does not read as truncating something.
 */
const statements = both
  .split(/\$\$[\s\S]*?\$\$/g)
  .join(" ")
  .replace(/--[^\n]*/g, " ")
  .split(";");

// ---------------------------------------------------------------------------
// Additive
// ---------------------------------------------------------------------------

test("nothing is dropped, truncated or deleted", () => {
  for (const statement of statements) {
    assert.doesNotMatch(statement, /\bdrop\s+table\b/, `destructive statement: ${statement.trim().slice(0, 120)}`);
    assert.doesNotMatch(statement, /\bdrop\s+column\b/, `destructive statement: ${statement.trim().slice(0, 120)}`);
    assert.doesNotMatch(statement, /\btruncate\b/, `destructive statement: ${statement.trim().slice(0, 120)}`);
    assert.doesNotMatch(statement, /\bdelete\s+from\b/, `destructive statement: ${statement.trim().slice(0, 120)}`);
    assert.doesNotMatch(statement, /\bdrop\s+function\b/, `destructive statement: ${statement.trim().slice(0, 120)}`);
  }
});

test("every new column is nullable or defaulted, so existing rows keep working", () => {
  // `add column ... not null` without a default would fail against a non-empty
  // table, and silently change behaviour if it somehow did not.
  const additions = both.match(/add column if not exists[^,;]+/g) ?? [];
  assert.ok(additions.length > 15, "expected the product and order column additions");
  for (const addition of additions) {
    if (/not null/.test(addition)) {
      assert.match(addition, /default/, `NOT NULL without a default: ${addition.trim().slice(0, 120)}`);
    }
  }
});

test("the only constraints dropped are the ones immediately re-added wider", () => {
  const dropped = [...both.matchAll(/drop constraint if exists (\w+)/g)].map((match) => match[1]);
  for (const name of dropped) {
    assert.match(both, new RegExp(`add constraint ${name}`), `${name} is dropped and never re-added`);
  }
});

test("the fulfillment status CHECK is widened, never narrowed", () => {
  const check = shipping.slice(shipping.indexOf("orders_fulfillment_status_check"));
  // Every pass-7 value must still be legal, or a stored row would start failing.
  for (const value of [
    "not_required", "unfulfilled", "processing", "ready_for_pickup",
    "picked_up", "shipped", "delivered", "returned", "partially_returned",
  ]) {
    assert.match(check.slice(0, 800), new RegExp(`'${value}'`), `${value} was dropped from the CHECK`);
  }
  // Plus the two this pass adds.
  assert.match(check.slice(0, 800), /'ready_to_fulfill'/);
  assert.match(check.slice(0, 800), /'canceled'/);
});

test("the fulfillment method CHECK keeps both existing values", () => {
  const check = shipping.slice(shipping.indexOf("orders_fulfillment_method_check"));
  assert.match(check.slice(0, 400), /'shipping'/);
  assert.match(check.slice(0, 400), /'pickup'/);
  assert.match(check.slice(0, 400), /'none'/);
});

test("no existing commerce table is altered destructively", () => {
  for (const table of ["order_items", "profiles", "carts", "cart_items", "order_refunds", "inventory_adjustments"]) {
    assert.doesNotMatch(
      both,
      new RegExp(`alter table (public\\.)?${table}\\b(?![\\s\\S]{0,40}add column)`),
      `${table} must not be altered`
    );
  }
});

// ---------------------------------------------------------------------------
// Grants — derived from what is created
// ---------------------------------------------------------------------------

test("every table the migrations create is explicitly granted to service_role", () => {
  const created = [...both.matchAll(/create table if not exists public\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...created].sort(), [...NEW_TABLES].sort(), "the expected table list has drifted");
  for (const table of created) {
    assert.match(
      both,
      new RegExp(`grant [^;]*on table public\\.${table} to service_role`),
      `${table} ships without a service_role grant — this is the pass-5a outage`
    );
  }
});

test("every table the migrations create revokes anon, authenticated and public", () => {
  // TRUNCATE is inherited from the default ACL and is **not** filtered by RLS,
  // so a policy does not close it. It has to be revoked.
  for (const table of NEW_TABLES) {
    assert.match(
      both,
      new RegExp(`revoke all on table public\\.${table} from anon, authenticated, public`),
      `${table} leaves anon/authenticated with their inherited privileges`
    );
  }
});

test("no new table grants anything to anon or authenticated", () => {
  for (const match of both.matchAll(/grant [^;]*on table public\.(\w+) to ([^;]+)/g)) {
    if (!NEW_TABLES.includes(match[1])) continue;
    assert.doesNotMatch(match[2], /\banon\b/, `${match[1]} grants to anon`);
    assert.doesNotMatch(match[2], /\bauthenticated\b/, `${match[1]} grants to authenticated`);
    assert.doesNotMatch(match[2], /\bpublic\b/, `${match[1]} grants to public`);
  }
});

test("the fulfillment history and the alert log cannot be rewritten", () => {
  // History that can be edited is not history. Events get select+insert only.
  const grant = both.match(/grant ([^;]*) on table public\.order_fulfillment_events to service_role/);
  assert.ok(grant, "no grant found for order_fulfillment_events");
  assert.match(grant![1], /select/);
  assert.match(grant![1], /insert/);
  assert.doesNotMatch(grant![1], /delete/, "a fulfillment event must not be deletable");
  assert.doesNotMatch(grant![1], /update/, "a fulfillment event must not be editable");
});

test("reservations and alerts are never deletable, so their history survives", () => {
  for (const table of ["inventory_reservations", "inventory_alerts"]) {
    const grant = both.match(new RegExp(`grant ([^;]*) on table public\\.${table} to service_role`));
    assert.ok(grant, `no grant found for ${table}`);
    assert.doesNotMatch(grant![1], /delete/, `${table} rows must be closed by status, not deleted`);
  }
});

test("every function the migrations create is revoked from public and granted to service_role", () => {
  const created = [...both.matchAll(/create or replace function public\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(created)].sort(), [...NEW_FUNCTIONS].sort(), "the expected function list has drifted");
  for (const fn of created) {
    assert.match(both, new RegExp(`revoke all on function[^;]*${fn}`), `${fn} is not revoked from public`);
    assert.match(both, new RegExp(`grant execute on function[^;]*${fn}`), `${fn} has no execute grant`);
  }
});

test("every SECURITY DEFINER function pins its search_path", () => {
  // Without this, a caller-controlled search_path can shadow a table name and
  // run the function's body against something else entirely.
  const definers = [...both.matchAll(/create or replace function public\.(\w+)[\s\S]*?as \$\$/g)];
  for (const match of definers) {
    const header = match[0];
    if (!/security definer/.test(header)) continue;
    assert.match(header, /set search_path\s*=\s*public\s*,\s*pg_temp/, `${match[1]} does not pin search_path`);
  }
});

// ---------------------------------------------------------------------------
// RLS
// ---------------------------------------------------------------------------

test("RLS is enabled on every new table", () => {
  for (const table of NEW_TABLES) {
    assert.match(both, new RegExp(`alter table public\\.${table} enable row level security`), `${table} has no RLS`);
  }
});

test("every policy is staff-gated, and none is granted to anon or public", () => {
  const policies = [...both.matchAll(/create policy "([^"]+)" on public\.(\w+)([\s\S]*?);/g)];
  assert.ok(policies.length >= NEW_TABLES.length, "expected one policy per new table");
  for (const [, name, table, body] of policies) {
    if (!NEW_TABLES.includes(table)) continue;
    assert.match(body, /is_staff_user\(\)/, `policy "${name}" is not staff-gated`);
    assert.doesNotMatch(body, /\bto anon\b/, `policy "${name}" is granted to anon`);
    assert.doesNotMatch(body, /\bto public\b/, `policy "${name}" is granted to public`);
  }
});

test("reservations and alerts are staff-read-only: no customer insert or update policy", () => {
  // A reservation names another customer's cart. There is deliberately no
  // customer-facing read: a shortage is learned from the checkout refusal.
  for (const table of ["inventory_reservations", "inventory_alerts", "order_fulfillment_events"]) {
    const policies = [...both.matchAll(new RegExp(`create policy "([^"]+)" on public\\.${table}\\s+for (\\w+)`, "g"))];
    for (const [, name, verb] of policies) {
      assert.equal(verb, "select", `policy "${name}" on ${table} allows ${verb}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Structural invariants
// ---------------------------------------------------------------------------

test("duplicate holds are prevented by the database, not by remembering to check", () => {
  assert.match(
    reservations,
    /create unique index if not exists inventory_reservations_active_cart_product_idx[\s\S]*?where status = 'active'/,
    "two concurrent requests for the same cart line must collapse to one row"
  );
  assert.match(
    reservations,
    /create unique index if not exists inventory_reservations_active_idempotency_idx[\s\S]*?where status = 'active'/
  );
});

test("one open alert per product is enforced by a partial unique index", () => {
  // This is what stops an alert per page load.
  assert.match(
    reservations,
    /create unique index if not exists inventory_alerts_open_product_idx[\s\S]*?where status = 'open'/
  );
});

test("a reservation cannot claim a terminal status without its timestamp", () => {
  assert.match(reservations, /constraint inventory_reservations_terminal_check/);
  const check = reservations.slice(reservations.indexOf("inventory_reservations_terminal_check"));
  assert.match(check.slice(0, 500), /status = 'committed' and committed_at is not null/);
  assert.match(check.slice(0, 500), /status in \('released','expired'\) and released_at is not null/);
});

test("a reservation always has an expiry", () => {
  assert.match(reservations, /expires_at timestamptz not null/, "a hold that never lapses is an outage");
});

test("availability ignores a lapsed hold even before the sweep runs", () => {
  const fn = reservations.slice(reservations.indexOf("function public.reserved_product_quantity"));
  assert.match(fn.slice(0, 600), /expires_at > now\(\)/);
});

test("the reservation function locks products in a deterministic order", () => {
  // Two carts holding overlapping products must not deadlock each other.
  const fn = reservations.slice(reservations.indexOf("function public.reserve_cart_inventory"));
  assert.match(fn, /order by id\s*\n?\s*for update/);
});

test("shortages are computed before anything is written", () => {
  const fn = reservations.slice(reservations.indexOf("function public.reserve_cart_inventory"));
  const refusal = fn.indexOf("'insufficient_inventory'");
  const firstWrite = fn.indexOf("update public.inventory_reservations");
  assert.ok(refusal > 0 && firstWrite > refusal, "a refusal must leave the cart's existing holds untouched");
});

test("committing a reservation only moves active rows, so a replayed webhook commits none", () => {
  const fn = reservations.slice(reservations.indexOf("function public.commit_order_reservations"));
  assert.match(fn.slice(0, 500), /where order_id = p_order_id and status = 'active'/);
});

test("untracked, made-to-order and backorder products are skipped rather than refused", () => {
  const fn = reservations.slice(reservations.indexOf("function public.reserve_cart_inventory"));
  assert.match(fn, /inventory_policy <> 'track'\s*\n?\s*or product_row\.made_to_order\s*\n?\s*or product_row\.continue_selling_when_out_of_stock/);
});

test("the fulfillment transition re-asserts the from-status in its WHERE clause", () => {
  const fn = shipping.slice(shipping.indexOf("function public.transition_order_fulfillment"));
  assert.match(fn, /where id = p_order_id and fulfillment_status = current_row\.fulfillment_status/);
  assert.match(fn, /'error', 'stale'/);
});

test("email template seeds never overwrite wording the owner has edited", () => {
  for (const insert of both.match(/insert into public\.email_templates[\s\S]*?;/g) ?? []) {
    assert.match(insert, /on conflict \(key\) do nothing/);
  }
});
