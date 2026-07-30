import "server-only";
import { createClient } from "@supabase/supabase-js";
import { moduleAvailability } from "./model";
import { checkInstallationReadiness, logReadinessFailure, serverSupabaseEnv } from "./readiness";

export function installerAdmin() {
  const { url, serviceRoleKey: key } = serverSupabaseEnv();
  if (!url || !key) throw new Error("Supabase server configuration is incomplete.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function installationStatus() {
  const db = installerAdmin();
  const readiness = await checkInstallationReadiness(db);
  if (!readiness.ready) {
    logReadinessFailure("installer", readiness);
    return { bootstrapReady: false, status: "unavailable" as const, completedAt: null, errorCode: readiness.errorCode, modules: moduleAvailability([]) };
  }
  const data = readiness.row;
  const schemas = await db.from("schema_versions").select("module_key");
  const keys = schemas.error ? [] : (schemas.data ?? []).map((row) => row.module_key);
  return { bootstrapReady: true, status: readiness.status, completedAt: (data.completed_at as string | null) ?? null, errorCode: (data.last_error_code as string | null) ?? null, modules: moduleAvailability(keys) };
}
