import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest, requestHasPermission } from "@/lib/api/routeAuth";
import { listPendingAdminActionRequests } from "@/lib/adminApprovals";

export async function GET(req: NextRequest) {
  const user = await getUserFromRequest(req);
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canManage = await requestHasPermission(req, "security.approvals.manage");
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const url = new URL(req.url);
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : 50;
  const safeLimit = Number.isFinite(limit) ? limit : 50;

  const result = await listPendingAdminActionRequests(safeLimit);
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: 500 });
  }

  return NextResponse.json({ rows: result.rows }, { status: 200 });
}
