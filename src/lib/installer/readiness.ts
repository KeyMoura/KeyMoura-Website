import type { SupabaseClient } from "@supabase/supabase-js";

export type InstallationStatus = "pending" | "configuring" | "complete" | "failed";
export type ReadinessErrorCode =
  | "CORE_TABLE_MISSING"
  | "CORE_ROW_MISSING"
  | "SUPABASE_AUTH_FAILED"
  | "SUPABASE_NETWORK_ERROR"
  | "CORE_QUERY_FAILED";

export type InstallationReadiness =
  | { ready: true; status: InstallationStatus; row: Record<string, unknown> }
  | { ready: false; errorCode: ReadinessErrorCode; error: SanitizedSupabaseError | null };

export type SanitizedSupabaseError = {
  code: string | null;
  message: string;
  details: string | null;
  hint: string | null;
};

type QueryError = { code?: string; message?: string; details?: string; hint?: string };

export function serverSupabaseEnv() {
  // Trimming is important for secrets pasted into Vercel, where a trailing newline
  // otherwise becomes part of the apikey and Authorization headers.
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "",
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "",
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "",
  };
}

export function sanitizeSupabaseError(error: QueryError): SanitizedSupabaseError {
  const redact = (value: string | undefined | null) => {
    if (value == null) return null;
    return value
      .replace(/(apikey|api[_ -]?key|authorization|password|secret|token)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
      .replace(/postgres(?:ql)?:\/\/[^\s@]+@/gi, "postgresql://[REDACTED]@");
  };
  return {
    code: error.code ?? null,
    message: redact(error.message) ?? "Unknown Supabase error",
    details: redact(error.details),
    hint: redact(error.hint),
  };
}

function classify(error: SanitizedSupabaseError): ReadinessErrorCode {
  const text = `${error.code ?? ""} ${error.message}`.toLowerCase();
  if (error.code === "42P01" || error.code === "PGRST205" || text.includes("installation_state") && text.includes("not find")) return "CORE_TABLE_MISSING";
  if (["PGRST301", "PGRST302"].includes(error.code ?? "") || /jwt|api key|apikey|unauthorized|permission denied/.test(text)) return "SUPABASE_AUTH_FAILED";
  if (/fetch failed|network|timeout|timed out|econn|enotfound/.test(text)) return "SUPABASE_NETWORK_ERROR";
  return "CORE_QUERY_FAILED";
}

export async function checkInstallationReadiness(
  db: SupabaseClient,
  columns = "status,completed_at,owner_user_id,last_error_code",
): Promise<InstallationReadiness> {
  try {
    const { data, error } = await db.from("installation_state").select(columns).eq("singleton", true).maybeSingle();
    if (error) {
      const sanitized = sanitizeSupabaseError(error);
      return { ready: false, errorCode: classify(sanitized), error: sanitized };
    }
    if (!data) return { ready: false, errorCode: "CORE_ROW_MISSING", error: null };
    const row = data as unknown as Record<string, unknown>;
    return { ready: true, status: (row.status as InstallationStatus) ?? "pending", row };
  } catch (error) {
    const sanitized = sanitizeSupabaseError(error instanceof Error ? error : { message: String(error) });
    return { ready: false, errorCode: classify(sanitized), error: sanitized };
  }
}

export function logReadinessFailure(context: string, result: Extract<InstallationReadiness, { ready: false }>) {
  // Only the PostgREST error fields are logged. Request headers, URLs, and credentials
  // are deliberately never included.
  console.error(`[${context}] installation readiness failed`, {
    errorCode: result.errorCode,
    supabase: result.error,
  });
}
