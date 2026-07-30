import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("site_security_settings")
      .select(
        "lockdown_enabled, lockdown_message, lockdown_version"
      )
      .eq("id", 1)
      .maybeSingle<{
        lockdown_enabled: boolean;
        lockdown_message: string | null;
        lockdown_version: number | null;
      }>();

    if (error || !data) {
      console.error("lockdown-status: error or no data", error);
      // Fail open (no lockdown) if table is broken
      return NextResponse.json(
        {
          is_lockdown_enabled: false,
          lockdown_message: null,
          lockdown_version: 1,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      {
        is_lockdown_enabled: !!data.lockdown_enabled,
        lockdown_message: data.lockdown_message ?? null,
        lockdown_version: data.lockdown_version ?? 1,
      },
      { status: 200 }
    );
  } catch (e) {
    console.error("lockdown-status: unexpected error", e);
    return NextResponse.json(
      {
        is_lockdown_enabled: false,
        lockdown_message: null,
        lockdown_version: 1,
      },
      { status: 200 }
    );
  }
}
