import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { getAdminActionRequestById, markAdminActionApproved } from "@/lib/adminApprovals";
import { verifyAdminOverridePassword } from "@/lib/adminOverride";
import { logAuditEvent } from "@/lib/audit";
import { createNotification } from "@/lib/notifications";
import { readJson } from "@/lib/json";
import { isArray, isRecord, isString } from "@/lib/typeGuards";

type Body = {
  requestId: string;
  admin_override_password: string;
};

type Audience = "all" | "staff" | "users";

/**
 * Reads a string value from an unknown record.
 */
function readString(value: unknown): string | null {
  return isString(value) ? value : null;
}

/**
 * Parses the request body for an override approve request.
 */
function parseBody(payload: unknown): Body | null {
  if (!isRecord(payload)) return null;
  const requestId = readString(payload.requestId);
  const admin_override_password = readString(payload.admin_override_password);
  if (!requestId || !admin_override_password) return null;
  return { requestId, admin_override_password };
}

/**
 * Parses a notification audience value.
 */
function parseAudience(value: unknown): Audience {
  const raw = readString(value)?.trim().toLowerCase();
  if (raw === "staff" || raw === "users") return raw;
  return "all";
}

/**
 * Normalizes a list of usernames.
 */
function parseUsernames(value: unknown): string[] {
  if (!isArray(value)) return [];
  return value
    .map((v) => (isString(v) ? v : String(v)))
    .map((u) => u.trim())
    .filter((u) => u.length > 0)
    .map((u) => (u.startsWith("@") ? u.slice(1) : u).toLowerCase());
}

/**
 * Extracts an approver IP for the "different IP" safeguard.
 */
function getApproverIp(req: NextRequest): string | null {
  const forwardedFor = req.headers.get("x-forwarded-for");
  const realIp = req.headers.get("x-real-ip");
  const fromForwarded = forwardedFor?.split(",")[0]?.trim();
  return fromForwarded || realIp || null;
}

export async function POST(req: NextRequest) {
  try {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!actor.permissions.has("security.approvals.override")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const body = parseBody(await readJson(req));
    if (!body) {
      return NextResponse.json({ error: "Missing requestId or admin_override_password." }, { status: 400 });
    }

    const okPw = await verifyAdminOverridePassword(body.admin_override_password);
    if (!okPw) {
      return NextResponse.json({ error: "Invalid admin override password." }, { status: 403 });
    }

    const fetched = await getAdminActionRequestById(body.requestId);
    if ("error" in fetched) {
      return NextResponse.json({ error: fetched.error }, { status: 404 });
    }

    const row = fetched.row;
    if (row.status !== "pending") {
      return NextResponse.json({ error: "Request is not pending." }, { status: 409 });
    }

    if (row.requested_by === actor.userId) {
      return NextResponse.json(
        { error: "A different admin must approve this request." },
        { status: 409 }
      );
    }

    const approverIp = getApproverIp(req);
    const requesterIp = row.requested_ip ?? null;
    if (requesterIp && approverIp && requesterIp === approverIp) {
      return NextResponse.json(
        { error: "Approval must come from a different IP." },
        { status: 409 }
      );
    }

    const mark = await markAdminActionApproved(body.requestId, actor.userId);
    if ("error" in mark) {
      return NextResponse.json({ error: mark.error }, { status: 500 });
    }

    const actionType = row.action_type;
    const rawPayload = row.payload;
    const payload: Record<string, unknown> =
      rawPayload && typeof rawPayload === "object" && !Array.isArray(rawPayload)
        ? (rawPayload as Record<string, unknown>)
        : {};

    const applyError = await applyApprovedAction(actionType, payload, actor.userId);
    if (applyError) {
      return NextResponse.json({ error: applyError }, { status: 500 });
    }

    await logAuditEvent({
      actorUserId: actor.userId,
      actorRole: actor.role,
      eventType: "admin.approvals.override_approve",
      targetTable: "admin_action_requests",
      targetId: body.requestId,
      metadata: { actionType },
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("override approve action error", err);
    return NextResponse.json({ error: "Unexpected error." }, { status: 500 });
  }
}

async function applyApprovedAction(
  actionType: string,
  payload: Record<string, unknown>,
  actorUserId: string
): Promise<string | null> {
  switch (actionType) {
    case "role_change": {
      const userId = readString(payload["userId"]);
      const newRole = readString(payload["newRole"]);
      if (!userId || !newRole) return "Invalid role_change payload.";

      const { error } = await routeServiceClient
        .from("user_roles")
        .upsert({ user_id: userId, role: newRole }, { onConflict: "user_id" });
      if (error) {
        console.error("apply role change error", error);
        return "Failed to apply role change.";
      }
      return null;
    }
    case "security_broadcast": {
      const enabled = payload["enabled"] === true;
      const text = readString(payload["text"])?.trim() ?? "";
      const levelRaw = readString(payload["level"]);
      const level: "info" | "warning" | "critical" =
        levelRaw === "warning" || levelRaw === "critical" ? levelRaw : "info";

      const finalEnabled = enabled && text.length > 0;

      const { error } = await routeServiceClient
        .from("site_security_settings")
        .update({
          emergency_banner_enabled: finalEnabled,
          emergency_banner_text: text.length > 0 ? text : null,
          emergency_banner_level: level,
        })
        .eq("id", 1);

      if (error) {
        console.error("apply security broadcast error", error);
        return "Failed to apply security broadcast.";
      }
      return null;
    }
    case "security_settings": {
      const lockdownEnabled = payload["lockdown_enabled"] === true;
      const maintenanceMode = payload["maintenance_mode"] === true;
      const lockdownMessage = readString(payload["lockdown_message"]);
      const newPassword = readString(payload["lockdown_password"]);

      const { data: existing, error: readErr } = await routeServiceClient
        .from("site_security_settings")
        .select("lockdown_version")
        .eq("id", 1)
        .maybeSingle();
      if (readErr) {
        console.error("read settings error", readErr);
        return "Failed to read current security settings.";
      }

      const currentVersionRaw = isRecord(existing) ? existing.lockdown_version : null;
      const currentVersion = typeof currentVersionRaw === "number" ? currentVersionRaw : 1;
      const nextVersion = currentVersion + 1;

      const updatePayload: Record<string, unknown> = {
        lockdown_enabled: lockdownEnabled,
        lockdown_message:
          lockdownMessage && lockdownMessage.trim().length > 0 ? lockdownMessage.trim() : null,
        maintenance_mode: maintenanceMode,
        lockdown_version: nextVersion,
        updated_at: new Date().toISOString(),
      };

      const bannerEnabled = payload["emergency_banner_enabled"];
      const bannerText = readString(payload["emergency_banner_text"]);
      const bannerLevelRaw = readString(payload["emergency_banner_level"]);
      if (typeof bannerEnabled === "boolean") {
        updatePayload["emergency_banner_enabled"] = bannerEnabled;
      }
      if (typeof bannerText === "string") {
        updatePayload["emergency_banner_text"] = bannerText.trim().length > 0 ? bannerText.trim() : null;
      }
      if (typeof bannerLevelRaw === "string") {
        const lvl: "info" | "warning" | "critical" =
          bannerLevelRaw === "warning" || bannerLevelRaw === "critical" ? bannerLevelRaw : "info";
        updatePayload["emergency_banner_level"] = lvl;
      }
      if (newPassword && newPassword.trim().length > 0) {
        updatePayload["lockdown_password"] = newPassword.trim();
      }

      const { error } = await routeServiceClient
        .from("site_security_settings")
        .update(updatePayload)
        .eq("id", 1);

      if (error) {
        console.error("apply security settings error", error);
        return "Failed to apply security settings.";
      }
      return null;
    }
    case "force_logout": {
      const epoch = Date.now();
      const { error } = await routeServiceClient
        .from("site_security_settings")
        .update({ force_logout_epoch: epoch, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) {
        console.error("apply force logout error", error);
        return "Failed to force logout.";
      }
      return null;
    }
    case "notification_broadcast": {
      const title = readString(payload["title"])?.trim() ?? "";
      const message = readString(payload["message"])?.trim() ?? "";
      const href = readString(payload["href"])?.trim() ?? null;
      const actorUserIdRaw = payload["actor_user_id"];
      const actorUserIdOverride = isString(actorUserIdRaw) ? actorUserIdRaw : null;

      const audience = parseAudience(payload["audience"]);
      const usernames = parseUsernames(payload["usernames"]);

      if (!title) return "Invalid notification_broadcast payload.";

      let rows: string[] = [];

      if (audience === "all") {
        const { data: profiles, error: profErr } = await routeServiceClient.from("profiles").select("id");
        if (profErr) {
          console.error("broadcast profiles error", profErr);
          return "Failed to load user list.";
        }

        rows = (profiles ?? [])
          .map((p) => (isRecord(p) ? p.id : null))
          .filter((id): id is string => isString(id) && id.length > 0);
      } else if (audience === "staff") {
        const { data: roles, error: rolesErr } = await routeServiceClient
          .from("user_roles")
          .select("user_id, role")
          .in("role", ["admin", "moderator", "mod", "support"]);
        if (rolesErr) {
          console.error("broadcast staff roles error", rolesErr);
          return "Failed to load staff list.";
        }

        rows = Array.from(
          new Set(
            (roles ?? [])
              .map((r) => (isRecord(r) ? r.user_id : null))
              .filter((v): v is string => isString(v) && v.length > 0)
          )
        );
      } else {
        if (!usernames.length) return "No usernames provided for user-targeted broadcast.";

        const { data: profRows, error: profErr } = await routeServiceClient
          .from("profiles")
          .select("id, username");
        if (profErr) {
          console.error("broadcast username lookup error", profErr);
          return "Failed to resolve usernames.";
        }

        const want = new Set(usernames.map((u) => u.toLowerCase()));
        rows = Array.from(
          new Set(
            (profRows ?? [])
              .filter((p) => isRecord(p) && isString(p.username) && want.has(p.username.toLowerCase()))
              .map((p) => (isRecord(p) ? p.id : null))
              .filter((id): id is string => isString(id))
          )
        );

        if (!rows.length) return "No matching usernames found.";
      }

      const chunkSize = 500;
      for (let i = 0; i < rows.length; i += chunkSize) {
        const chunk = rows.slice(i, i + chunkSize);
        const inserts = chunk.map((userId) => ({
          user_id: userId,
          actor_user_id: actorUserIdOverride,
          type: "broadcast",
          payload: {
            title,
            message: message || null,
            href,
          },
          is_read: false,
        }));

        const { error } = await routeServiceClient.from("notifications").insert(inserts);

        if (error) {
          console.error("broadcast insert error", error);
          return "Failed to send broadcast notifications.";
        }
      }

      return null;
    }
    case "ban_user": {
      const targetUserId = readString(payload["userId"]);
      const currentlyBanned = payload["currentlyBanned"] === true;
      const reason = readString(payload["reason"]);
      if (!targetUserId) return "Invalid ban_user payload.";

      if (currentlyBanned) {
        const { error } = await routeServiceClient
          .from("user_bans")
          .update({ active: false })
          .eq("user_id", targetUserId)
          .eq("active", true);

        if (error) {
          console.error("apply unban error", error);
          return "Failed to unban user.";
        }

        await createNotification({
          recipientUserId: targetUserId,
          actorUserId,
          type: "moderation",
          payload: {
            title: "Ban Removed",
            message: reason && reason.trim().length ? `Ban removed. (${reason.trim()})` : "Ban removed.",
          },
          bypassBlock: true,
        });
      } else {
        const banReason = reason && reason.trim().length > 0 ? reason.trim() : null;
        const { error } = await routeServiceClient.from("user_bans").insert({
          user_id: targetUserId,
          reason: banReason,
        });

        if (error) {
          console.error("apply ban error", error);
          return "Failed to ban user.";
        }

        await createNotification({
          recipientUserId: targetUserId,
          actorUserId,
          type: "moderation",
          payload: {
            title: "You have been banned",
            message: banReason ? `Reason: ${banReason}` : "You have been banned.",
          },
          bypassBlock: true,
        });
      }

      return null;
    }
    default:
      return `Unknown action type: ${actionType}`;
  }
}
