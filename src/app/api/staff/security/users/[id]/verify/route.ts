import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
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
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.verify");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const payload = parsePayload(await readJson(req));
  if (!payload) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { error } = await routeServiceClient.from("profiles").update(payload).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
