// app/api/garage/[id]/like/route.ts
import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { createNotification } from "@/lib/notifications";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const anonClient = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { persistSession: false },
});

const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: { persistSession: false },
});

function isUuid(v: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(
    v
  );
}

const LIKE_MILESTONES = new Set<number>([
  1, 5, 10, 50, 100, 500, 1000, 5000, 10000, 25000, 50000, 100000,
]);

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: "Invalid id." }, { status: 400 });
    }

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const {
      data: { user },
      error: userErr,
    } = await anonClient.auth.getUser(token);

    if (userErr || !user || !(await isUserAdmitted(user.id))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Load car owner (for notifications)
    const { data: carRow, error: carErr } = await serviceClient
      .from("garage_cars")
      .select("id, owner_id")
      .eq("id", id)
      .maybeSingle<{ id: string; owner_id: string }>();

    if (carErr || !carRow) {
      return NextResponse.json({ error: "Car not found." }, { status: 404 });
    }

    // Check existing like (table uses composite PK: car_id + user_id)
    const { data: existing, error: existingErr } = await serviceClient
      .from("garage_car_likes")
      .select("car_id")
      .eq("car_id", id)
      .eq("user_id", user.id)
      .maybeSingle<{ car_id: string }>();

    if (existingErr && existingErr.code !== "PGRST116") {
      console.error("garage like lookup error", existingErr);
      return NextResponse.json({ error: "Failed to toggle like." }, { status: 500 });
    }

    let didLike = false;

    if (existing?.car_id) {
      const { error: delErr } = await serviceClient
        .from("garage_car_likes")
        .delete()
        .eq("car_id", id)
        .eq("user_id", user.id);

      if (delErr) {
        console.error("garage unlike error", delErr);
        return NextResponse.json({ error: "Failed to toggle like." }, { status: 500 });
      }

      didLike = false;
    } else {
      const { error: insErr } = await serviceClient.from("garage_car_likes").insert({
        car_id: id,
        user_id: user.id,
      });

      if (insErr) {
        console.error("garage like insert error", insErr);
        return NextResponse.json({ error: "Failed to toggle like." }, { status: 500 });
      }

      didLike = true;
    }

    // Count likes
    const { count, error: countErr } = await serviceClient
      .from("garage_car_likes")
      .select("car_id", { count: "exact", head: true })
      .eq("car_id", id);

    if (countErr) {
      console.error("garage likes count error", countErr);
      return NextResponse.json({ ok: true, liked: didLike, count: 0 });
    }

    const likeCount = count ?? 0;

    // Milestone notification (only on like, and not to self)
    if (didLike && carRow.owner_id !== user.id && LIKE_MILESTONES.has(likeCount)) {
      void createNotification({
        recipientUserId: carRow.owner_id,
        actorUserId: user.id,
        type: "garage_like",
        payload: {
          milestone: likeCount,
          car_id: id,
          href: `/garage/${id}`,
        },
      });
    }

    return NextResponse.json({ ok: true, liked: didLike, count: likeCount });
  } catch (e) {
    console.error("garage like POST error", e);
    return NextResponse.json({ error: "Failed to toggle like." }, { status: 500 });
  }
}
