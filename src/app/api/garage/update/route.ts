import { isUserAdmitted } from "@/lib/accountAdmission";
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { hardBlockIfProfane } from "@/lib/profanity";

type SiteSecuritySettingsRow = {
  maintenance_mode: boolean | null;
};

type GarageCarRow = {
  id: string;
  owner_id: string;
};

export async function POST(req: NextRequest) {
  try {
    // --- Auth: Bearer token required ---
    const authHeader = req.headers.get("authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return NextResponse.json(
        { error: "Missing or invalid Authorization header." },
        { status: 401 }
      );
    }

    const accessToken = authHeader.slice("Bearer ".length).trim();
    if (!accessToken) {
      return NextResponse.json(
        { error: "Missing access token." },
        { status: 401 }
      );
    }

    const {
      data: { user },
      error: userError,
    } = await supabaseAdmin.auth.getUser(accessToken);

    if (userError || !user || !(await isUserAdmitted(user.id))) {
      console.error("garage/update: failed to get user from token", userError);
      return NextResponse.json(
        { error: "Invalid or expired session." },
        { status: 401 }
      );
    }

    const userId = user.id;

    // --- Check maintenance mode (server-side) ---
    const { data: securityRow, error: securityError } = await supabaseAdmin
      .from("site_security_settings")
      .select("maintenance_mode")
      .eq("id", 1)
      .maybeSingle<SiteSecuritySettingsRow>();

    if (!securityError && securityRow?.maintenance_mode) {
      return NextResponse.json(
        {
          error:
            "Garage is temporarily read-only while the site is in maintenance mode.",
        },
        { status: 503 }
      );
    }

    // --- Parse body ---
    const body = await req.json();

    const {
      id,
      name,
      make,
      model,
      year,
      chassis,
      trim,
      color,
      engine,
      power_hp,
      torque_ftlb,
      weight_lb,
      use_type,
      visibility,
      summary,
      mods,
      cover_image_url,
    } = body as {
      id: string;
      name?: string | null;
      make?: string | null;
      model?: string | null;
      year?: number | null;
      chassis?: string | null;
      trim?: string | null;
      color?: string | null;
      engine?: string | null;
      power_hp?: number | null;
      torque_ftlb?: number | null;
      weight_lb?: number | null;
      use_type?: string | null;
      visibility?: string | null;
      summary?: string | null;
      mods?: string | null;
      cover_image_url?: string | null;
    };

    if (!id || typeof id !== "string") {
      return NextResponse.json(
        { error: "Missing or invalid car id." },
        { status: 400 }
      );
    }

    // Universal profanity hard-block (fail closed)
    for (const field of [name ?? "", make ?? "", model ?? "", chassis ?? "", trim ?? "", color ?? "", engine ?? "", summary ?? "", mods ?? ""]) {
      const prof = await hardBlockIfProfane(field);
      if ("error" in prof) {
        return NextResponse.json({ error: prof.error }, { status: 400 });
      }
    }

    // --- Make sure this car exists and belongs to this user ---
    const { data: carRow, error: carError } = await supabaseAdmin
      .from("garage_cars")
      .select("id, owner_id")
      .eq("id", id)
      .maybeSingle<GarageCarRow>();

    if (carError) {
      console.error("garage/update: failed to load car", carError);
      return NextResponse.json(
        { error: "Failed to load car." },
        { status: 500 }
      );
    }

    if (!carRow) {
      return NextResponse.json({ error: "Car not found." }, { status: 404 });
    }

    if (carRow.owner_id !== userId) {
      return NextResponse.json(
        { error: "You don’t have permission to edit this car." },
        { status: 403 }
      );
    }

    // --- Prepare update payload ---
    const updatePayload: Record<string, unknown> = {
      name: name?.trim() || null,
      make: make?.trim() || null,
      model: model?.trim() || null,
      year: year ?? null,
      chassis: chassis?.trim() || null,
      trim: trim?.trim() || null,
      color: color?.trim() || null,
      engine: engine?.trim() || null,
      power_hp: power_hp ?? null,
      torque_ftlb: torque_ftlb ?? null,
      weight_lb: weight_lb ?? null,
      use_type: (use_type ?? "street") as string,
      visibility: (visibility ?? "public") as string,
      summary: summary?.trim() || null,
      mods: mods?.trim() || null,
      cover_image_url: cover_image_url ?? null,
    };

    const { error: updateError } = await supabaseAdmin
      .from("garage_cars")
      .update(updatePayload)
      .eq("id", id)
      .eq("owner_id", userId);

    if (updateError) {
      console.error("garage/update: failed to update car", updateError);
      return NextResponse.json(
        { error: "Failed to save changes." },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true }, { status: 200 });
  } catch (err) {
    console.error("garage/update: unexpected error", err);
    return NextResponse.json(
      { error: "Unexpected error while saving changes." },
      { status: 500 }
    );
  }
}
