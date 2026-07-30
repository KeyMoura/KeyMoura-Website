import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export async function GET(req: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    // Security checks fail open, but missing configuration must not make the
    // route module throw while Next.js is collecting routes during a build.
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("ip-check: Supabase environment is not configured");
      return NextResponse.json({ banned: false, reason: null }, { status: 200 });
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Try to get the client IP from common proxy headers
    const forwardedFor = req.headers.get("x-forwarded-for") ?? "";
    const realIp = req.headers.get("x-real-ip") ?? "";

    let ip = "";

    if (forwardedFor) {
      // "ip1, ip2, ..." -> take the first one
      ip = forwardedFor.split(",")[0].trim();
    } else if (realIp) {
      ip = realIp.trim();
    }

    // If we can't see an IP, fail open (not banned)
    if (!ip) {
      return NextResponse.json(
        { banned: false, reason: null },
        { status: 200 }
      );
    }

    const { data, error } = await supabase.rpc("get_ip_ban_detail", {
      ip,
    });

    if (error) {
      console.error("ip-check: get_ip_ban_detail error", error);
      return NextResponse.json(
        { banned: false, reason: null },
        { status: 200 }
      );
    }

    // get_ip_ban_detail returns a table -> supabase-js gives us an array
    let banned = false;
    let reason: string | null = null;

    if (Array.isArray(data) && data.length > 0) {
      const row = data[0] as { banned: boolean; reason: string | null };
      banned = !!row.banned;
      reason = row.reason ?? null;
    }

    return NextResponse.json(
      {
        banned,
        reason,
      },
      { status: 200 }
    );
  } catch (e) {
    console.error("ip-check: unexpected error", e);
    // Fail open on error: don't lock legit users out because of a bug
    return NextResponse.json(
      { banned: false, reason: null },
      { status: 200 }
    );
  }
}
