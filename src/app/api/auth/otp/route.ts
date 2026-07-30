import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { installerAdmin } from "@/lib/installer/server";
import { approvedAuthRedirect, readRegistrationPolicy } from "@/lib/authRegistration";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { email?: unknown; redirectTo?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email.includes("@")) return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  const admin = installerAdmin();
  const settings = await admin.from("site_settings").select("auth_config,public_url").eq("singleton", true).maybeSingle();
  const policy = settings.error ? { available: false as const } : readRegistrationPolicy(settings.data);
  if (!policy.available) return NextResponse.json({ error: "Authentication policy is unavailable." }, { status: 503 });
  const { allowSignup } = policy.policy;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) return NextResponse.json({ error: "Authentication is unavailable." }, { status: 503 });
  const auth = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const redirectTo = approvedAuthRedirect(body?.redirectTo, settings.data?.public_url);
  if (!redirectTo) return NextResponse.json({ error: "Invalid authentication redirect." }, { status: 400 });
  const result = await auth.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo, shouldCreateUser: allowSignup } });
  if (result.error) {
    // Do not reveal whether an account exists while registration is closed.
    return allowSignup ? NextResponse.json({ error: "Failed to send login email." }, { status: 400 }) : NextResponse.json({ sent: true });
  }
  return NextResponse.json({ sent: true });
}
