import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditChange, resolveActorLabel } from "@/lib/audit/events";
import { readJson, asRecord } from "@/lib/json";

type Ctx = { params: Promise<{ id: string }> };

function parsePayload(v: unknown): { is_verified: boolean } | null {
  const r = asRecord(v);
  if (!r) return null;
  const raw = (r.is_verified ?? r.isVerified) as unknown;
  return typeof raw === "boolean" ? { is_verified: raw } : null;
}

/**
 * Updates a user's verified status.
 *
 * Audited, which it previously was not. Verification is not decorative here:
 * `loadPermissionsForUser` grants every permission in `site_verified_perks` to a
 * verified account, so flipping this flag can hand somebody capabilities. A
 * permission change with no record of who made it is the thing an audit log
 * exists to prevent.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.verify");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const payload = parsePayload(await readJson(req));
  if (!payload) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  // Read first, so the event can carry a real before/after rather than "changed".
  const { data: existing } = await routeServiceClient
    .from("profiles")
    .select("is_verified")
    .eq("id", id)
    .maybeSingle<{ is_verified: boolean | null }>();

  if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const before = existing.is_verified === true;
  if (before === payload.is_verified) {
    return NextResponse.json({ ok: true, changed: false }, { status: 200 });
  }

  const { error } = await routeServiceClient.from("profiles").update(payload).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  const audit = await recordAuditChange({
    action: "user.profile_changed",
    actor: {
      kind: "staff",
      userId: actor.userId,
      role: actor.role,
      label: await resolveActorLabel(actor.userId),
    },
    entity: { type: "user", id, label: await resolveActorLabel(id) },
    changes: { is_verified: { before, after: payload.is_verified } },
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json(
    { ok: true, changed: true, auditFailed: audit && !audit.ok ? true : undefined },
    { status: 200 }
  );
}
