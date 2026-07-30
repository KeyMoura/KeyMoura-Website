import { NextRequest, NextResponse } from "next/server";
import { requirePermission, routeServiceClient } from "@/lib/api/routeAuth";
import { readJson, asRecord } from "@/lib/json";
import { isString } from "@/lib/typeGuards";

type Ctx = { params: Promise<{ id: string }> };

function readOptionalString(v: unknown): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (!isString(v)) return undefined;
  const t = v.trim();
  return t.length ? t : null;
}

function clamp(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * Updates safe profile fields for a user.
 */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await requirePermission(req, "users.profile.edit");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const body = asRecord(await readJson(req));
  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const username = readOptionalString(body.username);
  const displayName = readOptionalString(body.display_name ?? body.displayName);
  const bio = readOptionalString(body.bio);
  const location = readOptionalString(body.location);
  const avatarUrl = readOptionalString(body.avatar_url ?? body.avatarUrl);

  const update: Record<string, unknown> = {};
  if (username !== undefined) update.username = username ? clamp(username, 32) : null;
  if (displayName !== undefined) update.display_name = displayName ? clamp(displayName, 48) : null;
  if (bio !== undefined) update.bio = bio ? clamp(bio, 500) : null;
  if (location !== undefined) update.location = location ? clamp(location, 80) : null;
  if (avatarUrl !== undefined) update.avatar_url = avatarUrl ? clamp(avatarUrl, 500) : null;

  if (!Object.keys(update).length) {
    return NextResponse.json({ error: "No fields provided." }, { status: 400 });
  }

  const { error } = await routeServiceClient.from("profiles").update(update).eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
