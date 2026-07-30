import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

import { hardBlockIfProfane } from "@/lib/profanity";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

type Body = {
  threadId: string;
  body: string;
};

function jsonError(status: number, message: string) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  // Auth via Authorization: Bearer <token>
  const authHeader = req.headers.get("authorization");
  const token =
    authHeader && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : null;

  if (!token) return jsonError(401, "Unauthorized");

  const {
    data: { user },
    error: userError,
  } = await anonClient.auth.getUser(token);

  if (userError || !user || !(await isUserAdmitted(user.id))) return jsonError(401, "Unauthorized");

  let bodyJson: unknown;
  try {
    bodyJson = await req.json();
  } catch {
    return jsonError(400, "Invalid JSON body.");
  }

  const payload = bodyJson as Partial<Body>;
  const threadId = (payload.threadId ?? "").trim();
  const body = (payload.body ?? "").trim();

  if (!threadId) return jsonError(400, "threadId is required.");
  if (!body) return jsonError(400, "Message is required.");
  if (body.length > 4000) return jsonError(400, "Message is too long.");

  // Profanity hard-block
  const prof = await hardBlockIfProfane(body);
  if ("error" in prof) return jsonError(400, prof.error);

  // Rate limit: 50 messages per hour
  const oneHourAgoIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount, error: countErr } = await serviceClient
    .from("dm_messages")
    .select("id", { count: "exact", head: true })
    .eq("created_by", user.id)
    .eq("is_deleted", false)
    .gte("created_at", oneHourAgoIso);

  if (countErr) {
    console.error("Failed to check DM rate limit", countErr);
  } else if ((recentCount ?? 0) >= 50) {
    return jsonError(429, "Rate limit: 50 messages per hour. Please wait and try again.");
  }

  // Call the DB RPC as the authenticated user (enforces block rules, membership, etc.)
  const authedClient = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { error: sendErr } = await authedClient.rpc("dm_send_message", {
    p_thread_id: threadId,
    p_body: body,
  });

  if (sendErr) {
    console.error("dm_send_message failed", sendErr);
    return jsonError(
      sendErr.message?.toLowerCase().includes("blocked")
        ? 403
        : 500,
      sendErr.message?.toLowerCase().includes("blocked")
        ? "You can’t message this user."
        : "Failed to send message."
    );
  }

  return NextResponse.json({ ok: true });
}
