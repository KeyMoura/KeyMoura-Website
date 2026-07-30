// app/api/forum/users/[targetUserId]/block/route.ts
import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

type BlockBody = {
  block?: boolean | null;
};

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ targetUserId: string }> }
) {
  try {
    // 🔹 Next 16: params is a Promise, so we must await it
    const { targetUserId: rawTarget } = await context.params;

    // 1) Auth
    const authHeader = req.headers.get("authorization");
    const token =
      authHeader && authHeader.startsWith("Bearer ")
        ? authHeader.slice("Bearer ".length)
        : null;

    if (!token) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const {
      data: { user },
      error: userError,
    } = await anonClient.auth.getUser(token);

    if (userError || !user || !(await isUserAdmitted(user.id))) {
      return NextResponse.json(
        { ok: false, error: "Unauthorized" },
        { status: 401 }
      );
    }

    const actorUserId = user.id;

    // 2) Params
    const targetUserId =
      typeof rawTarget === "string" && rawTarget.trim().length > 0
        ? rawTarget.trim()
        : null;

    if (!targetUserId) {
      return NextResponse.json(
        { ok: false, error: "Missing targetUserId." },
        { status: 400 }
      );
    }

    if (targetUserId === actorUserId) {
      return NextResponse.json(
        { ok: false, error: "You cannot block yourself." },
        { status: 400 }
      );
    }

    // 3) Body
    let body: BlockBody;
    try {
      body = (await req.json()) as BlockBody;
    } catch {
      body = {};
    }

    // Check current state
    const { data: existingRow, error: existingErr } = await serviceClient
      .from("user_blocks")
      .select("id")
      .eq("blocker_user_id", actorUserId)
      .eq("blocked_user_id", targetUserId)
      .maybeSingle<{ id: number }>();

    if (existingErr) {
      console.error("Error checking existing block row", existingErr);
      return NextResponse.json(
        { ok: false, error: "Failed to check block state." },
        { status: 500 }
      );
    }

    const currentlyBlocked = !!existingRow;
    const targetBlockedState =
      typeof body.block === "boolean" ? body.block : !currentlyBlocked;

    // 4) Apply desired state
    if (targetBlockedState) {
      // Ensure row exists
      const { error: upsertErr } = await serviceClient
        .from("user_blocks")
        .upsert(
          {
            blocker_user_id: actorUserId,
            blocked_user_id: targetUserId,
          },
          {
            onConflict: "blocker_user_id,blocked_user_id",
          }
        );

      if (upsertErr) {
        console.error("Error inserting/updating user_blocks row", upsertErr);
        return NextResponse.json(
          { ok: false, error: "Failed to block user." },
          { status: 500 }
        );
      }
} else {
      // Ensure row is removed
      const { error: deleteErr } = await serviceClient
        .from("user_blocks")
        .delete()
        .eq("blocker_user_id", actorUserId)
        .eq("blocked_user_id", targetUserId);

      if (deleteErr) {
        console.error("Error deleting user_blocks row", deleteErr);
        return NextResponse.json(
          { ok: false, error: "Failed to unblock user." },
          { status: 500 }
        );
      }
}

    return NextResponse.json(
      {
        ok: true,
        blocked: targetBlockedState,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error(
      "Unexpected error in /api/forum/users/[targetUserId]/block",
      err
    );
    return NextResponse.json(
      { ok: false, error: "Unexpected error updating block state." },
      { status: 500 }
    );
  }
}
