import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/api/routeAuth";
import { runAutomationWorker } from "@/lib/automation/worker";
import { recordAuditEvent } from "@/lib/audit/events";

/**
 * Run the scheduler now, as a person.
 *
 * The same worker the cron route calls, with the same discovery, the same
 * re-validation and the same delivery claims — the only differences are that a
 * human is authenticated rather than a shared secret, the run is labelled
 * `manual` in `automation_runs`, and it is audited.
 *
 * ## Why this is not a hole
 *
 * It takes no input. There is no job id, no type, no entity and no "send this
 * one" — pressing it does exactly what the schedule would have done fifteen
 * minutes later, no more. The worst a staff member can do with it is make the
 * next fifteen minutes of work happen now, and every send it might perform is
 * one the schedule was already going to perform.
 *
 * ## Why it exists at all
 *
 * Because the alternative is worse. Without it, the only way to check whether
 * automation works after changing a threshold is to wait a quarter of an hour
 * and hope, and the only way to verify the system at all in a fresh environment
 * is to reconfigure the platform's cron. A supported button is better than the
 * workarounds its absence produces.
 *
 * It is gated on `automation.manage` rather than `automation.view` because it
 * really does cause reminders to go out, even though it causes only the ones
 * that were already due.
 */

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "automation.manage");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const summary = await runAutomationWorker("manual");

  await recordAuditEvent({
    action: "automation.settings_changed",
    actor: { kind: "staff", userId: actor.userId, role: actor.role },
    entity: { type: "setting", id: "automation", label: "Automation" },
    summary: `Ran the scheduler by hand: ${summary.completed} completed, ${summary.cancelled} cancelled, ${summary.failed} failed.`,
    source: "staff_ui",
    metadata: {
      action: "manual_run",
      discovered: summary.discovered,
      claimed: summary.claimed,
      completed: summary.completed,
      cancelled: summary.cancelled,
      failed: summary.failed,
      duration_ms: summary.durationMs,
    },
  });

  return NextResponse.json({ ok: summary.outcome !== "failed", summary });
}
