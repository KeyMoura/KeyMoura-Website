import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type ChangeUsernamePayload = {
  username: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return jsonError(401, "Unauthorized");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const payload = body as Partial<ChangeUsernamePayload>;
  const desired = normalizeUsername(payload.username ?? "");
  if (!desired) return jsonError(400, "Username is required");

  const usernameRegex = /^[a-z0-9_.-]+$/;
  if (!usernameRegex.test(desired)) {
    return jsonError(
      400,
      "Username can only use lowercase letters, numbers, underscores, dashes, and dots."
    );
  }

  const admin = supabaseAdmin;

  // Load current username + last change timestamp
  const { data: current, error: loadErr } = await admin
    .from("profiles")
    .select("username, username_last_changed_at")
    .eq("id", user.id)
    .maybeSingle<{ username: string | null; username_last_changed_at: string | null }>();

  if (loadErr) {
    console.error("Failed to load current username", loadErr);
    return jsonError(500, "Failed to load current username");
  }

  if (!current) {
    return jsonError(404, "Profile not found");
  }

  if ((current.username ?? "").toLowerCase() === desired) {
    return NextResponse.json({ ok: true, username: desired });
  }

  const lastChangedAt = current.username_last_changed_at
    ? new Date(current.username_last_changed_at).getTime()
    : null;
  const nowMs = Date.now();
  const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

  if (lastChangedAt !== null && nowMs - lastChangedAt < THIRTY_DAYS_MS) {
    const nextAllowed = new Date(lastChangedAt + THIRTY_DAYS_MS).toISOString();
    return jsonError(429, `Username can only be changed every 30 days. Next: ${nextAllowed}`);
  }

  // Check uniqueness
  const { data: taken, error: takenErr } = await admin
    .from("profiles")
    .select("id")
    .eq("username", desired)
    .limit(1);

  if (takenErr) {
    console.error("Failed to check username availability", takenErr);
    return jsonError(500, "Failed to check username availability");
  }

  if ((taken ?? []).length > 0) {
    return jsonError(409, "That username is already taken.");
  }

  const { error: updateErr } = await admin
    .from("profiles")
    .update({ username: desired, username_last_changed_at: new Date().toISOString() })
    .eq("id", user.id);

  if (updateErr) {
    console.error("Failed to update username", updateErr);
    return jsonError(500, "Failed to update username");
  }

  return NextResponse.json({ ok: true, username: desired });
}
