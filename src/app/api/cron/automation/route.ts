import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { runAutomationWorker } from "@/lib/automation/worker";

/**
 * The scheduled entry point. Vercel Cron calls this; nothing else may.
 *
 * ## What this route is not
 *
 * It takes **no input**. There is no job type, no entity id, no batch size and
 * no "run this one now" parameter — not because they would be hard to validate,
 * but because a caller who can name the work is a caller who can make this route
 * do something other than what the schedule says. Everything it does is decided
 * by database state and by settings a staff member configured. The body and the
 * query string are ignored entirely.
 *
 * ## Authentication
 *
 * A shared secret in the `Authorization` header, which is what Vercel Cron
 * sends. Three properties, each of which has been the missing one in somebody's
 * incident report:
 *
 *   - **Fail closed.** No `CRON_SECRET` configured means every request is
 *     refused, including the scheduled one. An endpoint that runs freely because
 *     its secret was never set is worse than one that never runs, because the
 *     first failure is silent and the second is obvious.
 *   - **Constant-time comparison.** `===` on a secret leaks its length and its
 *     prefix to anyone willing to measure. `timingSafeEqual` does not.
 *   - **Obscurity is not part of it.** The path is guessable and that is fine;
 *     the secret is the control.
 *
 * `x-vercel-cron` is deliberately *not* trusted as authentication. It is a
 * header, and headers are typed by whoever makes the request. It is read only to
 * label the run.
 *
 * ## Method
 *
 * `GET` only, because that is what Vercel Cron issues. Every other verb gets 405
 * rather than falling through to a handler that would have run the worker.
 * A staff member triggering a run by hand uses `/api/staff/automation/run`,
 * which authenticates a person and audits what they did.
 */

/**
 * Node runtime, not edge: the worker reaches the database through the Supabase
 * service client and sends mail through Resend, and it needs the full Node
 * runtime and a real time budget to do it.
 */
export const runtime = "nodejs";

/**
 * Never cached, never statically analysed into a build-time fetch. A cached
 * scheduler is a scheduler that reports its first run forever.
 */
export const dynamic = "force-dynamic";

/**
 * Long enough for the worker's own 45-second budget plus the sweeps, and well
 * inside the platform default. The worker stops claiming new batches at its
 * budget; this is the outer bound that keeps a stuck provider call from holding
 * the function open.
 */
export const maxDuration = 120;

function authorized(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  // Fail closed. An unset secret refuses everything rather than allowing it.
  if (!secret) return false;

  const header = req.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(secret);
  // `timingSafeEqual` throws on a length mismatch, which would itself be a
  // length oracle. Checked first and reported as a plain mismatch.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest) {
  if (!authorized(req)) {
    /*
     * A flat 401 with no detail. Not "secret not configured" and not "wrong
     * secret" — the difference between those two is exactly what an attacker
     * probing this endpoint would like to learn, and an operator can tell them
     * apart from the deployment settings.
     */
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const summary = await runAutomationWorker("cron");

  /*
   * Counts only. No job ids, no entity ids, no recipient and no error text: the
   * response goes into a platform log that is not the staff audit surface, and
   * the failure detail already lives on `scheduled_jobs` where the automation
   * page reads it under a permission.
   */
  return NextResponse.json(
    {
      ok: summary.outcome !== "failed",
      outcome: summary.outcome,
      enabled: summary.automationEnabled,
      discovered: summary.discovered,
      claimed: summary.claimed,
      completed: summary.completed,
      cancelled: summary.cancelled,
      failed: summary.failed,
      moreWaiting: summary.moreWaiting,
      durationMs: summary.durationMs,
    },
    { status: 200 }
  );
}

/**
 * Everything else is refused explicitly.
 *
 * Without these, Next returns 405 anyway — but it does so before the route's own
 * reasoning, and a future edit that adds a `POST` for some unrelated purpose
 * would silently gain an unauthenticated way to run the worker.
 */
export async function POST() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
export async function PUT() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
export async function PATCH() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
export async function DELETE() {
  return NextResponse.json({ error: "Method not allowed" }, { status: 405 });
}
