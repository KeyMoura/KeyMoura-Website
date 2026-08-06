import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  SAVED_VIEWS,
  applyView,
  emptyFilters,
  parseOrderFilters,
  savedView,
  type OrderFilters,
} from "@/lib/staff/orderFilters";
import { buildQueryPlan, searchClause, type Predicate } from "@/lib/staff/orderQueryPlan";

/**
 * The staff order queue — server-authoritative filtering, sorting, paging and
 * counting.
 *
 * ## Why this route exists
 *
 * `/staff/orders` used to `select(...)` every order straight from the browser
 * with no limit, filter it in JavaScript, and derive its tab counts from the
 * result. Three consequences, all of them real:
 *
 * 1. A refused query produced `[]`, and every count rendered a confident `0`
 *    beside the error banner. This is the defect this pass opens with.
 * 2. Every staff client received every order row — product names, prices,
 *    customer ids, payment state — regardless of which twenty-five it showed.
 * 3. It does not scale past a few hundred orders.
 *
 * Filtering here fixes all three at once: the browser receives one page, the
 * counts come from the database, and a failure is an HTTP status rather than an
 * empty array that looks like success.
 *
 * ## What is *not* trusted from the client
 *
 * Every filter value is validated against a vocabulary in `orderFilters.ts`
 * before it reaches a query. Unknown values are dropped rather than passed
 * through. The free-text search is escaped for PostgREST's `or` grammar. There
 * is no parameter that selects columns, names a table, or sets a limit beyond
 * the enforced maximum.
 */

export const dynamic = "force-dynamic";

/** Columns the list needs. Explicit, so a new column on the view is not silently exposed. */
const LIST_COLUMNS = [
  "id", "order_number", "customer_id", "product_name", "status", "order_kind",
  "quantity", "agreed_price_cents", "payment_status", "fulfillment_status",
  "fulfillment_method", "cancellation_status", "return_status", "outstanding_cents",
  "fulfillment_bucket", "missing_tracking", "is_overdue", "has_failed_refund",
  "has_inventory_issue", "cancellation_open", "return_open", "production_status",
  "priority", "priority_rank", "assigned_to", "target_date", "created_at", "updated_at",
].join(",");

/** Apply a plan's predicates to a PostgREST query. The only place a predicate becomes a call. */
function applyPredicates<T>(query: T, predicates: readonly Predicate[]): T {
  let q = query as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const predicate of predicates) {
    if (predicate.op === "in") q = q.in(predicate.column, predicate.values) as typeof q;
    else if (predicate.op === "eq") q = q.eq(predicate.column, predicate.value) as typeof q;
    else if (predicate.op === "gte") q = q.gte(predicate.column, predicate.value) as typeof q;
    else if (predicate.op === "lte") q = q.lte(predicate.column, predicate.value) as typeof q;
    else if (predicate.op === "is") q = q.is(predicate.column, null) as typeof q;
    else if (predicate.op === "or") q = q.or(predicate.clause) as typeof q;
  }
  return q as unknown as T;
}

/**
 * The shape of a request, with every value stripped out.
 *
 * Built *before* logging and passed as a finished object, so the logger below
 * has no access to the filters at all. That is deliberate: a logger that merely
 * promises not to read `filters.search` is one edit away from reading it, and
 * the search box is where a staff member types a customer's name.
 */
type QueryShape = {
  view: string | null;
  counts: Record<string, number>;
  hasSearch: boolean;
  hasRange: boolean;
  page: number;
  pageSize: number;
};

function describeShape(filters: OrderFilters): QueryShape {
  return {
    view: filters.view,
    counts: {
      status: filters.status.length,
      payment: filters.payment.length,
      fulfillment: filters.fulfillment.length,
      flags: filters.flags.length,
    },
    hasSearch: filters.search.length > 0,
    hasRange: Boolean(filters.from || filters.to),
    page: filters.page,
    pageSize: filters.pageSize,
  };
}

/**
 * Log a failure with enough to diagnose it and nothing that identifies a person.
 *
 * SQLSTATE, the operation and the query *shape*. Never `details` — the one
 * Postgres field that echoes row values back, which on this schema can be a
 * customer's address or an internal note. Never a search string, an order id or
 * a customer id.
 */
function logQueryFailure(operation: string, error: unknown, shape: QueryShape, reference: string) {
  const pgError = error as { code?: string; message?: string; hint?: string } | null;
  console.error("[staff-orders]", {
    operation,
    reference,
    code: pgError?.code ?? null,
    message: pgError?.message?.slice(0, 400) ?? null,
    hint: pgError?.hint?.slice(0, 200) ?? null,
    ...shape,
  });
}

/** A short token the staff member can quote and a developer can grep the logs for. */
const newReference = () => Math.random().toString(36).slice(2, 10);

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["orders.view", "orders.manage"]);
  if (!actor) return NextResponse.json({ error: "Not authorized" }, { status: 403 });

  const url = new URL(req.url);
  const filters = parseOrderFilters(url.searchParams);
  const plan = buildQueryPlan(filters);

  /*
   * Free-text search resolves customer ids first.
   *
   * PostgREST cannot `ilike` across an embedded resource in the same `or` as
   * columns on the parent, so matching a customer name means resolving profiles
   * to ids and adding those ids to the clause. Bounded at 50: a one-character
   * search must not turn into an unbounded id list in a URL.
   *
   * The failure here is deliberately *not* fatal — if profiles cannot be read,
   * searching by order number and product still works, and the response says so
   * rather than silently returning fewer matches than exist.
   */
  let customerIds: string[] = [];
  let searchDegraded = false;
  if (plan.needsCustomerSearch) {
    const escaped = plan.search.replace(/[\\%_]/g, (c) => `\\${c}`);
    const profileResult = await routeServiceClient
      .from("profiles")
      .select("id")
      .or(`username.ilike."*${escaped}*",display_name.ilike."*${escaped}*"`)
      .limit(50);
    if (profileResult.error) searchDegraded = true;
    else customerIds = (profileResult.data ?? []).map((row) => String((row as { id: string }).id));
  }

  const searchPredicates: Predicate[] = [];
  if (plan.needsCustomerSearch) {
    const clauses = [searchClause(plan.search)];
    if (customerIds.length) clauses.push(`customer_id.in.(${customerIds.join(",")})`);
    searchPredicates.push({ op: "or", clause: clauses.join(",") });
  }
  const allPredicates = [...plan.predicates, ...searchPredicates];

  // The page and its exact total, in one round trip.
  let listQuery = routeServiceClient
    .from("staff_order_queue")
    .select(LIST_COLUMNS, { count: "exact" });
  listQuery = applyPredicates(listQuery, allPredicates);
  for (const sort of plan.order) {
    listQuery = listQuery.order(sort.column, { ascending: sort.ascending, nullsFirst: sort.nullsFirst });
  }
  const listResult = await listQuery.range(plan.range.from, plan.range.to);

  if (listResult.error) {
    const reference = newReference();
    logQueryFailure("list", listResult.error, describeShape(filters), reference);
    // 502, not 200-with-an-empty-array. The client cannot mistake this for
    // "no orders matched", which is the entire point of the change.
    return NextResponse.json(
      {
        error: "The order list could not be loaded.",
        reference,
        kind: String((listResult.error as { code?: string }).code ?? "") === "42501" ? "permission" : "server",
      },
      { status: 502 }
    );
  }

  const rows = (listResult.data ?? []) as unknown as Record<string, unknown>[];

  /*
   * Customer display names for exactly the rows on this page.
   *
   * One batched query for the page, not one per row, and only the fields a list
   * needs to identify an order: a display name and a username. No email, no
   * address, no order history. A staff member scanning a queue does not need a
   * customer's contact details, and a list view is the widest-read surface in
   * the staff area.
   */
  const pageCustomerIds = [...new Set(rows.map((row) => String(row.customer_id)).filter(Boolean))];
  let profiles: Record<string, { display_name: string | null; username: string | null }> = {};
  let profilesDegraded = false;
  if (pageCustomerIds.length) {
    const result = await routeServiceClient
      .from("profiles")
      .select("id,username,display_name")
      .in("id", pageCustomerIds);
    if (result.error) profilesDegraded = true;
    else {
      profiles = Object.fromEntries(
        (result.data ?? []).map((row) => {
          const profile = row as { id: string; username: string | null; display_name: string | null };
          return [profile.id, { display_name: profile.display_name, username: profile.username }];
        })
      );
    }
  }

  /*
   * Counts for the saved views.
   *
   * A fixed number of `head`-only count queries — one per view — run in
   * parallel. Fixed, so this is not an N+1: it does not grow with the number of
   * orders. Each is filtered by the *same* plan builder the list uses, so a tab
   * reading 3 opens a list containing exactly those 3.
   *
   * If any single count fails, `counts` is withheld **entirely** rather than
   * returned with holes. A tab strip where one number is missing and the rest
   * are present invites reading the missing one as zero.
   */
  const countResults = await Promise.all(
    SAVED_VIEWS.map(async (view) => {
      const viewFilters = applyView({ ...emptyFilters(), view: view.id });
      const viewPlan = buildQueryPlan(viewFilters);
      let countQuery = routeServiceClient
        .from("staff_order_queue")
        .select("id", { count: "exact", head: true });
      countQuery = applyPredicates(countQuery, viewPlan.predicates);
      const result = await countQuery;
      return { id: view.id, count: result.count ?? 0, error: result.error };
    })
  );
  const countFailure = countResults.find((result) => result.error);
  if (countFailure) logQueryFailure("counts", countFailure.error, describeShape(filters), newReference());
  const counts = countFailure
    ? null
    : Object.fromEntries(countResults.map((result) => [result.id, result.count]));

  const total = listResult.count ?? 0;
  return NextResponse.json({
    orders: rows.map((row) => ({
      ...row,
      customer: profiles[String(row.customer_id)] ?? null,
    })),
    page: filters.page,
    pageSize: filters.pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / Math.max(1, filters.pageSize))),
    counts,
    view: savedView(filters.view),
    /*
     * Degradations are reported, not hidden. A page that quietly dropped
     * customer-name matching from a search is a page that shows fewer results
     * than exist and calls it a complete answer.
     */
    degraded: {
      customerSearch: searchDegraded,
      customerNames: profilesDegraded,
      counts: Boolean(countFailure),
    },
  });
}
