import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import {
  DELIVERY_PAGE_SIZE,
  parseDeliveryFilters,
  toDeliveryView,
  type DeliveryRow,
} from "@/lib/comms/deliveryCenter";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/comms/emailEvents";

/**
 * The email delivery history.
 *
 * Behind `emails.view` or `emails.resend` — reading the list is a prerequisite
 * for the resend action, and a holder of `emails.resend` who could not see what
 * they were re-sending would be pressing a button blind. `emails.manage`, which
 * edits template wording, deliberately does **not** open this: those are
 * different powers over different data, and the delivery list carries recipient
 * addresses where the template editor carries none.
 *
 * Three properties the route owns rather than the page:
 *
 *   1. **A failed query is a 502**, never a 200 with an empty array. `[]` and
 *      "the database refused" render identically otherwise, and the page would
 *      say "no emails have been sent".
 *   2. **The count comes from the same query as the rows**, in one round trip,
 *      so a list of 25 can never sit under a total that disagrees with it.
 *   3. **Free text never touches the recipient column.** Searching by address
 *      would turn this page into a way to confirm whether a given person is a
 *      customer, which is a different capability from reviewing sends.
 */

// PostgREST's `or()` grammar uses these as separators. Left in, a search box
// becomes a filter injection point.
const escapeForOr = (value: string) => value.replace(/[,()\\]/g, " ").trim();

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["emails.view", "emails.resend"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const filters = parseDeliveryFilters(req.nextUrl.searchParams, EMAIL_TEMPLATE_KEYS);

  let query = routeServiceClient
    .from("email_deliveries")
    .select(
      "id,order_id,template_key,recipient,subject,status,failure_category,audience,attempt_count,delivered_at,resend_of_id,created_at,updated_at",
      { count: "exact" }
    )
    .order("created_at", { ascending: false })
    .range((filters.page - 1) * DELIVERY_PAGE_SIZE, filters.page * DELIVERY_PAGE_SIZE - 1);

  if (filters.status.length) query = query.in("status", filters.status);
  if (filters.templateKey.length) query = query.in("template_key", filters.templateKey);
  if (filters.audience.length) query = query.in("audience", filters.audience);
  if (filters.from) query = query.gte("created_at", `${filters.from}T00:00:00.000Z`);
  // Inclusive of the whole end day: a staff member filtering "to 6 August"
  // means the sixth, not midnight at its start.
  if (filters.to) query = query.lte("created_at", `${filters.to}T23:59:59.999Z`);

  // Search resolves order numbers to ids first, then filters on the id. The
  // alternative — a join filter — would let the search string reach a column it
  // has no business matching.
  let orderIdFilter: string[] | null = null;
  if (filters.search) {
    const term = escapeForOr(filters.search);
    if (term) {
      const { data: matches } = await routeServiceClient
        .from("orders")
        .select("id")
        .ilike("order_number", `%${term.replace(/[%_]/g, "")}%`)
        .limit(200);
      orderIdFilter = (matches ?? []).map((row) => String(row.id));
      // A search that matched no order must return nothing, not everything.
      query = orderIdFilter.length ? query.in("order_id", orderIdFilter) : query.eq("id", NO_MATCH);
    }
  }

  const { data, error, count } = await query;
  if (error) {
    console.error("email deliveries load failed", { code: error.code, hint: error.hint });
    return NextResponse.json({ error: "Delivery history could not be loaded." }, { status: 502 });
  }

  const rows = (data ?? []) as DeliveryRow[];
  const orderIds = [...new Set(rows.map((row) => row.order_id).filter((id): id is string => Boolean(id)))];
  const [orderNumbers, templateNames] = await Promise.all([
    loadOrderNumbers(orderIds),
    loadTemplateNames(),
  ]);

  return NextResponse.json({
    deliveries: rows.map((row) => toDeliveryView(row, { orderNumbers, templateNames })),
    total: count ?? 0,
    page: filters.page,
    pageSize: DELIVERY_PAGE_SIZE,
    canResend: actor.permissions.has("emails.resend"),
  });
}

/** A uuid that cannot exist, used to force an empty result set without a second code path. */
const NO_MATCH = "00000000-0000-0000-0000-000000000000";

async function loadOrderNumbers(ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const { data } = await routeServiceClient.from("orders").select("id,order_number").in("id", ids);
  return Object.fromEntries(
    (data ?? []).map((row) => [String(row.id), String(row.order_number ?? "")]).filter(([, number]) => number)
  );
}

async function loadTemplateNames(): Promise<Record<string, string>> {
  const { data } = await routeServiceClient.from("email_templates").select("key,name");
  return Object.fromEntries((data ?? []).map((row) => [String(row.key), String(row.name)]));
}
