import { NextResponse } from "next/server";
import { installerAdmin } from "@/lib/installer/server";
import { readRegistrationPolicy, registrationPolicyResponse } from "@/lib/authRegistration";
export async function GET() {
  const { data, error } = await installerAdmin().from("site_settings").select("auth_config").eq("singleton", true).maybeSingle();
  const result = error ? { available: false as const } : readRegistrationPolicy(data);
  return NextResponse.json(registrationPolicyResponse(result));
}
