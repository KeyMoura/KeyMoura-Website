import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { sanitizeSupabaseError } from "@/lib/installer/readiness";

export async function GET(req: Request) {
  try {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

    // Missing configuration must not make the route module throw while Next.js
    // is collecting routes, but it must never be reported as a successful check.
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("ip-check: Supabase environment is not configured");
      return NextResponse.json({ error: "IP security check is unavailable." }, { status: 503 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey, {
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
      console.error("ip-check: get_ip_ban_detail failed", sanitizeSupabaseError(error));
      return NextResponse.json({ error: "IP security check is unavailable." }, { status: 503 });
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
    console.error(
      "ip-check: unexpected error",
      sanitizeSupabaseError(e instanceof Error ? e : { message: String(e) })
    );
    return NextResponse.json({ error: "IP security check is unavailable." }, { status: 503 });
  }
}
