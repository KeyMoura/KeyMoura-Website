import { NextRequest, NextResponse } from "next/server";
import { readJson, asRecord } from "@/lib/json";
import { isArray, isBoolean, isNumber, isString } from "@/lib/typeGuards";
import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { recordAuditEventStrict, resolveActorLabel } from "@/lib/audit/events";
import { requestIp } from "@/lib/audit/security";
import {
  DEFAULT_BADGE_BG,
  DEFAULT_BADGE_BORDER,
  DEFAULT_BADGE_TEXT,
  ROLE_ORDER_COLUMN,
  ROLE_SELECT,
  isRoleBadgeIcon,
  normalizeBadgeIcon,
  roleWriteErrorMessage,
  toRoleDbColumns,
} from "@/lib/staff/roleSchema";
import { canManageRole } from "@/lib/staff/userAccess";

type RoleRow = {
  key: string;
  label: string;
  description: string | null;
  priority: number;
  is_staff: boolean;
  is_system: boolean;
  badge_bg: string;
  badge_border: string;
  badge_text: string;
  badge_icon: string | null;
};

type RolesResponse = {
  roles: RoleRow[];
};

function normalizeRoleRow(v: unknown): RoleRow | null {
  const r = asRecord(v);
  if (!r) return null;
  if (!isString(r.key) || !isString(r.label)) return null;
  return {
    key: r.key,
    label: r.label,
    description: isString(r.description) ? r.description : null,
    priority: isNumber(r.priority) ? r.priority : 0,
    is_staff: isBoolean(r.is_staff) ? r.is_staff : false,
    is_system: isBoolean(r.is_system) ? r.is_system : false,
    badge_bg: isString(r.badge_bg) ? r.badge_bg : DEFAULT_BADGE_BG,
    badge_border: isString(r.badge_border) ? r.badge_border : DEFAULT_BADGE_BORDER,
    badge_text: isString(r.badge_text) ? r.badge_text : DEFAULT_BADGE_TEXT,
    badge_icon: isString(r.badge_icon) ? r.badge_icon : null,
  };
}

/**
 * A role key becomes `profiles.role` and the target of `role_permissions`, so it
 * has to be a stable identifier rather than whatever was typed. Lowercase
 * letters, digits, underscore and hyphen only.
 */
const ROLE_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,39}$/;

type CreatePayload = {
  key: string;
  label: string;
  description: string;
  priority: number;
  is_staff: boolean;
  badge_bg: string;
  badge_border: string;
  badge_text: string;
  badge_icon: string | null;
};

function parseCreatePayload(v: unknown): { value: CreatePayload } | { error: string } {
  const r = asRecord(v);
  if (!r) return { error: "Send a role to create." };

  const key = isString(r.key) ? r.key.trim().toLowerCase() : "";
  const label = isString(r.label) ? r.label.trim() : "";
  if (!key) return { error: "Give the role a key." };
  if (!ROLE_KEY_PATTERN.test(key)) {
    return {
      error:
        "A role key starts with a letter and uses only lowercase letters, numbers, hyphens and underscores.",
    };
  }
  if (!label) return { error: "Give the role a label." };
  if (label.length > 60) return { error: "A role label is at most 60 characters." };

  // An unknown icon name renders as no icon at all, so accepting it would store
  // a value that silently does nothing. Refuse it and say which names work.
  if (r.badge_icon !== undefined && r.badge_icon !== null && r.badge_icon !== "") {
    if (!isRoleBadgeIcon(r.badge_icon)) return { error: "That is not one of the available badge icons." };
  }

  return {
    value: {
      key,
      label,
      // `''`, never `null`. `roles.description` is NOT NULL DEFAULT '', and an
      // explicit null overrides the default instead of triggering it — which is
      // what refused every create the two-field form has ever attempted.
      description: isString(r.description) ? r.description : "",
      priority: isNumber(r.priority) ? Math.trunc(r.priority) : 0,
      is_staff: isBoolean(r.is_staff) ? r.is_staff : false,
      badge_bg: isString(r.badge_bg) ? r.badge_bg : DEFAULT_BADGE_BG,
      badge_border: isString(r.badge_border) ? r.badge_border : DEFAULT_BADGE_BORDER,
      badge_text: isString(r.badge_text) ? r.badge_text : DEFAULT_BADGE_TEXT,
      badge_icon: normalizeBadgeIcon(r.badge_icon),
    },
  };
}

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["roles.manage", "roles.assign"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data, error } = await routeServiceClient
    .from("roles")
    .select(ROLE_SELECT)
    .order(ROLE_ORDER_COLUMN, { ascending: false });

  // A refused read used to fall through to `roles: []`, which rendered as "this
  // shop has no roles" — the most confident possible wrong answer. Say so.
  if (error) return NextResponse.json({ error: "Could not load roles." }, { status: 500 });

  const roles: RoleRow[] = [];
  if (isArray(data)) {
    for (const row of data) {
      const n = normalizeRoleRow(row);
      if (n) roles.push(n);
    }
  }

  const body: RolesResponse = { roles };
  return NextResponse.json(body, { status: 200 });
}

export async function POST(req: NextRequest) {
  const actor = await requireAnyPermission(req, ["roles.manage"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const payload = await readJson(req);
  const parsed = parseCreatePayload(payload);
  if ("error" in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 });

  const { key, ...rest } = parsed.value;
  const row = { key, ...toRoleDbColumns(rest) };

  const { data: actorRole, error: actorRoleError } = await routeServiceClient
    .from("roles")
    .select("rank")
    .eq("key", actor.role)
    .maybeSingle<{ rank: number }>();
  if (actorRoleError || (!actor.isOp && !actorRole)) {
    return NextResponse.json({ error: "Could not verify your role hierarchy." }, { status: 500 });
  }
  const decision = canManageRole({
    actor: {
      userId: actor.userId,
      roleKey: actor.role,
      roleRank: actorRole?.rank ?? 0,
      isOp: actor.isOp === true,
      permissions: actor.permissions,
    },
    nextRoleRank: parsed.value.priority,
  });
  if (!decision.allowed) return NextResponse.json({ error: decision.reason }, { status: decision.status });

  const { error } = await routeServiceClient.from("roles").insert(row);
  if (error) {
    const { message, status } = roleWriteErrorMessage(error, "create");
    return NextResponse.json({ error: message }, { status });
  }

  await recordAuditEventStrict({
    action: "role.created",
    actor: {
      kind: "staff",
      userId: actor.userId,
      role: actor.role,
      label: await resolveActorLabel(actor.userId),
    },
    // `row` has already been through `toRoleDbColumns`, so the display name is
    // under the column name `name`, not the editor's `label`.
    entity: { type: "role", id: key, label: String((row as { name?: string }).name ?? key) },
    changes: {
      name: { before: null, after: key },
      // A role created as staff starts with staff reach, which is the fact
      // worth seeing on the row rather than buried in a later edit.
      is_staff: { before: null, after: Boolean((row as { is_staff?: boolean }).is_staff) },
    },
    source: "staff_ui",
    actorIp: requestIp(req.headers),
  });

  return NextResponse.json({ ok: true }, { status: 200 });
}
