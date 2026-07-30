import "server-only";
import { createClient } from "@supabase/supabase-js";
import { moduleAvailability } from "./model";

export function installerAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is incomplete.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export async function installationStatus() {
  const db = installerAdmin();
  const { data, error } = await db.from("installation_state").select("status,completed_at,owner_user_id,last_error_code").eq("singleton", true).maybeSingle();
  if (error) return { bootstrapReady: false, status: "missing" as const, completedAt: null, errorCode: "CORE_MIGRATION_REQUIRED", modules: moduleAvailability([]) };
  const schemas = await db.from("schema_versions").select("module_key");
  const keys = schemas.error ? [] : (schemas.data ?? []).map((row) => row.module_key);
  return { bootstrapReady: true, status: data?.status ?? "pending", completedAt: data?.completed_at ?? null, errorCode: data?.last_error_code ?? null, modules: moduleAvailability(keys) };
}
