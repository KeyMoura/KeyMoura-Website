// src/app/api/admin/users/verify/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";

export async function POST(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

  if (!actor.permissions.has("users.verify")) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: unknown = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const bodyObj =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};

  const userId = typeof bodyObj.userId === "string" ? bodyObj.userId : "";
  const isVerified = typeof bodyObj.isVerified === "boolean" ? bodyObj.isVerified : null;

  if (!userId || isVerified === null) {
    return NextResponse.json({ ok: false, error: "Missing userId/isVerified" }, { status: 400 });
  }

  const { error } = await routeServiceClient
    .from("profiles")
    .update({ is_verified: isVerified })
    .eq("id", userId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
