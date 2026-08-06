import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/routeAuth";
import { gatherIntegrationEvidence } from "@/lib/ops/evidence";
import { buildIntegrationChecks, summarizeIntegrations } from "@/lib/ops/integrationHealth";

/**
 * Integration health.
 *
 * Read-only by construction: this route contains no `insert`, `update`,
 * `delete` or `rpc`, and a test asserts it. A health page that can change
 * things is a health page somebody eventually presses a button on during an
 * incident.
 *
 * It makes no outbound call to any provider. No test charge, no test refund, no
 * real email, no probe request. Everything it reports is derived from records
 * this application already has and from *the presence* of environment
 * variables — never their values, which is enforced by the evidence gatherer
 * returning booleans rather than strings.
 */
export async function GET(req: NextRequest) {
  const actor = await requirePermission(req, "operations.health.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const evidence = await gatherIntegrationEvidence();
    const checks = buildIntegrationChecks(evidence, new Date());
    return NextResponse.json({ checks, summary: summarizeIntegrations(checks) });
  } catch (error) {
    // The message, not the object: a thrown Postgres error carries `details`,
    // which echoes row values back.
    console.error("integration health failed", { message: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Integration health could not be read." }, { status: 502 });
  }
}

export const dynamic = "force-dynamic";
