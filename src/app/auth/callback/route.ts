import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@supabase/ssr";
import { installerAdmin } from "@/lib/installer/server";
import { safeLocalRedirectPath } from "@/lib/authRegistration";

type AdmissionOutcome =
  | "already_admitted"
  | "admitted"
  | "registration_closed"
  | "pending_review"
  | "rejected"
  | "policy_unavailable";

function loginError(origin: string, error: string): NextResponse {
  return NextResponse.redirect(new URL(`/auth/login?error=${error}`, origin));
}

/** Completes OAuth/PKCE only after durable account-admission verification. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  const otpType = url.searchParams.get("type");
  const supportedOtpType = otpType === "email" || otpType === "recovery";
  if (!code && !(tokenHash && supportedOtpType)) {
    return NextResponse.redirect(new URL("/auth/login", url.origin));
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  if (!supabaseUrl || !supabaseAnonKey) return loginError(url.origin, "missing_env");

  // Session cookies are staged here and returned only after admission succeeds.
  const success = NextResponse.redirect(new URL(safeLocalRedirectPath(url.searchParams.get("next")), url.origin));
  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (cookies) => cookies.forEach((cookie) => success.cookies.set(cookie.name, cookie.value, cookie.options)),
    },
  });
  const { data: exchange, error } = code
    ? await supabase.auth.exchangeCodeForSession(code)
    : await supabase.auth.verifyOtp({
        token_hash: tokenHash!,
        type: otpType as "email" | "recovery",
      });
  if (error || !exchange.user) return loginError(url.origin, "oauth_exchange_failed");

  const admin = installerAdmin();
  // This service-only RPC serializes policy evaluation with admission. In particular,
  // a policy closure racing this callback cannot result in a new admission.
  const { data, error: admissionError } = await admin.rpc("admit_oauth_account", {
    p_user_id: exchange.user.id,
  });
  if (admissionError) return loginError(url.origin, "policy_unavailable");

  const outcome = data as AdmissionOutcome;
  if (outcome === "already_admitted" || outcome === "admitted") return success;
  if (outcome === "pending_review") return loginError(url.origin, "account_pending_review");
  if (outcome === "registration_closed") return loginError(url.origin, "registration_closed");
  if (outcome === "rejected") return loginError(url.origin, "account_not_admitted");
  return loginError(url.origin, "policy_unavailable");
}
