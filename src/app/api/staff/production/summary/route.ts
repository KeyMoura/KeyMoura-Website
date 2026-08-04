import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { TERMINAL_STATUSES } from "@/lib/production/jobs";
import { logProductionFailure } from "@/lib/production/server";

/**
 * Counts for the dashboard's production cards.
 *
 * Every count is a `head: true` query — Postgres counts, and no row crosses the
 * wire. The dashboard needs seven numbers, not seven lists, and fetching a page
 * of jobs to length-check it in the browser is how a dashboard starts costing
 * a table scan per card.
 *
 * The counts are therefore true totals rather than "up to the first hundred",
 * which matters: a card that says 12 when there are 300 is worse than no card.
 */

const forbidden = () => NextResponse.json({ error: "Forbidden" }, { status: 403 });

const OPEN = `(${TERMINAL_STATUSES.join(",")})`;

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["production.view", "production.manage"]);
  if (!actor) return forbidden();

  // The caller's own day, so "overdue" agrees with the badges on the queue.
  const today = req.nextUrl.searchParams.get("today");
  const day = /^\d{4}-\d{2}-\d{2}$/.test(today ?? "") ? today! : new Date().toISOString().slice(0, 10);

  const countOf = (build: (query: ReturnType<typeof base>) => ReturnType<typeof base>) =>
    build(base()).then((result) => {
      // A refused count must not read as zero. PostgREST resolves rather than
      // rejects on an error, so without this the whole panel renders "0 open,
      // 0 overdue" when the real answer is that the database would not say —
      // which is exactly how the permission failure this route hit stayed
      // invisible on the dashboard while the queue beside it showed an error.
      if (result.error) throw result.error;
      return result.count ?? 0;
    });

  function base() {
    return routeServiceClient.from("production_jobs").select("id", { count: "exact", head: true });
  }

  try {
    const [open, overdue, blocked, unassigned, inQualityCheck, rework, ready, dueThisWeek] = await Promise.all([
      countOf((query) => query.not("status", "in", OPEN)),
      countOf((query) => query.not("status", "in", OPEN).lt("due_date", day)),
      countOf((query) => query.in("status", ["waiting_on_customer", "waiting_on_materials", "on_hold"])),
      countOf((query) => query.not("status", "in", OPEN).is("assigned_to", null)),
      countOf((query) => query.eq("status", "quality_check")),
      countOf((query) => query.eq("status", "rework_required")),
      countOf((query) => query.in("status", ["ready_for_pickup", "ready_to_ship"])),
      countOf((query) => {
        const end = new Date(`${day}T00:00:00Z`);
        end.setUTCDate(end.getUTCDate() + 7);
        return query
          .not("status", "in", OPEN)
          .gte("due_date", day)
          .lte("due_date", end.toISOString().slice(0, 10));
      }),
    ]);

    return NextResponse.json({
      open,
      overdue,
      blocked,
      unassigned,
      inQualityCheck,
      rework,
      ready,
      dueThisWeek,
    });
  } catch (cause) {
    logProductionFailure("summary.counts", cause);
    return NextResponse.json({ error: "Could not load production counts." }, { status: 500 });
  }
}

export const dynamic = "force-dynamic";
