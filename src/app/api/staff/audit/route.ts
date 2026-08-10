import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { actionsForArea, describeAction } from "@/lib/audit/actions";
import { renderChanges, summarizeChanges, type ChangeSet } from "@/lib/audit/diff";
import { parseAuditFilters } from "@/lib/audit/query";

/**
 * The audit log, read server-side.
 *
 * Filtering, searching and paging all happen in Postgres. The alternative —
 * fetching rows and filtering them in the browser — is what the previous audit
 * page did, and it does not survive a table that grows by a row per staff
 * action forever. There is no endpoint here that returns the whole log.
 *
 * Reading the audit log is deliberately **not** itself audited. A read is not a
 * mutation, and an audit log that records its own inspection grows faster from
 * being looked at than from anything happening.
 */

export const runtime = "nodejs";

const SELECT_COLUMNS =
  "id,occurred_at,created_at,actor_user_id,actor_kind,actor_label,actor_role,event_type," +
  "entity_type,entity_id,entity_label,related_order_id,related_production_job_id,related_product_id," +
  "changes,summary,metadata,source,correlation_id";

type AuditRow = {
  id: string;
  occurred_at: string;
  created_at: string;
  actor_user_id: string | null;
  actor_kind: string | null;
  actor_label: string | null;
  actor_role: string | null;
  event_type: string;
  entity_type: string | null;
  entity_id: string | null;
  entity_label: string | null;
  related_order_id: string | null;
  related_production_job_id: string | null;
  related_product_id: string | null;
  changes: ChangeSet | null;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  source: string | null;
  correlation_id: string | null;
};

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["audit.view", "audit.read"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const filters = parseAuditFilters(url.searchParams);

  // One extra row is fetched to answer "is there another page" without a second
  // count query over a table nobody wants to count.
  let query = routeServiceClient
    .from("audit_logs")
    .select(SELECT_COLUMNS)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(filters.pageSize + 1);

  if (filters.actor === "system") {
    query = query.is("actor_user_id", null);
  } else if (filters.actor) {
    query = query.eq("actor_user_id", filters.actor);
  }

  if (filters.action) {
    query = query.eq("event_type", filters.action);
  } else if (filters.area) {
    /*
     * Area is a property of the action taxonomy, not a column.
     *
     * Rather than denormalize an `area` column that would need backfilling
     * every time an action is reclassified, the area filter expands to the list
     * of actions in that area. `describeAction` is the single source of that
     * mapping, so the filter cannot drift from the label shown on the row.
     */
    const actions = actionsForArea(filters.area);
    if (actions.length) query = query.in("event_type", actions);
    else return NextResponse.json({ events: [], nextCursor: null, hasMore: false });
  }

  if (filters.from) query = query.gte("occurred_at", `${filters.from}T00:00:00.000Z`);
  if (filters.to) query = query.lte("occurred_at", `${filters.to}T23:59:59.999Z`);

  if (filters.orderId) query = query.eq("related_order_id", filters.orderId);
  if (filters.productionJobId) query = query.eq("related_production_job_id", filters.productionJobId);
  if (filters.productId) query = query.eq("related_product_id", filters.productId);

  if (filters.search) {
    // Escaped so a comma or parenthesis in the search box cannot break out of
    // the `or` expression and become extra filter syntax.
    const term = filters.search.replace(/[(),*\\]/g, " ").trim();
    if (term) {
      const pattern = `%${term}%`;
      query = query.or(
        [
          `entity_label.ilike.${pattern}`,
          `summary.ilike.${pattern}`,
          `actor_label.ilike.${pattern}`,
          `event_type.ilike.${pattern}`,
        ].join(",")
      );
    }
  }

  // Keyset paging. `occurred_at` is not unique, so ties are broken by id in the
  // same direction as the sort; without it a page boundary landing inside a
  // burst of same-timestamp events silently drops rows.
  if (filters.cursor) query = query.lt("occurred_at", filters.cursor);

  const { data, error } = await query;

  if (error) {
    console.error("[audit] list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load the audit log." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as AuditRow[];
  const hasMore = rows.length > filters.pageSize;
  const page = hasMore ? rows.slice(0, filters.pageSize) : rows;

  return NextResponse.json({
    events: page.map(toView),
    nextCursor: hasMore ? page[page.length - 1]?.occurred_at ?? null : null,
    hasMore,
  });
}

/**
 * One row, already readable.
 *
 * The friendly label, the area and the rendered diff are computed here rather
 * than in the browser so the list and the detail view cannot disagree, and so a
 * client bundle does not have to carry the whole taxonomy.
 */
function toView(row: AuditRow) {
  const definition = describeAction(row.event_type);
  const entityType = row.entity_type ?? definition.entityType;

  return {
    id: row.id,
    occurredAt: row.occurred_at,
    action: row.event_type,
    actionLabel: definition.label,
    area: definition.area,
    sensitive: definition.sensitive === true,

    actorKind: row.actor_kind ?? (row.actor_user_id ? "staff" : "system"),
    actorUserId: row.actor_user_id,
    actorLabel: row.actor_label ?? (row.actor_user_id ? "Staff" : "System"),
    actorRole: row.actor_role,

    entityType,
    entityId: row.entity_id,
    entityLabel: row.entity_label,

    relatedOrderId: row.related_order_id,
    relatedProductionJobId: row.related_production_job_id,
    relatedProductId: row.related_product_id,

    /*
     * Derived when the row does not carry one.
     *
     * `recordAuditEvent` computes a summary at write time, but the catalog
     * trigger writes in SQL and cannot — so every product event arrived with a
     * null summary and rendered as "Changed product price / Shift Knob" with
     * the `$40.00 → $45.00` nowhere on the row, only behind an expand. Deriving
     * it here also means the formatting rules live in one place: a summary
     * frozen at write time would keep whatever wording was current the day it
     * was written.
     */
    summary: row.summary ?? summarizeChanges(row.changes, entityType),
    changes: renderChanges(row.changes, entityType),
    metadata: row.metadata ?? {},
    source: row.source,
    correlationId: row.correlation_id,
  };
}

export type AuditEventView = ReturnType<typeof toView>;
