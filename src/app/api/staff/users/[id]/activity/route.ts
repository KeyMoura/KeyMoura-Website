import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { describeAction } from "@/lib/audit/actions";
import { renderChanges, summarizeChanges, type ChangeSet } from "@/lib/audit/diff";
import { isUserUuid } from "@/lib/staff/userDirectory";

/**
 * A user's audit activity.
 *
 * ## Only relationships the table can actually prove
 *
 * Two, and they are both columns:
 *
 *  * **Subject** — `entity_type = 'user' and entity_id = <id>`. Things done *to*
 *    this account: role assigned, status changed, note added, profile edited.
 *  * **Actor** — `actor_user_id = <id>`. Things this person did, which matters
 *    when the person is staff.
 *
 * Nothing is inferred. There is no heuristic that decides an event "looks
 * related", because a fabricated relationship in an audit log is worse than a
 * missing one — the reader cannot tell which rows were guessed.
 *
 * Order and production events are reachable from the Orders tab, which deep
 * links into `/staff/audit?order=<id>` with the real filter applied. This
 * endpoint deliberately does not reproduce the whole audit UI; it answers "what
 * happened to this account", and hands off for anything wider.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 100;

const SELECT_COLUMNS =
  "id,occurred_at,actor_user_id,actor_kind,actor_label,actor_role,event_type," +
  "entity_type,entity_id,entity_label,related_order_id,related_production_job_id,related_product_id," +
  "changes,summary,source";

type AuditRow = {
  id: string;
  occurred_at: string;
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
  source: string | null;
};

export const SCOPES = ["subject", "actor", "all"] as const;
type Scope = (typeof SCOPES)[number];

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await requireAnyPermission(req, ["audit.view", "audit.read"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const url = new URL(req.url);
  const rawScope = url.searchParams.get("scope");
  const scope: Scope = (SCOPES as readonly string[]).includes(String(rawScope)) ? (rawScope as Scope) : "all";

  const rawSize = Number(url.searchParams.get("size"));
  const pageSize =
    Number.isInteger(rawSize) && rawSize > 0 ? Math.min(rawSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;

  // One extra row answers "is there another page" without counting a table
  // nobody wants to count.
  let query = routeServiceClient
    .from("audit_logs")
    .select(SELECT_COLUMNS)
    .order("occurred_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);

  if (scope === "subject") {
    query = query.eq("entity_type", "user").eq("entity_id", id);
  } else if (scope === "actor") {
    query = query.eq("actor_user_id", id);
  } else {
    query = query.or(`and(entity_type.eq.user,entity_id.eq.${id}),actor_user_id.eq.${id}`);
  }

  // Keyset cursor on `occurred_at`, matching `/api/staff/audit`. Offset paging
  // over a table that grows at the head shows duplicates.
  const cursor = url.searchParams.get("cursor");
  if (cursor) query = query.lt("occurred_at", cursor);

  const { data, error } = await query;

  if (error) {
    console.error("[staff/users/:id/activity] list failed", {
      code: (error as { code?: string }).code ?? null,
      message: (error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load this user's activity." }, { status: 500 });
  }

  const rows = (data ?? []) as unknown as AuditRow[];
  const hasMore = rows.length > pageSize;
  const page = hasMore ? rows.slice(0, pageSize) : rows;

  return NextResponse.json({
    events: page.map((row) => {
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
        // Derived when the row carries no summary, exactly as the main audit
        // route does — the formatting rules stay in one place.
        summary: row.summary ?? summarizeChanges(row.changes, entityType),
        changes: renderChanges(row.changes, entityType),
        source: row.source,
        /** True when this event is about the user rather than done by them. */
        isSubject: row.entity_type === "user" && row.entity_id === id,
      };
    }),
    scope,
    nextCursor: hasMore ? page[page.length - 1]?.occurred_at ?? null : null,
    hasMore,
  });
}
