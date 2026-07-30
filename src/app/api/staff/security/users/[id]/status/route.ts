import { NextRequest, NextResponse } from "next/server";
import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";

type Ctx = { params: Promise<{ id: string }> };

type BanRow = { active: boolean | null; reason: string | null };
type RestrictionRow = { kind: string; active: boolean | null; expires_at: string | null };

/**
 * Returns moderation/security status for a user (active ban + active site restriction).
 */
export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await requireAnyPermission(req, [
    "users.search",
    "moderation.ban",
    "moderation.ban.request",
    "moderation.restrict",
  ]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!id) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const [banRes, siteRes, communityRes, dmRes] = await Promise.all([
    routeServiceClient
      .from("user_bans")
      .select("active,reason")
      .eq("user_id", id)
      .eq("active", true)
      .maybeSingle<BanRow>(),
    routeServiceClient
      .from("user_restrictions")
      .select("kind,active,expires_at")
      .eq("user_id", id)
      .eq("kind", "site")
      .eq("active", true)
      .maybeSingle<RestrictionRow>(),
    routeServiceClient
      .from("user_restrictions")
      .select("kind,active,expires_at")
      .eq("user_id", id)
      .eq("kind", "community")
      .eq("active", true)
      .maybeSingle<RestrictionRow>(),
    routeServiceClient
      .from("user_restrictions")
      .select("kind,active,expires_at")
      .eq("user_id", id)
      .eq("kind", "dm")
      .eq("active", true)
      .maybeSingle<RestrictionRow>(),
  ]);

  const { data: banRow, error: banErr } = banRes;
  const { data: siteRow, error: siteErr } = siteRes;
  const { data: communityRow, error: communityErr } = communityRes;
  const { data: dmRow, error: dmErr } = dmRes;

  if (banErr) {
    console.error("status ban query error", banErr);
    return NextResponse.json({ error: "Failed to read ban status." }, { status: 500 });
  }

  if (siteErr || communityErr || dmErr) {
    console.error("status restriction query error", { siteErr, communityErr, dmErr });
    return NextResponse.json({ error: "Failed to read restriction status." }, { status: 500 });
  }

  const banActive = Boolean(banRow?.active);
  const banReason = banRow?.reason ?? null;
  const siteRestrictionActive = Boolean(siteRow?.active);
  const communityRestrictionActive = Boolean(communityRow?.active);
  const dmRestrictionActive = Boolean(dmRow?.active);

  const siteRestrictionExpiresAt = siteRow?.expires_at ?? null;
  const communityRestrictionExpiresAt = communityRow?.expires_at ?? null;
  const dmRestrictionExpiresAt = dmRow?.expires_at ?? null;

  return NextResponse.json(
    {
      ok: true,
      userId: id,
      ban_active: banActive,
      ban_reason: banReason,
      site_restriction_active: siteRestrictionActive,
      site_restriction_expires_at: siteRestrictionExpiresAt,
      community_restriction_active: communityRestrictionActive,
      community_restriction_expires_at: communityRestrictionExpiresAt,
      dm_restriction_active: dmRestrictionActive,
      dm_restriction_expires_at: dmRestrictionExpiresAt,
    },
    { status: 200 }
  );
}
