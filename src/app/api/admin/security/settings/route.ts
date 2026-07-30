import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, getUserFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { logAuditEvent } from "@/lib/audit";

type SecuritySettingsBody = {
  lockdown_enabled: boolean;
  lockdown_message: string;
  maintenance_mode: boolean;
  emergency_banner_enabled?: boolean;
  emergency_banner_text?: string;
  emergency_banner_level?: string;
  lockdown_password?: string;
};

function readString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    const user = await getUserFromRequest(req);
    if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const actor = await getActorAccessFromRequest(req);
    if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!actor.permissions.has("security.settings.manage")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => null)) as unknown as SecuritySettingsBody | null;
    const lockdownEnabled = (body as unknown as { lockdown_enabled?: unknown })?.lockdown_enabled;
    const maintenanceMode = (body as unknown as { maintenance_mode?: unknown })?.maintenance_mode;
    const message = readString((body as unknown as { lockdown_message?: unknown })?.lockdown_message) ?? "";
    const password = readString((body as unknown as { lockdown_password?: unknown })?.lockdown_password);
    const bannerEnabled = (body as unknown as { emergency_banner_enabled?: unknown })
      ?.emergency_banner_enabled;
    const bannerText = readString(
      (body as unknown as { emergency_banner_text?: unknown })?.emergency_banner_text
    );
    const bannerLevel = readString(
      (body as unknown as { emergency_banner_level?: unknown })?.emergency_banner_level
    );

    if (typeof lockdownEnabled !== "boolean" || typeof maintenanceMode !== "boolean") {
      return NextResponse.json({ error: "Invalid settings." }, { status: 400 });
    }

    const payload: Record<string, unknown> = {
      lockdown_enabled: lockdownEnabled,
      lockdown_message: message,
      maintenance_mode: maintenanceMode,
      ...(password ? { lockdown_password: password } : {}),
    };

    if (typeof bannerEnabled === "boolean") {
      payload["emergency_banner_enabled"] = bannerEnabled;
    }
    if (typeof bannerText === "string") {
      payload["emergency_banner_text"] = bannerText;
    }
    if (typeof bannerLevel === "string") {
      payload["emergency_banner_level"] = bannerLevel;
    }

    // Admin security settings apply immediately (no approval loop).
    // IMPORTANT: bump lockdown_version to invalidate old unlocks.
    const { data: existing, error: readErr } = await routeServiceClient
      .from("site_security_settings")
      .select("lockdown_version")
      .eq("id", 1)
      .maybeSingle<{ lockdown_version: number | null }>();

    if (readErr) {
      console.error("security settings read error", readErr);
      return NextResponse.json({ error: "Failed to read current settings." }, { status: 500 });
    }

    const currentVersion = typeof existing?.lockdown_version === "number" ? existing.lockdown_version : 1;
    const nextVersion = currentVersion + 1;

    const updatePayload: Record<string, unknown> = {
      ...payload,
      lockdown_version: nextVersion,
      updated_at: new Date().toISOString(),
    };

    const updateRes = await routeServiceClient
      .from("site_security_settings")
      .update(updatePayload)
      .eq("id", 1)
      .select("id")
      .maybeSingle<{ id: number }>();

    if (updateRes.error) {
      console.error("security settings apply error", updateRes.error);
      return NextResponse.json({ error: "Failed to apply settings." }, { status: 500 });
    }

    await logAuditEvent({
      actorUserId: user.id,
      actorRole: "admin",
      eventType: "admin.security.settings.apply",
      targetTable: "site_security_settings",
      targetId: String(updateRes.data?.id ?? 1),
      metadata: { lockdownEnabled, maintenanceMode, hasPassword: !!password },
    });

    return NextResponse.json({ ok: true, pending: false }, { status: 200 });
  } catch (err) {
    console.error("security settings request error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}
