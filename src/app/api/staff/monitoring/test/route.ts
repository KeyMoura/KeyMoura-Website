import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";

import { requirePermission } from "@/lib/api/routeAuth";

export async function POST(request: NextRequest) {
  const actor = await requirePermission(request, "security.view");
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const serverError = new Error("KeyMoura staff server monitoring test");
  Sentry.captureException(serverError, { tags: { source: "staff-monitoring-test", runtime: "server" } });
  await Sentry.flush(2_000);
  return NextResponse.json({ ok: true });
}
