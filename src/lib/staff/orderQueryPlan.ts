/**
 * Translating `OrderFilters` into database predicates.
 *
 * Separated from the route so the translation is **unit-testable without a
 * database**. A Supabase query builder is a chain of side effects; a plan is a
 * value, and a value can be asserted against.
 *
 * The security property this file carries: every column name and every operand
 * below is a literal from this module or a value already validated against a
 * vocabulary in `orderFilters.ts`. **No caller string is ever interpolated into
 * a column name or an operator.** The only caller strings that survive are the
 * free-text search and the assignee id, and both are handled explicitly.
 */

import {
  type OrderFilters,
  type OrderSort,
} from "./orderFilters.ts";

/** One predicate against `staff_order_queue`. */
export type Predicate =
  | { op: "in"; column: string; values: readonly string[] }
  | { op: "eq"; column: string; value: string | number | boolean }
  | { op: "gte"; column: string; value: string }
  | { op: "lte"; column: string; value: string }
  | { op: "is"; column: string; value: null }
  | { op: "or"; clause: string };

export type QueryPlan = {
  predicates: Predicate[];
  order: { column: string; ascending: boolean; nullsFirst?: boolean }[];
  /** Zero-based inclusive range, the shape PostgREST's `.range()` takes. */
  range: { from: number; to: number };
  /** True when the caller supplied free text that has to match a customer too. */
  needsCustomerSearch: boolean;
  search: string;
};

/**
 * `requires_action` as one PostgREST `or` clause.
 *
 * A constant, never built from input. It mirrors the kinds in `attentionQueue`
 * that are expressible as row predicates: open cancellations, open returns,
 * shipped-without-tracking, new requests, accepted-but-unpriced, overdue, and
 * work sitting in a live fulfillment bucket.
 *
 * `fulfillment_bucket` is a derived column on the view, which is the whole
 * reason the view exists — in a plain `orders` query this predicate cannot be
 * written, because the bucket depends on a comparison between money columns.
 */
export const REQUIRES_ACTION_CLAUSE = [
  "cancellation_open.is.true",
  "return_open.is.true",
  "missing_tracking.is.true",
  "is_overdue.is.true",
  "has_failed_refund.is.true",
  "has_inventory_issue.is.true",
  "fulfillment_bucket.in.(to_prepare,in_progress,ready)",
].join(",");

const SORTS: Readonly<Record<OrderSort, { column: string; ascending: boolean; nullsFirst?: boolean }[]>> = {
  updated_desc: [{ column: "updated_at", ascending: false }],
  created_desc: [{ column: "created_at", ascending: false }],
  created_asc: [{ column: "created_at", ascending: true }],
  // `priority_rank`, not `priority`. Postgres sorts the words, which orders
  // them "high, low, normal, urgent" — alphabetical and meaningless. The view
  // carries the rank so urgent genuinely sorts first.
  priority: [
    { column: "priority_rank", ascending: true },
    { column: "updated_at", ascending: false },
  ],
  // Nulls last: an order with no target date is not "due first".
  target_date: [
    { column: "target_date", ascending: true, nullsFirst: false },
    { column: "updated_at", ascending: false },
  ],
  price_desc: [
    { column: "agreed_price_cents", ascending: false, nullsFirst: false },
    { column: "updated_at", ascending: false },
  ],
};

/** A stable tiebreak so two rows sharing a sort key cannot swap between pages. */
const TIEBREAK = { column: "id", ascending: false } as const;

export function buildQueryPlan(filters: OrderFilters): QueryPlan {
  const predicates: Predicate[] = [];
  const inFilter = (column: string, values: readonly string[]) => {
    if (values.length) predicates.push({ op: "in", column, values });
  };

  inFilter("status", filters.status);
  inFilter("payment_status", filters.payment);
  inFilter("fulfillment_status", filters.fulfillment);
  inFilter("fulfillment_method", filters.method);
  inFilter("cancellation_status", filters.cancellation);
  inFilter("return_status", filters.returns);
  inFilter("production_status", filters.production);
  inFilter("order_kind", filters.kind);
  inFilter("priority", filters.priority);

  for (const flag of filters.flags) {
    if (flag === "requires_action") predicates.push({ op: "or", clause: REQUIRES_ACTION_CLAUSE });
    if (flag === "overdue") predicates.push({ op: "eq", column: "is_overdue", value: true });
    if (flag === "refund_failed") predicates.push({ op: "eq", column: "has_failed_refund", value: true });
    if (flag === "inventory_issue") predicates.push({ op: "eq", column: "has_inventory_issue", value: true });
    // IS NULL, not `= ''`. `assigned_to` is a uuid column: comparing it to an
    // empty string is a type error at the database, not an "unassigned" filter.
    if (flag === "unassigned") predicates.push({ op: "is", column: "assigned_to", value: null });
  }

  if (filters.assignedTo) predicates.push({ op: "eq", column: "assigned_to", value: filters.assignedTo });
  // `to` is inclusive of the whole day: a staff member picking 6 August means
  // orders placed on 6 August, not orders placed before midnight starting it.
  if (filters.from) predicates.push({ op: "gte", column: "created_at", value: `${filters.from}T00:00:00.000Z` });
  if (filters.to) predicates.push({ op: "lte", column: "created_at", value: `${filters.to}T23:59:59.999Z` });

  const page = Math.max(1, filters.page);
  const size = Math.max(1, filters.pageSize);
  const from = (page - 1) * size;

  return {
    predicates,
    order: [...SORTS[filters.sort], TIEBREAK],
    range: { from, to: from + size - 1 },
    needsCustomerSearch: filters.search.length > 0,
    search: filters.search,
  };
}

/**
 * Escape free text for a PostgREST `or(...)` clause.
 *
 * PostgREST parses `or=(a.ilike.x,b.ilike.y)` positionally, so a comma, a
 * parenthesis or a dot in the search box would otherwise re-shape the filter
 * expression into one the UI never offered — the injection this list closes.
 * Wrapping the operand in double quotes makes commas and parentheses literal;
 * backslashes and quotes are escaped so the quoting cannot be closed early.
 *
 * `%` and `_` are additionally neutralised because they are `ilike` wildcards:
 * searching for `%` should look for a percent sign, not match every order.
 */
export function escapeSearchOperand(raw: string): string {
  const escaped = raw
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
  return `"*${escaped}*"`;
}

/** The `or` clause matching an order by number or product name. */
export function searchClause(raw: string): string {
  const operand = escapeSearchOperand(raw);
  return `order_number.ilike.${operand},product_name.ilike.${operand}`;
}
