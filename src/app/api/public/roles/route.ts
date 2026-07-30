import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { isArray, isRecord, isString } from "@/lib/typeGuards";

type RoleRow = {
  key: string;
  label: string;
  priority: number;
  is_staff: boolean;
  badge_bg: string;
  badge_border: string;
  badge_text: string;
  badge_icon: string | null;
};

function normalizeRoleRow(v: unknown): RoleRow | null {
  if (!isRecord(v)) return null;
  if (!isString(v.key) || !isString(v.label)) return null;
  const priority = typeof v.priority === "number" ? v.priority : 0;
  const is_staff = typeof v.is_staff === "boolean" ? v.is_staff : false;
  const badge_bg = isString(v.badge_bg) ? v.badge_bg : "#111827";
  const badge_border = isString(v.badge_border) ? v.badge_border : "#374151";
  const badge_text = isString(v.badge_text) ? v.badge_text : "#E5E7EB";
  const badge_icon = isString(v.badge_icon) ? v.badge_icon : null;
  return {
    key: v.key,
    label: v.label,
    priority,
    is_staff,
    badge_bg,
    badge_border,
    badge_text,
    badge_icon,
  };
}

export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ roles: [] }, { status: 200 });
  }

  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false },
  });

  const { data } = await client
    .from("roles")
    .select("key,label,priority,is_staff,badge_bg,badge_border,badge_text,badge_icon")
    .order("priority", { ascending: false });

  const roles: RoleRow[] = [];
  if (isArray(data)) {
    for (const row of data) {
      const r = normalizeRoleRow(row);
      if (r) roles.push(r);
    }
  }

  return NextResponse.json({ roles }, { status: 200 });
}
