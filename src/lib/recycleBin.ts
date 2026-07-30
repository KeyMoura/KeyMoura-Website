import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import { routeServiceClient } from "@/lib/api/routeAuth";

/**
 * Best-effort "recycle bin" backups for moderation deletes.
 *
 * Table is expected (recommended) to be created in Supabase:
 * - moderation_recycle_bin (id uuid, item_type text, original_table text,
 *   original_id text, payload jsonb, deleted_by uuid, deleted_at timestamptz,
 *   expires_at timestamptz)
 *
 * This module NEVER throws if the table doesn't exist yet; moderation actions
 * must continue to work.
 */

export type RecycleBinItemType = "thread" | "post" | "dm_message";

export type RecycleBinRow = {
  id: string;
  item_type: RecycleBinItemType;
  original_table: string;
  original_id: string;
  payload: Record<string, unknown> | null;
  deleted_by: string | null;
  deleted_at: string;
  expires_at: string;
};

function isPostgrestError(e: unknown): e is PostgrestError {
  return !!e && typeof e === "object" && "message" in e;
}

function addDaysIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export async function tryBackupToRecycleBin(args: {
  itemType: RecycleBinItemType;
  originalTable: string;
  originalId: string;
  payload: Record<string, unknown>;
  deletedBy: string;
  deletedAt?: string;
  expiresAt?: string;
  supabase?: SupabaseClient;
}): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  const supabase = args.supabase ?? routeServiceClient;
  const deletedAt = args.deletedAt ?? new Date().toISOString();
  const expiresAt = args.expiresAt ?? addDaysIso(30);

  try {
    const { data, error } = await supabase
      .from("moderation_recycle_bin")
      .insert({
      item_type: args.itemType,
      original_table: args.originalTable,
      original_id: String(args.originalId),
      payload: args.payload,
      deleted_by: args.deletedBy,
      deleted_at: deletedAt,
      expires_at: expiresAt,
      })
      .select("id")
      .maybeSingle<{ id: string }>();

    if (error) {
      // Table might not exist yet. Treat as non-fatal.
      return { ok: false, error: error.message };
    }

    return { ok: true, id: data?.id ?? null };
  } catch (e: unknown) {
    return { ok: false, error: isPostgrestError(e) ? e.message : "Backup failed" };
  }
}

export async function listRecycleBin(limit = 200): Promise<{ rows: RecycleBinRow[] } | { error: string }> {
  const supabase = routeServiceClient;
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("moderation_recycle_bin")
    .select("id, item_type, original_table, original_id, payload, deleted_by, deleted_at, expires_at")
    .gt("expires_at", nowIso)
    .order("deleted_at", { ascending: false })
    .limit(limit);

  if (error) return { error: error.message };
  return { rows: (data ?? []) as RecycleBinRow[] };
}

export async function getRecycleBinItem(id: string): Promise<{ row: RecycleBinRow } | { error: string }> {
  const supabase = routeServiceClient;
  const { data, error } = await supabase
    .from("moderation_recycle_bin")
    .select("id, item_type, original_table, original_id, payload, deleted_by, deleted_at, expires_at")
    .eq("id", id)
    .maybeSingle();

  if (error) return { error: error.message };
  if (!data) return { error: "Not found" };
  return { row: data as RecycleBinRow };
}

export async function deleteRecycleBinItem(id: string): Promise<{ ok: true } | { error: string }> {
  const supabase = routeServiceClient;
  const { error } = await supabase.from("moderation_recycle_bin").delete().eq("id", id);
  if (error) return { error: error.message };
  return { ok: true };
}
