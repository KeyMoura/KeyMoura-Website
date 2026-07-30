import { NextRequest, NextResponse } from "next/server";

import { getUserFromRequest } from "@/lib/api/routeAuth";
import { getActorRole } from "../../_shared";

export async function POST(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Purge is intentionally disabled. Items are permanently deleted only by expiry.
  await getActorRole(user.id);
  return NextResponse.json(
    { error: "Purge is disabled. Items are permanently deleted only after they expire." },
    { status: 403 }
  );
}
