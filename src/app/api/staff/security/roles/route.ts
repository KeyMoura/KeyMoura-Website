import { NextRequest, NextResponse } from "next/server";
import { readJson, asRecord } from "@/lib/json";
import { isArray, isBoolean, isNumber, isString } from "@/lib/typeGuards";
import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";

type RoleRow = {
  key: string;
  label: string;
  description: string | null;
  priority: number;
  is_staff: boolean;
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
    badge_bg: isString(r.badge_bg) ? r.badge_bg : "#111827",
    badge_border: isString(r.badge_border) ? r.badge_border : "#374151",
    badge_text: isString(r.badge_text) ? r.badge_text : "#E5E7EB",
    badge_icon: isString(r.badge_icon) ? r.badge_icon : null,
  };
}

function parseCreatePayload(v: unknown): {
  key: string;
  label: string;
  description: string | null;
  priority: number;
  is_staff: boolean;
  badge_bg: string;
  badge_border: string;
  badge_text: string;
  badge_icon: string | null;
} | null {
  const r = asRecord(v);
  if (!r) return null;
  const key = isString(r.key) ? r.key.trim().toLowerCase() : "";
  const label = isString(r.label) ? r.label.trim() : "";
  if (!key || !label) return null;
  const description = isString(r.description) ? r.description : null;
  const priority = isNumber(r.priority) ? r.priority : 0;
  const is_staff = isBoolean(r.is_staff) ? r.is_staff : false;
  const badge_bg = isString(r.badge_bg) ? r.badge_bg : "#111827";
  const badge_border = isString(r.badge_border) ? r.badge_border : "#374151";
  const badge_text = isString(r.badge_text) ? r.badge_text : "#E5E7EB";
  const badge_icon = isString(r.badge_icon) ? r.badge_icon : null;
  return { key, label, description, priority, is_staff, badge_bg, badge_border, badge_text, badge_icon };
}

export async function GET(req: NextRequest) {
  const actor = await requireAnyPermission(req, [
    "roles.manage",
    "roles.assign",
  ]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { data } = await routeServiceClient
    .from("roles")
    .select("key,label,description,priority,is_staff,badge_bg,badge_border,badge_text,badge_icon")
    .order("priority", { ascending: false });

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
  if (!parsed) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const { error } = await routeServiceClient.from("roles").insert(parsed);
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });

  return NextResponse.json({ ok: true }, { status: 200 });
}
