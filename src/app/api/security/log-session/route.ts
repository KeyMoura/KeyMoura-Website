import { NextRequest, NextResponse } from "next/server";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";

/**
 * Logs a "session" touch for the current authenticated user.
 *
 * Why a server route?
 * - We need the real client IP (x-forwarded-for / x-real-ip)
 * - We want login event inserts to be service-role only
 * - We can safely throttle to avoid spam
 */
export async function POST(req: NextRequest) {
  const user = await requireUser(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rawXff = req.headers.get("x-forwarded-for") ?? "";
  const ip = (rawXff.split(",")[0] || req.headers.get("x-real-ip") || "").trim() || null;
  const userAgent = (req.headers.get("user-agent") || "").slice(0, 512) || null;
  const nowIso = new Date().toISOString();

  // Always update last_seen + last IP/UA (best-effort).
  // These columns were added in SQL step #1.
  await routeServiceClient
    .from("profiles")
    .update({ last_seen_at: nowIso, last_ip: ip as any, last_user_agent: userAgent })
    .eq("id", user.id);

  // Throttle inserts: if we already logged the same IP+UA within the last 6 hours, skip.
  const sinceIso = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const { data: recent } = await routeServiceClient
    .from("auth_login_events")
    .select("id")
    .eq("profile_id", user.id)
    .eq("event_type", "session")
    .eq("ip", ip as any)
    .eq("user_agent", userAgent)
    .gte("created_at", sinceIso)
    .limit(1);

  if (!recent || recent.length === 0) {
    await routeServiceClient.from("auth_login_events").insert({
      profile_id: user.id,
      event_type: "session",
      ip: ip as any,
      user_agent: userAgent,
      created_at: nowIso,
    });
  }

  return NextResponse.json({ ok: true });
}
