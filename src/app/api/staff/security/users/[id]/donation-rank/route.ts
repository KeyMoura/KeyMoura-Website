import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
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
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.donation_rank.set");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const payload = parsePayload(await readJson(req));
  if (!payload) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { error } = await routeServiceClient.from("profiles").update(payload).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}