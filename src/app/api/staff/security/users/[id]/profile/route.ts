import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditChange, resolveActorLabel } from "@/lib/audit/events";
import { readJson, asRecord } from "@/lib/json";
import {
  canEditProfile,
  EDITABLE_PROFILE_FIELDS,
  sanitizeProfilePatch,
  type EditableProfileField,
} from "@/lib/staff/userAccess";
import type { ChangeSet } from "@/lib/audit/diff";

/**
 * Updates the profile fields staff are allowed to write.
 *
 * ## An allowlist, and what is deliberately outside it
 *
 * `EDITABLE_PROFILE_FIELDS` is the whole surface: username, display name, bio,
 * location. A denylist would have to be updated every time `profiles` grows a
 * column, and the failure mode of forgetting is that something private becomes
 * editable. Forgetting to extend an allowlist only leaves a field read-only.
 *
 * **Email is not here and that is the point.** It lives in `auth.users`, and
 * this codebase has no verified email-change flow. An unverified email change is
 * an account-takeover primitive: change the address, trigger a password reset,
 * receive it. Until that flow exists, email is read-only in staff tools.
 *
 * Also outside: password, provider identities, MFA, `email_confirmed_at`, and
 * every `raw_*_meta_data` field. `is_verified` and `donation_rank` are real and
 * editable, but each has its own permission and its own route — they are not
 * general profile edits and are not accepted here.
 *
 * ## Before and after, from a read taken first
 *
 * The previous values are read before the write so the audit event can carry a
 * real diff rather than "something changed". `recordAuditChange` then drops the
 * event entirely when nothing actually differs, so pressing Save on an untouched
 * form produces no row.
 */

type Ctx = { params: Promise<{ id: string }> };

type ProfileRow = Record<EditableProfileField, string | null> & { id: string };

const SELECT_COLUMNS = ["id", ...EDITABLE_PROFILE_FIELDS].join(",");

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const body = asRecord(await readJson(req));
  if (!body) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  // The wire has historically accepted camelCase for two of these. Normalized
  // before sanitizing so the allowlist sees one spelling.
  const normalized: Record<string, unknown> = { ...body };
  if (body.displayName !== undefined && body.display_name === undefined) normalized.display_name = body.displayName;
  if (body.avatarUrl !== undefined) delete normalized.avatarUrl;

  const patch = sanitizeProfilePatch(normalized);
  const fields = Object.keys(patch) as EditableProfileField[];

  if (!fields.length) {
    return NextResponse.json({ error: "No editable fields were provided." }, { status: 400 });
  }

  // --- who is being edited, and may this actor reach them --------------------
  const [{ data: existing }, { data: targetRole }] = await Promise.all([
    routeServiceClient.from("profiles").select(SELECT_COLUMNS).eq("id", id).maybeSingle<ProfileRow>(),
    routeServiceClient
      .from("staff_user_directory")
      .select("role_key,role_rank")
      .eq("id", id)
      .maybeSingle<{ role_key: string; role_rank: number }>(),
  ]);

  if (!existing) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const { data: actorRoleRow } = await routeServiceClient
    .from("roles")
    .select("rank")
    .eq("key", actor.role)
    .maybeSingle<{ rank: number | null }>();

  const decision = canEditProfile({
    actor: {
      userId: actor.userId,
      roleKey: actor.role,
      roleRank: actor.isOp ? Number.MAX_SAFE_INTEGER : actorRoleRow?.rank ?? 0,
      isOp: actor.isOp === true,
      permissions: actor.permissions,
    },
    target: {
      userId: id,
      roleKey: targetRole?.role_key ?? "member",
      roleRank: targetRole?.role_rank ?? 0,
    },
  });

  if (!decision.allowed) {
    return NextResponse.json({ error: decision.reason }, { status: decision.status });
  }

  // --- the diff, computed before the write ----------------------------------
  const changes: ChangeSet = {};
  const update: Record<string, string | null> = {};

  for (const field of fields) {
    const before = existing[field] ?? null;
    const after = patch[field] ?? null;
    if (before === after) continue;
    update[field] = after;
    changes[field] = { before, after };
  }

  if (!Object.keys(update).length) {
    // Nothing differs. Reported as success because the caller's intent — "the
    // profile should read like this" — is satisfied, and refusing would make a
    // double-click look like an error.
    return NextResponse.json({ ok: true, changed: false }, { status: 200 });
  }

  const { error } = await routeServiceClient.from("profiles").update(update).eq("id", id);

  if (error) {
    // A duplicate username is the one failure a staff member can fix themselves,
    // so it is named rather than reported as a generic 400.
    const code = (error as { code?: string }).code;
    if (code === "23505") {
      return NextResponse.json({ error: "That username is already taken." }, { status: 409 });
    }
    console.error("[staff/users/profile] update failed", { code: code ?? null });
    return NextResponse.json({ error: "Could not save the profile." }, { status: 400 });
  }

  const audit = await recordAuditChange({
    action: "user.profile_changed",
    actor: {
      kind: "staff",
      userId: actor.userId,
      role: actor.role,
      label: await resolveActorLabel(actor.userId),
    },
    entity: { type: "user", id, label: await resolveActorLabel(id) },
    changes,
    source: "staff_ui",
    actorIp: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  return NextResponse.json(
    { ok: true, changed: true, auditFailed: audit && !audit.ok ? true : undefined },
    { status: 200 }
  );
}
