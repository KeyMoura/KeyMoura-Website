import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditChange, resolveActorLabel } from "@/lib/audit/events";
import { readJson, asRecord } from "@/lib/json";
import { isString } from "@/lib/typeGuards";

type Ctx = { params: Promise<{ id: string }> };

function parsePayload(v: unknown): { donation_rank: string | null } | null {
  const r = asRecord(v);
  if (!r) return null;
  const raw = (r.donation_rank ?? r.donationRank) as unknown;
  if (raw === null) return { donation_rank: null };
  if (!isString(raw)) return null;
  const trimmed = raw.trim();
  return { donation_rank: trimmed.length ? trimmed : null };
}

/**
 * Updates a user's donation rank.
 *
 * Audited, which it previously was not. The rank is a public badge on a
 * person's profile, so setting one is a claim the shop makes about a customer
 * on its own site — worth being able to trace back to whoever made it.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.donation_rank.set");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const payload = parsePayload(await readJson(req));
  if (!payload) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { data: existing } = await routeServiceClient
    .from("profiles")
    .select("donation_rank")
    .eq("id", id)
    .maybeSingle<{ donation_rank: string | null }>();

  if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const before = existing.donation_rank ?? null;
  if (before === payload.donation_rank) {
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
    changes: { donation_rank: { before, after: payload.donation_rank } },
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json(
    { ok: true, changed: true, auditFailed: audit && !audit.ok ? true : undefined },
    { status: 200 }
  );
}
