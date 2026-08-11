import { NextRequest, NextResponse } from "next/server";

import { requireAnyPermission, routeServiceClient } from "@/lib/api/routeAuth";
import { assignableRoles, isDangerousRoleChange } from "@/lib/staff/userAccess";
import {
  averageOrderValueCents,
  isUserUuid,
  type AccountStatus,
  type UserMetrics,
} from "@/lib/staff/userDirectory";

/**
 * One user, assembled for `/staff/users/[id]`.
 *
 * Everything the identity header and the Overview tab need arrives in a single
 * response, so the workspace does not open with six spinners racing each other.
 * The heavier per-tab lists — orders, activity, communications, notes — stay on
 * their own routes and load when their tab does.
 *
 * ## What is deliberately not here
 *
 * No password hash, no provider tokens, no `raw_user_meta_data`, no MFA state.
 * The directory view already names its `auth` columns one at a time rather than
 * selecting `u.*`, and this route re-states that boundary rather than trusting
 * it: `providers` is a list of provider *names*, and nothing else from
 * `auth.identities` is read at all.
 */

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

type DirectoryRow = {
  id: string;
  username: string | null;
  display_name: string | null;
  avatar_url: string | null;
  email: string | null;
  email_confirmed: boolean | null;
  last_sign_in_at: string | null;
  is_verified: boolean | null;
  donation_rank: string | null;
  is_op: boolean | null;
  karma: number | null;
  created_at: string;
  last_seen_at: string | null;
  role_key: string | null;
  role_name: string | null;
  role_rank: number | null;
  is_staff: boolean | null;
  account_status: string | null;
  providers: string[] | null;
  order_count: number | null;
  completed_order_count: number | null;
  open_order_count: number | null;
  cancelled_order_count: number | null;
  paid_order_count: number | null;
  paid_cents: number | null;
  refunded_cents: number | null;
  net_spend_cents: number | null;
  last_order_at: string | null;
  open_production_count: number | null;
};

type RoleRow = { key: string; name: string; rank: number; is_staff: boolean };

export async function GET(req: NextRequest, ctx: Ctx) {
  const actor = await requireAnyPermission(req, ["users.view", "users.search"]);
  if (!actor) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await ctx.params;
  if (!isUserUuid(id)) return NextResponse.json({ error: "Invalid user id" }, { status: 400 });

  const [directoryRes, profileRes, rolesRes, actorRoleRes] = await Promise.all([
    routeServiceClient.from("staff_user_directory").select("*").eq("id", id).maybeSingle<DirectoryRow>(),
    routeServiceClient.from("profiles").select("bio,location").eq("id", id).maybeSingle<{
      bio: string | null;
      location: string | null;
    }>(),
    routeServiceClient.from("roles").select("key,name,rank,is_staff").order("rank", { ascending: false }),
    routeServiceClient.from("roles").select("rank").eq("key", actor.role).maybeSingle<{ rank: number | null }>(),
  ]);

  if (directoryRes.error) {
    console.error("[staff/users/:id] load failed", {
      code: (directoryRes.error as { code?: string }).code ?? null,
      message: (directoryRes.error as { message?: string }).message?.slice(0, 300) ?? null,
    });
    return NextResponse.json({ error: "Could not load this user." }, { status: 500 });
  }

  const row = directoryRes.data;
  if (!row) return NextResponse.json({ error: "User not found" }, { status: 404 });

  const roles = (rolesRes.data ?? []) as RoleRow[];
  const actorRank = actor.isOp ? Number.MAX_SAFE_INTEGER : actorRoleRes.data?.rank ?? 0;

  /*
   * What each role can do, and what this person holds on top of it.
   *
   * The Access tab needs both to answer "what can this person actually do" and
   * to say what a role change would cost, and fetching them here rather than
   * from the client saves two round trips and, more importantly, avoids
   * coupling the answer to `roles.manage` — the role-permission list route
   * requires it, and a viewer holding only `permissions.grant` would have been
   * shown an empty matrix rather than a refusal.
   *
   * Gated on being allowed to see role definitions at all. `null` rather than
   * an empty object, so the page can say "not shown" instead of drawing a
   * matrix in which everybody appears to have nothing.
   */
  const mayReadRoleDefinitions =
    actor.permissions.has("roles.view") ||
    actor.permissions.has("roles.manage") ||
    actor.permissions.has("permissions.grant");

  let rolePermissions: Record<string, string[]> | null = null;
  let permissionOverrides: string[] | null = null;

  if (mayReadRoleDefinitions) {
    const [rolePermRes, overrideRes] = await Promise.all([
      routeServiceClient.from("role_permissions").select("role_key,permission_key"),
      routeServiceClient.from("user_permissions").select("permission_key").eq("user_id", id),
    ]);

    const byRole: Record<string, string[]> = {};
    for (const role of roles) byRole[role.key] = [];
    for (const row of (rolePermRes.data ?? []) as { role_key: string; permission_key: string }[]) {
      (byRole[row.role_key] ??= []).push(row.permission_key);
    }
    rolePermissions = byRole;
    permissionOverrides = ((overrideRes.data ?? []) as { permission_key: string }[]).map(
      (row) => row.permission_key
    );
  }

  // --- status detail --------------------------------------------------------
  const [banRes, restrictionRes] = await Promise.all([
    routeServiceClient
      .from("user_bans")
      .select("reason,created_at")
      .eq("user_id", id)
      .eq("active", true)
      .order("created_at", { ascending: false })
      .limit(1),
    routeServiceClient
      .from("user_restrictions")
      .select("kind,reason,created_at,expires_at")
      .eq("user_id", id)
      .eq("active", true)
      .order("created_at", { ascending: false }),
  ]);

  const ban = (banRes.data ?? [])[0] as { reason: string | null; created_at: string } | undefined;
  const restrictions = (restrictionRes.data ?? []) as {
    kind: string;
    reason: string | null;
    created_at: string;
    expires_at: string | null;
  }[];

  // --- the most recent order, for the "Open latest order" link ---------------
  const { data: latestOrder } = await routeServiceClient
    .from("orders")
    .select("id,order_number,status,created_at")
    .eq("customer_id", id)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; order_number: string | null; status: string; created_at: string }>();

  /*
   * Guest orders whose email matches — counted, never claimed.
   *
   * This is informational and staff-only. It is not used for authorization, it
   * is not added to any metric, and the response calls it `possibleGuestOrders`
   * rather than anything that sounds like ownership. Email equality is a claim
   * anybody who can type can make; treating it as proof is how one person's
   * order history ends up on another person's account.
   */
  let possibleGuestOrderCount = 0;
  if (row.email) {
    const { count } = await routeServiceClient
      .from("orders")
      .select("id", { count: "exact", head: true })
      .is("customer_id", null)
      .ilike("guest_email", row.email);
    possibleGuestOrderCount = typeof count === "number" ? count : 0;
  }

  /*
   * The two summary slices the Overview needs, bounded and gated.
   *
   * Both are here rather than on the client so the workspace opens with one
   * request instead of three racing each other, and both are capped — Overview
   * shows three notes and a count, so it asks for three notes and a count. The
   * full lists stay on their own tabs behind their own routes.
   */
  const mayReadNotes =
    actor.permissions.has("users.notes.view") || actor.permissions.has("users.notes.manage");

  const [openSupportRes, recentNotesRes] = await Promise.all([
    actor.permissions.has("support.view")
      ? routeServiceClient
          .from("support_conversations")
          .select("id", { count: "exact", head: true })
          .eq("customer_id", id)
          .in("status", ["open", "waiting_on_staff", "waiting_on_customer"])
      : Promise.resolve({ count: null }),
    mayReadNotes
      ? routeServiceClient
          .from("user_staff_notes")
          .select("id,author_label,body,category,created_at")
          .eq("user_id", id)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(3)
      : Promise.resolve({ data: null }),
  ]);

  const openSupportCount =
    typeof (openSupportRes as { count?: number | null }).count === "number"
      ? (openSupportRes as { count: number }).count
      : null;

  const recentNotes = ((recentNotesRes as { data?: unknown }).data ?? null) as
    | { id: string; author_label: string; body: string; category: string; created_at: string }[]
    | null;

  const metrics: UserMetrics = {
    orderCount: row.order_count ?? 0,
    completedOrderCount: row.completed_order_count ?? 0,
    openOrderCount: row.open_order_count ?? 0,
    cancelledOrderCount: row.cancelled_order_count ?? 0,
    paidOrderCount: row.paid_order_count ?? 0,
    paidCents: row.paid_cents ?? 0,
    refundedCents: row.refunded_cents ?? 0,
    netSpendCents: row.net_spend_cents ?? 0,
    averageOrderValueCents: averageOrderValueCents(row.net_spend_cents ?? 0, row.paid_order_count ?? 0),
    lastOrderAt: row.last_order_at,
    openProductionCount: row.open_production_count ?? 0,
  };

  const targetRank = row.role_rank ?? 0;
  const outranksViewer = !actor.isOp && targetRank >= actorRank;

  return NextResponse.json({
    user: {
      id: row.id,
      username: row.username,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
      email: row.email,
      emailConfirmed: row.email_confirmed === true,
      bio: profileRes.data?.bio ?? null,
      location: profileRes.data?.location ?? null,
      isVerified: row.is_verified === true,
      donationRank: row.donation_rank,
      isOp: row.is_op === true,
      karma: row.karma ?? 0,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      lastSignInAt: row.last_sign_in_at,
      roleKey: row.role_key ?? "member",
      roleName: row.role_name ?? "Member",
      roleRank: targetRank,
      isStaff: row.is_staff === true,
      accountStatus: (row.account_status ?? "active") as AccountStatus,
      providers: Array.isArray(row.providers) ? row.providers : [],
    },

    metrics,

    status: {
      value: (row.account_status ?? "active") as AccountStatus,
      banReason: ban?.reason ?? null,
      bannedAt: ban?.created_at ?? null,
      restrictions: restrictions.map((r) => ({
        kind: r.kind,
        reason: r.reason,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    },

    latestOrder: latestOrder
      ? {
          id: latestOrder.id,
          orderNumber: latestOrder.order_number,
          status: latestOrder.status,
          createdAt: latestOrder.created_at,
        }
      : null,

    possibleGuestOrderCount,

    /** `null` when the viewer may not read support at all — never 0. */
    openSupportCount,

    recentNotes:
      recentNotes?.map((note) => ({
        id: note.id,
        authorLabel: note.author_label,
        body: note.body,
        category: note.category,
        createdAt: note.created_at,
      })) ?? null,

    roles: roles.map((r) => ({ key: r.key, name: r.name, rank: r.rank, isStaff: r.is_staff })),

    /**
     * `{ roleKey: [permission, …] }` for every role, and this person's own
     * override rows. Both `null` when the viewer may not read role definitions.
     */
    rolePermissions,
    permissionOverrides,

    /*
     * What *this* viewer may do, decided on the server.
     *
     * The UI hides controls from these flags, but every one of them is checked
     * again by the route that performs the action. Hiding a button is a courtesy
     * to the person using the page, not a security boundary — the pass-19 rule
     * that navigation visibility is not authorization applies to buttons too.
     */
    viewer: {
      isSelf: actor.userId === row.id,
      outranksViewer,
      assignableRoles: assignableRoles(
        { roleRank: actorRank, isOp: actor.isOp === true, permissions: actor.permissions },
        roles.map((r) => ({ key: r.key, rank: r.rank, name: r.name, isStaff: r.is_staff }))
      ).map((r) => ({
        key: r.key,
        name: r.name,
        rank: r.rank,
        isStaff: r.isStaff,
        dangerous: isDangerousRoleChange({
          currentIsStaff: row.is_staff === true,
          nextIsStaff: r.isStaff,
          nextRoleKey: r.key,
        }),
      })),
      canAssignRole: actor.permissions.has("roles.assign") && !outranksViewer && actor.userId !== row.id,
      canGrantPermissions: actor.permissions.has("permissions.grant"),
      canEditProfile: actor.permissions.has("users.profile.edit") && (!outranksViewer || actor.userId === row.id),
      canVerify: actor.permissions.has("users.verify"),
      canSetDonationRank: actor.permissions.has("users.donation_rank.set"),
      canSuspend: actor.permissions.has("moderation.ban") || actor.permissions.has("moderation.ban.request"),
      canRestrict: actor.permissions.has("moderation.restrict") || actor.permissions.has("moderation.restrict.request"),
      canViewNotes: actor.permissions.has("users.notes.view") || actor.permissions.has("users.notes.manage"),
      canWriteNotes: actor.permissions.has("users.notes.manage"),
      canViewOrders: actor.permissions.has("orders.view"),
      canViewProduction: actor.permissions.has("production.view"),
      canViewCommunications: actor.permissions.has("emails.view"),
      canViewSupport: actor.permissions.has("support.view"),
      canResendEmail: actor.permissions.has("emails.resend"),
      canViewActivity: actor.permissions.has("audit.view") || actor.permissions.has("audit.read"),
      canViewIpLogs: actor.permissions.has("security.ip_logs.view"),
    },
  });
}
