// src/app/api/garage/new/route.ts
import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { hardBlockIfProfane } from "@/lib/profanity";
import { requireUser } from "@/lib/api/routeAuth";

type GarageNewRequest = {
  owner_id: string;
  year: number | null;
  make: string;
  model: string;
  chassis: string | null;
  trim: string | null;
  color: string | null;
  engine: string | null;
  power_hp: number | null;
  torque_ftlb: number | null;
  weight_lb: number | null;
  summary: string | null;
  mods: string | null;
  use_type: string;
  visibility: "public" | "unlisted" | "private";
  is_primary: boolean;
  cover_image_url: string | null;
};

type GarageNewResponse =
  | { id: string }
  | { error: string };

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!user) return NextResponse.json<GarageNewResponse>({ error: "You must be logged in to add a car." }, { status: 401 });
    let body: GarageNewRequest;
    try {
      body = (await req.json()) as GarageNewRequest;
    } catch (e) {
      console.error("garage/new: failed to parse body", e);
      return NextResponse.json<GarageNewResponse>(
        { error: "Invalid request body." },
        { status: 400 }
      );
    }

    const {
      owner_id,
      year,
      make,
      model,
      chassis,
      trim,
      color,
      engine,
      power_hp,
      torque_ftlb,
      weight_lb,
      summary,
      mods,
      use_type,
      visibility,
      is_primary,
      cover_image_url,
    } = body;

    if (!owner_id || owner_id !== user.id) {
      return NextResponse.json<GarageNewResponse>(
        { error: "You cannot create a garage entry for another user." },
        { status: 403 }
      );
    }

    if (!make || !model) {
      return NextResponse.json<GarageNewResponse>(
        { error: "Please enter at least make and model." },
        { status: 400 }
      );
    }

    // Universal profanity hard-block (fail closed)
    for (const field of [make, model, chassis ?? "", trim ?? "", color ?? "", engine ?? "", summary ?? "", mods ?? ""]) {
      const prof = await hardBlockIfProfane(field);
      if ("error" in prof) {
        return NextResponse.json<GarageNewResponse>({ error: prof.error }, { status: 400 });
      }
    }

    if (year && (year < 1900 || year > 2100)) {
      return NextResponse.json<GarageNewResponse>(
        { error: "Please enter a valid year." },
        { status: 400 }
      );
    }

    // Maintenance mode via flags
    const { data: flagsData, error: flagsError } =
      await supabaseAdmin.rpc("get_site_lockdown_flags");

    if (!flagsError && flagsData && flagsData.length > 0) {
      const row = flagsData[0] as { maintenance_mode?: boolean };
      if (row.maintenance_mode) {
        return NextResponse.json<GarageNewResponse>(
          {
            error:
              "Garage is temporarily read-only while the site is in maintenance mode.",
          },
          { status: 503 }
        );
      }
    }

    // If marking as primary, clear existing primary for this owner
    if (is_primary) {
      const { error: clearError } = await supabaseAdmin
        .from("garage_cars")
        .update({ is_primary: false })
        .eq("owner_id", owner_id);

      if (clearError) {
        console.error(
          "garage/new: failed to clear existing primary",
          clearError
        );
        // Not fatal, we keep going
      }
    }

    const { data: insertData, error: insertError } = await supabaseAdmin
      .from("garage_cars")
      .insert({
        owner_id,
        year,
        make,
        model,
        chassis,
        trim,
        color,
        engine,
        power_hp,
        torque_ftlb,
        weight_lb,
        summary,
        mods,
        use_type,
        visibility,
        is_primary,
        cover_image_url,
      })
      .select("id")
      .single();

    if (insertError) {
      console.error("garage/new: insert error", insertError);
      return NextResponse.json<GarageNewResponse>(
        { error: "Failed to create car. Please try again." },
        { status: 500 }
      );
    }

    if (!insertData?.id) {
      console.error("garage/new: insert returned no id", insertData);
      return NextResponse.json<GarageNewResponse>(
        { error: "Car created but missing id from response." },
        { status: 500 }
      );
    }

    return NextResponse.json<GarageNewResponse>(
      { id: insertData.id },
      { status: 201 }
    );
  } catch (e) {
    console.error("garage/new: unexpected error", e);
    return NextResponse.json<GarageNewResponse>(
      { error: "Unexpected error creating car." },
      { status: 500 }
    );
  }
}
