// src/app/api/admin/users/donation-rank/route.ts
import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { getActorAccessFromRequest, routeServiceClient } from "@/lib/api/routeAuth";
import { DonationRankKey, isDonationRankKey } from "@/lib/donationRanks";

type Body = { userId?: unknown; donationRank?: unknown };

export async function POST(req: NextRequest) {
  const actor = await getActorAccessFromRequest(req);
  if (!actor) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!actor.permissions.has("users.donation_rank.set")) {
    return NextResponse.json({ ok: false, error: "Forbidden" }, { status: 403 });
  }

  let body: Body | null = null;
  try {
    body = (await req.json()) as Body;
  } catch {
    body = null;
  }

  const userId = typeof body?.userId === "string" ? body.userId : "";
  const donationRankRaw = body?.donationRank;

  const donationRank: DonationRankKey | null =
    donationRankRaw === null || donationRankRaw === ""
      ? null
      : isDonationRankKey(donationRankRaw)
        ? donationRankRaw
        : null;

  if (!userId) {
    return NextResponse.json({ ok: false, error: "Missing userId" }, { status: 400 });
  }

  // If the client sent an invalid rank string, reject explicitly.
  if (donationRankRaw && typeof donationRankRaw === "string" && donationRank === null) {
    return NextResponse.json({ ok: false, error: "Invalid donationRank" }, { status: 400 });
  }

  const { error } = await routeServiceClient
    .from("profiles")
    .update({ donation_rank: donationRank })
    .eq("id", userId);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
