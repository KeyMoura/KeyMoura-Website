import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  allReady,
  classifySupabaseError,
  countOrNull,
  failed,
  failuresOf,
  fromSupabase,
  isFailed,
  isPending,
  isReady,
  isTrulyEmpty,
  loading,
  ready,
  rowsOrNull,
} from "../src/lib/staff/loadState.ts";
import {
  ATTENTION_VIEW,
  DEFAULT_PAGE_SIZE,
  FLAGS,
  REQUIRES_ACTION_HREF,
  MAX_PAGE_SIZE,
  PARAM,
  PRODUCTION_STATES,
  SAVED_VIEWS,
  SAVED_VIEW_IDS,
  applyView,
  clearFilter,
  describeActiveFilters,
  emptyFilters,
  hasActiveFilters,
  parseOrderFilters,
  savedView,
  serializeOrderFilters,
  viewHref,
} from "../src/lib/staff/orderFilters.ts";
import {
  REQUIRES_ACTION_CLAUSE,
  buildQueryPlan,
  escapeSearchOperand,
  searchClause,
} from "../src/lib/staff/orderQueryPlan.ts";
import { PRODUCTION_STATUSES } from "../src/lib/production/jobs.ts";
import { fulfillmentBucket, type AttentionKind, type QueueOrder } from "../src/lib/staff/operationsQueues.ts";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/**
 * Source with comments removed.
 *
 * These regression tests assert that a defective *expression* is gone. The
 * comments that explain the defect quote it verbatim on purpose — that record
 * is why the fix survives the next rewrite — so the assertions have to read
 * code, not prose, or documenting a bug becomes indistinguishable from having
 * one.
 */
const readCode = (path: string) =>
  read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
const params = (query: string) => new URLSearchParams(query);

const ORDERS_PAGE = "src/app/staff/orders/page.tsx";
const ORDERS_ROUTE = "src/app/api/staff/orders/route.ts";
const QUEUE_VIEW_SQL = "supabase/migrations/20260806010000_staff_order_queue_view.sql";

// ---------------------------------------------------------------------------
// The result-state primitive
// ---------------------------------------------------------------------------

test("a failed load can never yield a count", () => {
  const failure = failed<string[]>({ message: "nope", kind: "server" });
  assert.equal(countOrNull(failure), null);
  assert.equal(rowsOrNull(failure), null);
  assert.equal(isTrulyEmpty(failure), false);
  assert.equal(isFailed(failure), true);
  assert.equal(isReady(failure), false);
});

test("a pending load is not empty and has no count", () => {
  for (const state of [loading<string[]>(), { status: "idle" } as const]) {
    assert.equal(countOrNull(state as never), null);
    assert.equal(isTrulyEmpty(state as never), false);
    assert.equal(isPending(state as never), true);
  }
});

test("only a successful zero-row load is truly empty", () => {
  const empty = ready<string[]>([]);
  assert.equal(isTrulyEmpty(empty), true);
  assert.equal(countOrNull(empty), 0);
  assert.deepEqual(rowsOrNull(empty), []);
});

test("a successful load reports its real count", () => {
  assert.equal(countOrNull(ready(["a", "b", "c"])), 3);
});

test("fromSupabase turns an error into a failure, not an empty array", () => {
  const state = fromSupabase<{ id: string }>({ data: null, error: { code: "42501", message: "permission denied for table orders" } });
  assert.equal(isFailed(state), true);
  assert.equal(countOrNull(state), null);
});

test("fromSupabase turns a null-data success into a true empty", () => {
  const state = fromSupabase<{ id: string }>({ data: null, error: null });
  assert.equal(isTrulyEmpty(state), true);
});

test("raw provider messages never survive classification", () => {
  // A Postgres error can quote the offending row. `/staff/orders` used to render
  // `orderResult.error.message` straight into the page.
  const leaky = { code: "23505", message: 'duplicate key value violates unique constraint "x" DETAIL: Key (email)=(a@b.com) already exists' };
  const failure = classifySupabaseError(leaky);
  assert.ok(!failure.message.includes("a@b.com"), "classified message must not echo row values");
  assert.ok(!failure.message.includes("duplicate key"), "classified message must not echo the provider string");
});

test("permission failures are classified apart from server faults", () => {
  assert.equal(classifySupabaseError({ code: "42501" }).kind, "permission");
  assert.equal(classifySupabaseError({ code: "PGRST301" }).kind, "permission");
  assert.equal(classifySupabaseError({ code: "42P01" }).kind, "server");
  assert.equal(classifySupabaseError({ code: "08006" }).kind, "unknown");
});

test("a summary over a partly failed set of panels is withheld entirely", () => {
  assert.equal(allReady(ready([1]), failed<number[]>({ message: "x", kind: "server" })), null);
  assert.deepEqual(allReady(ready([1]), ready(["a"])), [[1], ["a"]]);
});

test("failuresOf names exactly the panels that failed", () => {
  const found = failuresOf({
    orders: failed({ message: "orders down", kind: "server" }),
    products: ready([]),
    stock: failed({ message: "stock down", kind: "network" }),
  });
  assert.deepEqual(found.map((f) => f.panel).sort(), ["orders", "stock"]);
});

// ---------------------------------------------------------------------------
// Regression: the exact defect on /staff/orders
// ---------------------------------------------------------------------------

test("REGRESSION the orders page never derives a count from an unchecked array", () => {
  const source = readCode(ORDERS_PAGE);
  // The pre-fix page did `const rows = (orderResult.data ?? []) as Order[]` and
  // then `counts = { action: orders.filter(...).length, ... }`. Either half is
  // enough to reproduce "Needs action (0)" beside an error banner.
  //
  // Scoped to a *result's* `.data`, because `access?.permissions ?? []` is a
  // different and correct thing: an absent permission set genuinely is no
  // permissions, whereas an absent row set is not zero rows.
  assert.ok(!/\.data\s*\?\?\s*\[\]/.test(source), "`result.data ?? []` is how a refused query became a zero");
  assert.ok(!/\.data\s*\|\|\s*\[\]/.test(source), "`result.data || []` has the same effect");
});

test("REGRESSION the orders page does not fetch the orders table directly", () => {
  const source = read(ORDERS_PAGE);
  assert.ok(
    !/\.from\(\s*["']orders["']\s*\)/.test(source),
    "the page must not select from `orders` itself: that shipped every order row to every staff client and filtered in the browser"
  );
  assert.ok(source.includes("/api/staff/orders"), "the page must read the server route");
});

test("REGRESSION a raw provider error message is never rendered", () => {
  const source = read(ORDERS_PAGE);
  assert.ok(
    !/error\?\.message/.test(source),
    "`orderResult.error?.message` was rendered into the page; Postgres messages name schema objects and can quote row values"
  );
});

test("REGRESSION the empty state is gated on a successful load", () => {
  const source = read(ORDERS_PAGE);
  // The pre-fix page rendered `{!loading && shown.length === 0 ? <EmptyState>Nothing in this view.</EmptyState> : null}`
  // which fires on failure too.
  assert.ok(!source.includes("Nothing in this view."), "the old unconditional empty state must be gone");
  assert.ok(
    /payload\.orders\.length === 0/.test(source),
    "the empty state must read the successful payload, not a local array that a failure also empties"
  );
});

test("REGRESSION saved-view counts render only when the server supplied them", () => {
  const source = read(ORDERS_PAGE);
  assert.ok(
    /typeof count === "number"/.test(source),
    "an unknown count must render as nothing; `count ?? 0` or `{count}` would print 0"
  );
});

test("the page distinguishes loading, error and empty as three separate branches", () => {
  const source = read(ORDERS_PAGE);
  assert.ok(/isFailed\(state\)/.test(source), "an explicit failure branch");
  assert.ok(/state\.status === "loading"/.test(source), "an explicit loading branch");
  assert.ok(/role="alert"/.test(source), "the failure is announced as an alert");
});

// ---------------------------------------------------------------------------
// Filter parsing — nothing unvalidated reaches a query
// ---------------------------------------------------------------------------

test("unknown filter values are dropped, never passed through", () => {
  const filters = parseOrderFilters(params("status=requested,not_a_status&payment=bogus"));
  assert.deepEqual(filters.status, ["requested"]);
  assert.deepEqual(filters.payment, []);
});

test("an unknown view is ignored rather than producing an empty list", () => {
  assert.equal(parseOrderFilters(params("view=made_up")).view, null);
});

test("page size is clamped to the enforced maximum", () => {
  assert.equal(parseOrderFilters(params("size=100000")).pageSize, MAX_PAGE_SIZE);
  assert.equal(parseOrderFilters(params("size=-4")).pageSize, 1);
  assert.equal(parseOrderFilters(params("size=abc")).pageSize, DEFAULT_PAGE_SIZE);
});

test("page number is clamped and never negative", () => {
  assert.equal(parseOrderFilters(params("page=0")).page, 1);
  assert.equal(parseOrderFilters(params("page=-9")).page, 1);
});

test("an impossible calendar date is refused rather than silently shifted", () => {
  assert.equal(parseOrderFilters(params("from=2026-02-31")).from, null);
  assert.equal(parseOrderFilters(params("from=not-a-date")).from, null);
  assert.equal(parseOrderFilters(params("from=2026-08-06")).from, "2026-08-06");
});

test("an inverted date range is swapped, not turned into zero results", () => {
  const filters = parseOrderFilters(params("from=2026-08-30&to=2026-08-01"));
  assert.equal(filters.from, "2026-08-01");
  assert.equal(filters.to, "2026-08-30");
});

test("search is length-bounded", () => {
  const long = "x".repeat(500);
  assert.ok(parseOrderFilters(params(`q=${long}`)).search.length <= 120);
});

test("filters round-trip through the query string unchanged", () => {
  const original = parseOrderFilters(params("status=requested,accepted&payment=paid&flag=overdue&q=KM-0001&sort=created_asc&page=3"));
  const roundTripped = parseOrderFilters(params(serializeOrderFilters(original)));
  assert.deepEqual(roundTripped, original);
});

test("serialization is stable, so the back button records one entry per real change", () => {
  const a = parseOrderFilters(params("status=accepted,requested"));
  const b = parseOrderFilters(params("status=requested,accepted"));
  assert.equal(serializeOrderFilters(a), serializeOrderFilters(b));
});

test("defaults are omitted from the query string", () => {
  assert.equal(serializeOrderFilters(emptyFilters()), "");
});

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

test("every saved view has a unique id, a label and a description", () => {
  assert.equal(new Set(SAVED_VIEW_IDS).size, SAVED_VIEWS.length);
  for (const view of SAVED_VIEWS) {
    assert.ok(view.label.trim(), `${view.id} needs a label`);
    assert.ok(view.description.trim().length > 20, `${view.id} needs a description that explains the queue`);
  }
});

test("every view named in the brief exists", () => {
  for (const id of [
    "needs_review", "awaiting_information", "awaiting_payment", "paid_needs_production",
    "in_production", "ready_to_fulfill", "ready_for_pickup", "shipped",
    "cancellation_requests", "return_requests", "refund_failures", "inventory_problems",
    "completed", "canceled",
  ]) {
    assert.ok(savedView(id), `missing saved view: ${id}`);
  }
});

test("a view's preset produces filters that survive serialization", () => {
  for (const view of SAVED_VIEWS) {
    const filters = parseOrderFilters(params(`${PARAM.view}=${view.id}`));
    assert.equal(filters.view, view.id);
    const roundTripped = parseOrderFilters(params(serializeOrderFilters(filters)));
    assert.deepEqual(roundTripped, filters, `${view.id} does not round-trip`);
  }
});

test("an explicit filter beats the view's preset rather than being overwritten", () => {
  // "Needs review" presets status=requested. A staff member who then asks for
  // `accepted` must get `accepted`.
  const filters = applyView({ ...emptyFilters(), view: "needs_review", status: ["accepted"] });
  assert.deepEqual(filters.status, ["accepted"]);
});

test("every attention kind deep-links to a queue that exists", () => {
  // The dashboard counts its attention queue with `attentionQueue()`. A kind
  // with no destination — or one pointing at a view id that was later renamed —
  // is a card that counts work and then cannot show it.
  const kinds: AttentionKind[] = [
    "cancellation", "return", "unfulfilled", "in_transit",
    "quote", "request", "unpaid", "overdue", "tracking",
  ];
  for (const kind of kinds) {
    const viewId = ATTENTION_VIEW[kind];
    assert.ok(viewId, `attention kind "${kind}" has no destination view`);
    assert.ok(savedView(viewId), `attention kind "${kind}" points at "${viewId}", which is not a saved view`);
  }
});

test("the dashboard links to the exact queue it counted, not a general list", () => {
  const source = read("src/app/staff/page.tsx");
  assert.ok(source.includes("REQUIRES_ACTION_HREF"), "the overflow link must open the attention queue");
  assert.ok(
    !/href="\/staff\/orders"/.test(source),
    "a bare /staff/orders link sends the reader to All orders and makes them re-filter by hand"
  );
  // And that href must parse back into the filter it claims to apply.
  assert.deepEqual(parseOrderFilters(params(REQUIRES_ACTION_HREF.split("?")[1])).flags, ["requires_action"]);
});

test("viewHref points at the orders page with a parseable view parameter", () => {
  for (const view of SAVED_VIEWS) {
    const href = viewHref(view.id);
    assert.ok(href.startsWith("/staff/orders?"));
    assert.equal(parseOrderFilters(params(href.split("?")[1])).view, view.id);
  }
});

// ---------------------------------------------------------------------------
// Vocabulary correctness — the class of bug that silently matches nothing
// ---------------------------------------------------------------------------

test("production filter states are the real ones, not invented", () => {
  // The first draft of orderFilters.ts guessed this vocabulary and got nine of
  // thirteen wrong. Every wrong value is a filter that matches nothing, which on
  // screen is indistinguishable from "no orders are in production".
  assert.deepEqual([...PRODUCTION_STATES], [...PRODUCTION_STATUSES]);
  assert.ok(PRODUCTION_STATES.includes("not_started"));
  assert.ok(!(PRODUCTION_STATES as readonly string[]).includes("queued"));
});

test("the view SQL only names columns the orders table actually has", () => {
  const sql = read(QUEUE_VIEW_SQL);
  for (const column of ["fulfillment_status", "cancellation_status", "return_status", "order_kind", "amount_refunded_cents"]) {
    assert.ok(sql.includes(column), `view should project ${column}`);
  }
  assert.ok(!sql.includes("low_stock_alerts"), "pass 9 shipped a route naming a table that does not exist; do not repeat it");
});

// ---------------------------------------------------------------------------
// The view must agree with operationsQueues.ts
// ---------------------------------------------------------------------------

function queueOrder(overrides: Partial<QueueOrder> = {}): QueueOrder {
  return {
    id: "o1", order_number: "KM-0001", customer_id: "c1", product_name: "Part",
    status: "in_progress", quantity: 1, agreed_price_cents: 10_000, amount_paid_cents: 10_000,
    amount_refunded_cents: 0, payment_status: "paid", fulfillment_status: "unfulfilled",
    fulfillment_method: "shipping", cancellation_status: "none", return_status: "none",
    shipping_carrier: null, tracking_number: null, ready_at: null, shipped_at: null,
    delivered_at: null, target_date: null, created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z", ...overrides,
  };
}

/** The SQL CASE from the migration, evaluated in TypeScript. */
function sqlBucket(order: QueueOrder): string {
  const outstanding = Math.max(
    0,
    (order.agreed_price_cents ?? 0) - Math.max(0, order.amount_paid_cents - (order.amount_refunded_cents ?? 0))
  );
  const f = String(order.fulfillment_status);
  if (["canceled", "not_required"].includes(f)) return "not_applicable";
  if (["completed", "declined", "cancelled"].includes(order.status) && !["shipped", "delivered", "picked_up"].includes(f)) return "not_applicable";
  if (["delivered", "picked_up", "returned", "partially_returned"].includes(f)) return "settled";
  if (f === "shipped") return "in_transit";
  if (["ready_to_fulfill", "ready_for_pickup"].includes(f)) return "ready";
  if (outstanding > 0) return "awaiting_payment";
  if (f === "processing") return "in_progress";
  return "to_prepare";
}

test("the view's bucket CASE agrees with fulfillmentBucket on every state", () => {
  const fulfillmentStates = [
    "not_required", "unfulfilled", "processing", "ready_to_fulfill", "ready_for_pickup",
    "picked_up", "shipped", "delivered", "returned", "partially_returned", "canceled",
  ];
  const orderStatuses = ["requested", "in_progress", "ready", "completed", "declined", "cancelled"];
  let checked = 0;
  for (const fulfillment_status of fulfillmentStates) {
    for (const status of orderStatuses) {
      for (const [paid, price] of [[10_000, 10_000], [0, 10_000], [0, 0]] as const) {
        const order = queueOrder({ fulfillment_status, status, amount_paid_cents: paid, agreed_price_cents: price });
        assert.equal(
          sqlBucket(order),
          fulfillmentBucket(order),
          `view SQL and operationsQueues disagree for ${status}/${fulfillment_status}/paid=${paid}`
        );
        checked += 1;
      }
    }
  }
  assert.ok(checked >= 198, `expected an exhaustive sweep, checked ${checked}`);
});

// ---------------------------------------------------------------------------
// Query plan
// ---------------------------------------------------------------------------

test("no filter produces no predicates", () => {
  assert.deepEqual(buildQueryPlan(emptyFilters()).predicates, []);
});

test("paging maps to a zero-based inclusive range", () => {
  assert.deepEqual(buildQueryPlan({ ...emptyFilters(), page: 1, pageSize: 25 }).range, { from: 0, to: 24 });
  assert.deepEqual(buildQueryPlan({ ...emptyFilters(), page: 3, pageSize: 10 }).range, { from: 20, to: 29 });
});

test("every sort carries a stable tiebreak so rows cannot swap between pages", () => {
  for (const sort of ["updated_desc", "created_desc", "created_asc", "priority", "target_date", "price_desc"] as const) {
    const order = buildQueryPlan({ ...emptyFilters(), sort }).order;
    assert.equal(order.at(-1)?.column, "id", `${sort} has no tiebreak`);
  }
});

test("priority sorts by rank, not by the alphabetical word order", () => {
  const order = buildQueryPlan({ ...emptyFilters(), sort: "priority" }).order;
  assert.equal(order[0].column, "priority_rank");
  assert.equal(order[0].ascending, true);
});

test("the unassigned flag is an IS NULL, not a comparison against empty text", () => {
  const plan = buildQueryPlan({ ...emptyFilters(), flags: ["unassigned"] });
  assert.deepEqual(plan.predicates, [{ op: "is", column: "assigned_to", value: null }]);
});

/**
 * Split a PostgREST `or` clause on its top-level commas only.
 *
 * `fulfillment_bucket.in.(to_prepare,in_progress,ready)` contains commas that
 * belong to the value list, not to the clause list — splitting naively is how a
 * value gets read as a column name.
 */
function topLevelClauses(clause: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of clause) {
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) out.push(current);
  return out;
}

test("each derived flag maps to a column the view actually provides", () => {
  const sql = read(QUEUE_VIEW_SQL);
  for (const flag of FLAGS) {
    const plan = buildQueryPlan({ ...emptyFilters(), flags: [flag] });
    assert.equal(plan.predicates.length, 1, `${flag} should add exactly one predicate`);
    const predicate = plan.predicates[0];
    if (predicate.op === "or") {
      for (const column of topLevelClauses(predicate.clause).map((part) => part.split(".")[0])) {
        assert.ok(sql.includes(column), `requires_action references ${column}, which the view does not project`);
      }
    } else {
      assert.ok(sql.includes(predicate.column), `${flag} references ${predicate.column}, which the view does not project`);
    }
  }
});

test("the date range covers the whole of the closing day", () => {
  const plan = buildQueryPlan({ ...emptyFilters(), from: "2026-08-01", to: "2026-08-06" });
  const lte = plan.predicates.find((p) => p.op === "lte");
  assert.ok(lte && "value" in lte && String(lte.value).includes("23:59:59"), "an inclusive `to` must not cut the day short");
});

test("requires_action only references derived boolean columns", () => {
  for (const clause of topLevelClauses(REQUIRES_ACTION_CLAUSE)) {
    assert.ok(/^[a-z_]+\.(is|in)\./.test(clause), `unexpected clause shape: ${clause}`);
  }
});

// ---------------------------------------------------------------------------
// Search escaping
// ---------------------------------------------------------------------------

test("search text cannot reshape the PostgREST or() expression", () => {
  // `or=(a.ilike.x,b.ilike.y)` is parsed positionally, so an unescaped comma or
  // parenthesis in the search box rewrites the filter into one the UI never
  // offered.
  const hostile = `a,b).or(status.eq.completed`;
  const operand = escapeSearchOperand(hostile);
  assert.ok(operand.startsWith('"') && operand.endsWith('"'), "the operand must be quoted");
  const clause = searchClause(hostile);
  // Exactly two clauses survive: one per searched column.
  assert.equal(clause.split(".ilike.").length - 1, 2);
});

test("ilike wildcards in the search box are literal", () => {
  assert.ok(escapeSearchOperand("100%").includes("\\%"), "a percent sign must not match everything");
  assert.ok(escapeSearchOperand("a_b").includes("\\_"), "an underscore must not match any character");
});

test("a quote cannot close the quoted operand early", () => {
  const operand = escapeSearchOperand('x"y');
  assert.equal(operand.match(/(?<!\\)"/g)?.length, 2, "only the wrapping quotes may be unescaped");
});

// ---------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------

test("the route refuses callers without an orders permission", () => {
  const source = read(ORDERS_ROUTE);
  assert.ok(/requireAnyPermission\(req, \["orders\.view", "orders\.manage"\]\)/.test(source));
  assert.ok(/status: 403/.test(source));
});

test("a failed list is an error status, never a 200 with an empty array", () => {
  const source = read(ORDERS_ROUTE);
  assert.ok(/status: 502/.test(source), "a query failure must not be reported as a successful empty result");
  assert.ok(
    !/orders:\s*\[\]/.test(source),
    "the route must never answer with an empty orders array as a stand-in for a failure"
  );
});

test("counts are withheld as a whole when any count fails", () => {
  const source = read(ORDERS_ROUTE);
  assert.ok(/counts = countFailure\s*\?\s*null/.test(source), "a partial count strip invites reading the gap as zero");
});

test("the route logs no customer-identifying data on failure", () => {
  const source = read(ORDERS_ROUTE);
  const logBlock = source.slice(source.indexOf("function logQueryFailure"), source.indexOf("const newReference"));
  for (const forbidden of ["details", "filters.", "customer_id", "orderId", "order_number", "search"]) {
    assert.ok(!logBlock.includes(forbidden), `failure logs must not carry ${forbidden}`);
  }
  assert.ok(logBlock.includes("code"), "SQLSTATE is what makes a log actionable");
  // The logger takes a pre-stripped shape rather than the filters themselves,
  // so it has no access to the search text even by accident.
  assert.ok(/logQueryFailure\([^)]*shape: QueryShape/.test(source), "the logger must not receive the filters");
});

test("the list selects named columns rather than everything", () => {
  const source = read(ORDERS_ROUTE);
  assert.ok(!/\.select\("\*"/.test(source), "`select(\"*\")` exposes any column later added to the view");
  assert.ok(/LIST_COLUMNS/.test(source));
});

test("the list never exposes customer email or address to the queue", () => {
  const source = read(ORDERS_ROUTE);
  for (const field of ["email", "shipping_address", "customer_notes", "staff_notes"]) {
    assert.ok(!source.includes(`"${field}"`), `a list view must not carry ${field}`);
  }
});

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

test("the queue view is granted to service_role only", () => {
  const sql = read(QUEUE_VIEW_SQL);
  assert.ok(/grant select on public\.staff_order_queue to service_role/.test(sql));
  assert.ok(/revoke all on public\.staff_order_queue from anon/.test(sql));
  assert.ok(/revoke all on public\.staff_order_queue from authenticated/.test(sql));
  assert.ok(/revoke all on public\.staff_order_queue from public/.test(sql));
  assert.ok(
    !/grant .* to (anon|authenticated)/.test(sql),
    "no grant to anon or authenticated: an order row carries customer identifiers and money"
  );
});

test("the migration is additive", () => {
  const sql = read(QUEUE_VIEW_SQL);
  for (const destructive of ["drop table", "drop column", "delete from", "truncate", "alter table"]) {
    assert.ok(!sql.toLowerCase().includes(destructive), `migration must be additive; found "${destructive}"`);
  }
});

test("the view runs with the caller's rights on the base table", () => {
  assert.ok(/security_invoker\s*=\s*true/.test(read(QUEUE_VIEW_SQL)), "a definer view would bypass RLS on orders");
});

// ---------------------------------------------------------------------------
// Active-filter description
// ---------------------------------------------------------------------------

test("active filters are describable and individually clearable", () => {
  const filters = parseOrderFilters(params("status=requested&payment=paid&q=KM-0001"));
  const active = describeActiveFilters(filters);
  assert.equal(active.length, 3);
  const cleared = clearFilter(filters, "search");
  assert.equal(cleared.search, "");
  assert.deepEqual(cleared.status, ["requested"], "clearing one filter must not clear the others");
});

test("clearing a filter drops the view label, which no longer describes the list", () => {
  const filters = parseOrderFilters(params("view=needs_review"));
  assert.equal(clearFilter(filters, "status").view, null);
});

test("hasActiveFilters is false only for a genuinely unfiltered list", () => {
  assert.equal(hasActiveFilters(emptyFilters()), false);
  assert.equal(hasActiveFilters(parseOrderFilters(params("q=abc"))), true);
  assert.equal(hasActiveFilters(parseOrderFilters(params("view=shipped"))), true);
});

test("the assignee filter never reaches the description as a raw id", () => {
  const active = describeActiveFilters(parseOrderFilters(params("assignee=11111111-2222-3333-4444-555555555555")));
  const assignee = active.find((f) => f.key === "assignedTo");
  assert.ok(assignee && !assignee.value.includes("1111"), "a user id must not be printed into the filter chips");
});
