import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

export async function POST(req: Request) {
  try {
    const { password } = (await req.json()) as { password?: string };

    if (!password || typeof password !== "string") {
      return NextResponse.json({ ok: false }, { status: 200 });
    }

    const { data, error } = await supabase
      .from("site_security_settings")
      .select("lockdown_password, lockdown_version")
      .eq("id", 1)
      .maybeSingle<{
        lockdown_password: string | null;
        lockdown_version: number | null;
      }>();

    if (error || !data || !data.lockdown_password) {
      console.error("verify-lockdown-password: error or no password set", error);
      return NextResponse.json({ ok: false }, { status: 200 });
    }

    // NOTE: you are currently storing plaintext.
    // If you later hash it, change this compare.
    const ok = password.trim() === data.lockdown_password;

    if (!ok) {
      return NextResponse.json({ ok: false }, { status: 200 });
    }

    return NextResponse.json(
      {
        ok: true,
        lockdown_version: data.lockdown_version ?? 1,
      },
      { status: 200 }
    );
  } catch (e) {
    console.error("verify-lockdown-password: unexpected error", e);
    return NextResponse.json({ ok: false }, { status: 200 });
  }
}
