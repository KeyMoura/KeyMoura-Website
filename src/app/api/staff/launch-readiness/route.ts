import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";
import { gatherIntegrationEvidence, gatherReadinessEvidence } from "@/lib/ops/evidence";
import { buildIntegrationChecks } from "@/lib/ops/integrationHealth";
import { applyAcknowledgements, buildReadinessChecks, summarizeReadiness } from "@/lib/ops/launchReadiness";

/**
 * Launch readiness.
 *
 * `GET` computes the checklist. `POST` records an acknowledgement — a decision
 * *about a warning*, and nothing else.
 *
 * The acknowledgement is deliberately the only write on this route, and it is
 * confined to its own table. It changes no setting, no order, no product and no
 * financial value. That separation is the point: acknowledging "KM-0001 records
 * $25.00 collected with no payment row" must never be able to create one.
 */

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["launch.readiness.view", "operations.health.view"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  try {
    const integrationEvidence = await gatherIntegrationEvidence();
    const integrations = buildIntegrationChecks(integrationEvidence, new Date());
    const evidence = await gatherReadinessEvidence(integrations);
    const checks = buildReadinessChecks(evidence);

    const { data: acks } = await routeServiceClient
      .from("launch_readiness_acknowledgements")
      .select("check_id,fingerprint,note,acknowledged_at")
      .is("cleared_at", null);

    const applied = applyAcknowledgements(checks, (acks ?? []) as { check_id: string; fingerprint: string }[]);

    return NextResponse.json({
      checks: applied,
      summary: summarizeReadiness(applied),
      canAcknowledge: actor.permissions.has("launch.readiness.acknowledge"),
      // Restated in the payload, not only in the page, so no other consumer of
      // this endpoint can present the result as a compliance certificate.
      disclaimer:
        "This checklist reports whether the configuration this application reads is complete and coherent. It is not a legal, tax, accessibility or security compliance assessment and does not certify any of those.",
    });
  } catch (error) {
    console.error("launch readiness failed", { message: error instanceof Error ? error.message : "unknown" });
    return NextResponse.json({ error: "Launch readiness could not be computed." }, { status: 502 });
  }
}

type AckBody = { checkId?: unknown; fingerprint?: unknown; note?: unknown; clear?: unknown };

export async function POST(req: NextRequest) {
  const actor = await requirePermission(req, "launch.readiness.acknowledge");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = ((await req.json().catch(() => null)) ?? {}) as AckBody;
  const checkId = typeof body.checkId === "string" ? body.checkId.trim().slice(0, 120) : "";
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.slice(0, 200) : "";
  const note = typeof body.note === "string" ? body.note.trim().slice(0, 1000) : "";
  if (!checkId) return NextResponse.json({ error: "Which check?" }, { status: 400 });

  // Recompute rather than trusting the client. The severity that decides
  // whether acknowledging is even allowed must come from the current state of
  // the shop, not from a field in the request.
  const integrationEvidence = await gatherIntegrationEvidence();
  const integrations = buildIntegrationChecks(integrationEvidence, new Date());
  const evidence = await gatherReadinessEvidence(integrations);
  const check = buildReadinessChecks(evidence).find((candidate) => candidate.id === checkId);

  if (!check) return NextResponse.json({ error: "That check does not exist." }, { status: 404 });

  if (body.clear === true) {
    await routeServiceClient
      .from("launch_readiness_acknowledgements")
      .update({ cleared_at: new Date().toISOString(), cleared_by: actor.userId })
      .eq("check_id", checkId)
      .is("cleared_at", null);
    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "staff.launch.acknowledgement_cleared",
      targetTable: "launch_readiness_acknowledgements",
      targetId: checkId,
    });
    return NextResponse.json({ ok: true, cleared: true });
  }

  // A blocker means a customer trying to buy right now would fail. Letting
  // somebody tick that away would turn the one part of the page that has to be
  // believed into the part that can be silenced.
  if (check.state === "blocker") {
    return NextResponse.json(
      { error: "A blocker cannot be acknowledged. It has to be fixed or it will stop a real customer." },
      { status: 409 }
    );
  }
  if (!check.acknowledgeable) {
    return NextResponse.json({ error: "This check does not offer an acknowledgement." }, { status: 409 });
  }
  // Stale-state guard: the fingerprint the page rendered from must still be
  // what the check says, so accepting "3 products have no image" cannot land on
  // a situation where there are now eleven.
  if (fingerprint && fingerprint !== check.fingerprint) {
    return NextResponse.json(
      { error: "This check has changed since the page loaded. Reload and read it again before accepting it.", conflict: true },
      { status: 409 }
    );
  }

  // Supersede rather than upsert, so the history of who accepted what survives.
  await routeServiceClient
    .from("launch_readiness_acknowledgements")
    .update({ cleared_at: new Date().toISOString(), cleared_by: actor.userId })
    .eq("check_id", checkId)
    .is("cleared_at", null);

  const { error } = await routeServiceClient.from("launch_readiness_acknowledgements").insert({
    check_id: checkId,
    fingerprint: check.fingerprint,
    severity: check.state === "info" ? "info" : "warning",
    note: note || null,
    acknowledged_by: actor.userId,
  });

  if (error) {
    console.error("acknowledge failed", { code: error.code, hint: error.hint });
    return NextResponse.json({ error: "That acknowledgement could not be recorded." }, { status: 502 });
  }

  await logAuditEvent({
    actorUserId: actor.userId,
    actorRole: actor.role,
    eventType: "staff.launch.acknowledged",
    targetTable: "launch_readiness_acknowledgements",
    targetId: checkId,
    // The note is recorded on the acknowledgement row, not copied into the
    // audit log — the audit log is read more widely and kept longer.
    metadata: { check_id: checkId, severity: check.state },
  });

  return NextResponse.json({ ok: true });
}

export const dynamic = "force-dynamic";
