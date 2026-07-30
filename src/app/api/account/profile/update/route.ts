import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUser, routeServiceClient } from "@/lib/api/routeAuth";
import { hardBlockIfProfane } from "@/lib/profanity";

const bodySchema = z.object({
  display_name: z.string().trim().max(40).nullable().optional(),
  bio: z.string().trim().max(400).nullable().optional(),
  location: z.string().trim().max(60).nullable().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await requireUser(req);
    if (!user) {
      return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
    }

    const json = await req.json().catch(() => null);
    const parsed = bodySchema.safeParse(json);
    if (!parsed.success) {
      return NextResponse.json({ ok: false, error: "Invalid payload" }, { status: 400 });
    }

    const { display_name, bio, location } = parsed.data;

    const combined = [display_name, bio, location]
      .filter((v) => typeof v === "string" && v.trim().length)
      .join("\n\n");

    const prof = await hardBlockIfProfane(combined);
    if ("error" in prof) {
      return NextResponse.json({ ok: false, error: prof.error }, { status: 400 });
    }

    const payload: Record<string, unknown> = {};
    if (display_name !== undefined) payload["display_name"] = display_name;
    if (bio !== undefined) payload["bio"] = bio;
    if (location !== undefined) payload["location"] = location;

    const { error } = await routeServiceClient
      .from("profiles")
      .update(payload)
      .eq("id", user.id);

    if (error) {
      console.error(error);
      return NextResponse.json({ ok: false, error: "Failed to update profile." }, { status: 500 });
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("account profile update error", e);
    return NextResponse.json({ ok: false, error: "Server error" }, { status: 500 });
  }
}
