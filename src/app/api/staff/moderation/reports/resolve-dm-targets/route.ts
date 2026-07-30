import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

type Item = { threadId: string; reporterUserId: string };

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

function asRecord(v: unknown): Record<string, unknown> {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return {};
}

export async function POST(req: NextRequest) {
  const viewer = await getUserFromRequest(req);
  if (!viewer) return jsonError(401, "Unauthorized");

  const admin = supabaseAdmin;

  const { data: roleRow } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", viewer.id)
    .maybeSingle<{ role: string }>();

  const isStaff = !!roleRow && ["admin", "support", "moderator"].includes(roleRow.role);
  if (!isStaff) return jsonError(403, "Forbidden");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body");
  }

  const r = asRecord(body);
  const rawItems = Array.isArray(r.items) ? (r.items as unknown[]) : [];
  const items: Item[] = rawItems
    .map((it) => {
      const o = asRecord(it);
      const threadId = typeof o.threadId === "string" ? o.threadId : "";
      const reporterUserId = typeof o.reporterUserId === "string" ? o.reporterUserId : "";
      return { threadId: threadId.trim(), reporterUserId: reporterUserId.trim() };
    })
    .filter((it) => it.threadId && it.reporterUserId);

  if (!items.length) return NextResponse.json({ targets: {} });

  const threadIds = Array.from(new Set(items.map((i) => i.threadId)));

  // Pull participants from dm_messages (service role; bypass RLS).
  const { data: msgRows } = await admin
    .from("dm_messages")
    .select("thread_id, created_by")
    .in("thread_id", threadIds)
    .limit(5000);

  const membersByThread = new Map<string, string[]>();
  for (const row of (msgRows ?? []) as Array<{ thread_id: string; created_by: string }>) {
    const tid = String(row.thread_id);
    const uid = String(row.created_by);
    if (!tid || !uid) continue;
    const arr = membersByThread.get(tid) ?? [];
    if (!arr.includes(uid)) arr.push(uid);
    membersByThread.set(tid, arr);
  }

  const chosenUserIds = new Set<string>();
  const chosenByThread: Record<string, string | null> = {};

  for (const it of items) {
    const members = membersByThread.get(it.threadId) ?? [];
    const other = members.find((uid) => uid && uid !== it.reporterUserId) ?? null;
    chosenByThread[it.threadId] = other;
    if (other) chosenUserIds.add(other);
  }

  const userIds = Array.from(chosenUserIds);
  const { data: profRows } = userIds.length
    ? await admin.from("profiles").select("id, username, display_name").in("id", userIds)
    : { data: [] as Array<{ id: string; username: string | null; display_name: string | null }> };

  const profMap: Record<string, { username: string | null; display_name: string | null }> = {};
  for (const p of (profRows ?? []) as Array<{ id: string; username: string | null; display_name: string | null }>) {
    profMap[p.id] = { username: p.username ?? null, display_name: p.display_name ?? null };
  }

  const targets: Record<string, { userId: string; username: string | null; displayName: string | null }> = {};
  for (const tid of Object.keys(chosenByThread)) {
    const uid = chosenByThread[tid];
    if (!uid) continue;
    const prof = profMap[uid] ?? { username: null, display_name: null };
    targets[tid] = { userId: uid, username: prof.username, displayName: prof.display_name };
  }

  return NextResponse.json({ targets });
}
