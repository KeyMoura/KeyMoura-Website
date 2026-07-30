import { routeServiceClient } from "@/lib/api/routeAuth";
import { isRecord } from "@/lib/typeGuards";

/**
 * Types and helpers for the admin approval queue.
 */

export type AdminActionType =
  | "ban_user"
  | "restriction_set"
  | "role_change"
  | "security_settings"
  | "force_logout"
  | "security_broadcast"
  | "notification_broadcast";

/**
 * Some deployments historically used "open" instead of "pending".
 * The app treats both as pending for UI/API purposes.
 */
export type AdminActionStatus = "pending" | "open" | "approved" | "rejected";

export type AdminActionRequestRow = {
  id: string;
  action_type: AdminActionType;
  status: AdminActionStatus;
  requested_by: string | null;
  requested_ip: string | null;
  requested_at: string;
  payload: Record<string, unknown> | null;
  decided_by?: string | null;
  decided_at?: string | null;
};

export type CreateAdminActionRequestInput = {
  action_type: AdminActionType;
  requested_by: string;
  target_user_id?: string | null;
  requested_ip?: string | null;
  payload?: Record<string, unknown> | null;
  note?: string | null;
};

const TABLE = "admin_action_requests";

type RowResult<T> = { row: T } | { error: string };
type RowsResult<T> = { rows: T[] } | { error: string };

/**
 * Creates a pending admin action request for later approval.
 */
export async function createAdminActionRequest(
  input: CreateAdminActionRequestInput
): Promise<RowResult<AdminActionRequestRow>> {
  const supabase = routeServiceClient;

  const payloadWithNote = (() => {
    const base: Record<string, unknown> = input.payload ? { ...input.payload } : {};
    if (input.note && input.note.trim().length) base._note = input.note.trim();
    if (input.target_user_id) base._target_user_id = input.target_user_id;
    return Object.keys(base).length ? base : null;
  })();

  const insertRow = {
    action_type: input.action_type,
    status: "pending" as const,
    requested_by: input.requested_by,
    requested_ip: input.requested_ip ?? null,
    payload: payloadWithNote,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .insert(insertRow)
    .select("*")
    .single<AdminActionRequestRow>();

  if (error) return { error: error.message };
  if (!data) return { error: "Failed to create request." };
  return { row: data };
}

/**
 * Lists pending admin action requests.
 */
export async function listPendingAdminActionRequests(
  limit = 100
): Promise<RowsResult<AdminActionRequestRow>> {
  const supabase = routeServiceClient;

  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .in("status", ["pending", "open"])
    .order("requested_at", { ascending: false })
    .limit(limit);

  if (error) return { error: error.message };
  return { rows: (data ?? []) as AdminActionRequestRow[] };
}

/**
 * Fetches a single request by id.
 */
export async function getAdminActionRequestById(
  id: string
): Promise<RowResult<AdminActionRequestRow>> {
  const supabase = routeServiceClient;

  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single<AdminActionRequestRow>();

  if (error) return { error: error.message };
  if (!data) return { error: "Request not found." };
  return { row: data };
}

/**
 * Marks a request as approved.
 *
 * Some deployments do not have dedicated decided_by/decided_at columns.
 * The app stores decision metadata inside the JSON payload for compatibility.
 */
export async function markAdminActionApproved(
  id: string,
  decidedBy: string
): Promise<RowResult<AdminActionRequestRow>> {
  const supabase = routeServiceClient;

  const existing = await getAdminActionRequestById(id);
  if (!("row" in existing)) return existing;

  const rawPayload = existing.row.payload;
  const prevPayload = isRecord(rawPayload) ? rawPayload : {};

  const mergedPayload: Record<string, unknown> = {
    ...prevPayload,
    _decided_by: decidedBy,
    _decided_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from(TABLE)
    .update({
      status: "approved",
      payload: mergedPayload,
    })
    .eq("id", id)
    .select("*")
    .single<AdminActionRequestRow>();

  if (error) return { error: error.message };
  if (!data) return { error: "Failed to mark request approved." };
  return { row: data };
}

/**
 * Marks a request as rejected.
 */
export async function markAdminActionRejected(
  id: string,
  decidedBy: string,
  note?: string
): Promise<RowResult<AdminActionRequestRow>> {
  const supabase = routeServiceClient;

  const existing = await getAdminActionRequestById(id);
  if (!("row" in existing)) return existing;

  const rawPayload = existing.row.payload;
  const prevPayload = isRecord(rawPayload) ? rawPayload : {};

  const mergedPayload: Record<string, unknown> = {
    ...prevPayload,
    _decided_by: decidedBy,
    _decided_at: new Date().toISOString(),
  };

  if (note && note.trim().length) mergedPayload._decision_note = note.trim();

  const patch: Record<string, unknown> = {
    status: "rejected",
    payload: mergedPayload,
  };

  const { data, error } = await supabase
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select("*")
    .single<AdminActionRequestRow>();

  if (error) return { error: error.message };
  if (!data) return { error: "Failed to mark request rejected." };
  return { row: data };
}
