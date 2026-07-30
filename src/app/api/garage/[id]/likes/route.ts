// app/api/garage/[id]/likes/route.ts
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

function isUuid(v: string): boolean {
  return /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/.test(v);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!isUuid(id)) {
      return NextResponse.json({ error: "Invalid id." }, { status: 400 });
    }

    const { count, error: countErr } = await serviceClient
      .from("garage_car_likes")
      .select("car_id", { count: "exact", head: true })
      .eq("car_id", id);

    if (countErr) {
      console.error("garage likes count error", countErr);
      return NextResponse.json({ error: "Failed to load likes." }, { status: 500 });
    }

    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.toLowerCase().startsWith("bearer ")
      ? authHeader.slice(7).trim()
      : null;

    let liked = false;
    if (token) {
      const {
        data: { user },
      } = await anonClient.auth.getUser(token);

      if (user?.id) {
        if (!(await isUserAdmitted(user.id))) {
          return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
        }
        const { data: row, error: rowErr } = await serviceClient
          .from("garage_car_likes")
          .select("car_id")
          .eq("car_id", id)
          .eq("user_id", user.id)
          .maybeSingle();

        if (!rowErr && row) liked = true;
      }
    }

    return NextResponse.json({ ok: true, count: count ?? 0, liked });
  } catch (e) {
    console.error("garage likes GET error", e);
    return NextResponse.json({ error: "Failed to load likes." }, { status: 500 });
  }
}
