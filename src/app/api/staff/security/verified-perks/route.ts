import { NextRequest, NextResponse } from "next/server";

import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { isArray, isString } from "@/lib/typeGuards";

const TABLE = "site_verified_perks";

function normalizePerms(value: unknown): string[] {
  if (!isArray(value)) return [];
  const out: string[] = [];
  for (const p of value) {
    if (isString(p) && p.trim()) out.push(p.trim());
  }
  return out;
}

export async function GET(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!actor.permissions.has("security.verified_perks.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // routeServiceClient is an already-instantiated service-role Supabase client.
  const supabase = routeServiceClient;
  const { data, error } = await supabase.from(TABLE).select("permissions").eq("id", 1).maybeSingle();

  if (error) {
    return NextResponse.json({ permissions: [], tableMissing: true, error: error.message });
  }

  return NextResponse.json({ permissions: normalizePerms((data as any)?.permissions), tableMissing: false });
}

export async function POST(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!actor.permissions.has("security.verified_perks.manage")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => ({}));
  const perms = normalizePerms((body as any)?.permissions);

  // routeServiceClient is an already-instantiated service-role Supabase client.
  const supabase = routeServiceClient;
  const { error } = await supabase.from(TABLE).upsert({ id: 1, permissions: perms }, { onConflict: "id" });

  if (error) {
    return NextResponse.json({ error: error.message, tableMissing: true }, { status: 500 });
  }

  return NextResponse.json({ ok: true, permissions: perms });
}
