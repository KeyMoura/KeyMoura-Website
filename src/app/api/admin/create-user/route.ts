import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "crypto";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";

type Body = {
  email: string;
  password?: string;
  username?: string;
  displayName?: string;
  role?: string;
};

function cleanString(v: unknown): string | null {
  return typeof v === "string" ? v.trim() : null;
}

export async function POST(req: NextRequest) {
  try {
    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("users.create")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as unknown as Body | null;
    const email = cleanString(body?.email) ?? "";
    const password = cleanString(body?.password);
    const username = cleanString(body?.username);
    const displayName = cleanString(body?.displayName);
    const role = cleanString(body?.role);

    if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

    const finalPassword =
      typeof password === "string" && password.length >= 8
        ? password
        : randomBytes(24).toString("base64url").slice(0, 32);

    const { data: created, error: createErr } = await routeServiceClient.auth.admin.createUser({
      email,
      password: finalPassword,
      email_confirm: true,
    });

    if (createErr || !created.user) {
      console.error("createUser error", createErr);
      return NextResponse.json({ error: "Failed to create auth user." }, { status: 500 });
    }

    const newUserId = created.user.id;

    const { error: admissionErr } = await routeServiceClient.from("account_admissions").insert({
      user_id: newUserId,
      admitted_by: actor.userId,
      admission_source: "administrator",
    });
    if (admissionErr) {
      await routeServiceClient.auth.admin.deleteUser(newUserId);
      console.error("Failed to admit administrator-created user", admissionErr);
      return NextResponse.json({ error: "Failed to admit auth user." }, { status: 500 });
    }

    // Create profile row (best-effort)
    const { error: profileErr } = await routeServiceClient.from("profiles").insert({
      id: newUserId,
      username: username && username.length ? username : null,
      display_name: displayName && displayName.length ? displayName : null,
    });

    if (profileErr) console.error("Failed to create profile row", profileErr);

    // Assign initial role only if the actor has the permission to assign roles.
    const finalRole = role && role.length ? role : "member";
    if (actor.permissions.has("roles.assign")) {
      const { error: roleErr } = await routeServiceClient
        .from("user_roles")
        .upsert({ user_id: newUserId, role: finalRole }, { onConflict: "user_id" });

      if (roleErr) console.error("Failed to upsert user_roles", roleErr);
    }

    void logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "users.create",
      targetTable: "profiles",
      targetId: newUserId,
      metadata: { email, role: finalRole, username: username ?? null, displayName: displayName ?? null },
    });

    return NextResponse.json({ id: newUserId, email, role: finalRole, password: finalPassword }, { status: 200 });
  } catch (err) {
    console.error("Unexpected error in create-user route", err);
    return NextResponse.json({ error: "Unexpected error creating user." }, { status: 500 });
  }
}
