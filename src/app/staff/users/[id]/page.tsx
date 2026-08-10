"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import {
  Card,
  ErrorState,
  Fact,
  Facts,
  LoadingState,
  PageHeader,
  PageTabs,
  Section,
  StaffPage,
  StatusChip,
  TabPanel,
} from "@/components/staff/StaffPage";
import { UserAvatar } from "@/components/staff/UserAvatar";
import { UserPermissionOverrides } from "@/components/staff/UserPermissionOverrides";
import { UserProfileEditor } from "@/components/staff/UserProfileEditor";
import {
  ActivityPanel,
  CommunicationsPanel,
  NotesPanel,
  OrdersPanel,
  SupportPanel,
} from "@/components/staff/UserWorkspaceTabs";
import { Badge } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useHashTab } from "@/lib/hooks/useHashTab";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { MIN_STATUS_REASON_LENGTH, type StatusAction } from "@/lib/staff/userAccess";
import {
  ACCOUNT_STATUS_LABELS,
  ACCOUNT_STATUS_MEANING,
  formatCents,
  userDisplayLabel,
  type AccountStatus,
  type UserMetrics,
} from "@/lib/staff/userDirectory";

/**
 * One user, as a staff workspace.
 *
 * A persistent identity header answers "who is this" from every tab, and the
 * tabs answer the rest. The alternative — one long page — is what
 * `/staff/security/users` was, and finding a customer's order history on it
 * meant scrolling past a permissions matrix.
 *
 * Every control on this page is hidden when the viewer may not use it **and**
 * refused by the route if it is called anyway. The `viewer` block in the API
 * response drives the hiding; it is a courtesy to the person using the page, not
 * the security boundary. The boundary is the route.
 */

type Workspace = {
  user: {
    id: string;
    username: string | null;
    displayName: string | null;
    avatarUrl: string | null;
    email: string | null;
    emailConfirmed: boolean;
    bio: string | null;
    location: string | null;
    isVerified: boolean;
    donationRank: string | null;
    isOp: boolean;
    createdAt: string;
    lastSeenAt: string | null;
    lastSignInAt: string | null;
    roleKey: string;
    roleName: string;
    roleRank: number;
    isStaff: boolean;
    accountStatus: AccountStatus;
    providers: string[];
  };
  metrics: UserMetrics;
  status: {
    value: AccountStatus;
    banReason: string | null;
    bannedAt: string | null;
    restrictions: { kind: string; reason: string | null; createdAt: string; expiresAt: string | null }[];
  };
  latestOrder: { id: string; orderNumber: string | null; status: string; createdAt: string } | null;
  possibleGuestOrderCount: number;
  roles: { key: string; name: string; rank: number; isStaff: boolean }[];
  viewer: {
    isSelf: boolean;
    outranksViewer: boolean;
    assignableRoles: { key: string; name: string; rank: number; isStaff: boolean; dangerous: boolean }[];
    canAssignRole: boolean;
    canGrantPermissions: boolean;
    canEditProfile: boolean;
    canVerify: boolean;
    canSetDonationRank: boolean;
    canSuspend: boolean;
    canRestrict: boolean;
    canViewNotes: boolean;
    canWriteNotes: boolean;
    canViewOrders: boolean;
    canViewCommunications: boolean;
    canViewSupport: boolean;
    canViewActivity: boolean;
  };
};

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  email: "Email & password",
  google: "Google",
  facebook: "Facebook",
};

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "Never";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "Never";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function StaffUserWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("users.view") || permissions.has("users.search");

  const [token, setToken] = useState<string | null>(null);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: Workspace }
  >({ kind: "loading" });

  const load = useCallback(async () => {
    const supabase = supabaseBrowser();
    const { data: session } = await supabase.auth.getSession();
    const accessToken = session?.session?.access_token ?? null;
    if (!accessToken) {
      setState({ kind: "error", message: "You must be signed in." });
      return;
    }
    setToken(accessToken);

    try {
      const res = await fetch(`/api/staff/users/${id}`, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        setState({
          kind: "error",
          message:
            res.status === 404
              ? "No such user."
              : res.status === 403
                ? "You do not have permission to view this user."
                : "Could not load this user.",
        });
        return;
      }
      setState({ kind: "ready", data: (await res.json()) as Workspace });
    } catch {
      setState({ kind: "error", message: "Could not load this user." });
    }
  }, [id]);

  useEffect(() => {
    if (accessLoading || !canView) return;
    void load();
  }, [accessLoading, canView, load]);

  const workspace = state.kind === "ready" ? state.data : null;
  const viewer = workspace?.viewer;

  const tabs = useMemo(
    () => [
      { id: "overview", label: "Overview" },
      { id: "orders", label: "Orders", available: viewer?.canViewOrders !== false, count: workspace?.metrics.orderCount ?? null },
      // Beside Orders, because "what have they bought" and "what have they asked
      // us" are the two questions a staff member on the phone actually has.
      { id: "support", label: "Support", available: viewer?.canViewSupport === true },
      { id: "activity", label: "Activity", available: viewer?.canViewActivity === true },
      { id: "access", label: "Roles & access" },
      { id: "notes", label: "Notes", available: viewer?.canViewNotes === true },
      { id: "communications", label: "Communications", available: viewer?.canViewCommunications === true },
    ],
    [viewer, workspace]
  );

  const [activeTab, selectTab] = useHashTab(tabs);

  if (accessLoading) {
    return (
      <StaffPage>
        <LoadingState />
      </StaffPage>
    );
  }

  if (!canView) {
    return (
      <StaffPage>
        <AccessDeniedCard message="You do not have permission to view users." />
      </StaffPage>
    );
  }

  if (state.kind === "loading") {
    return (
      <StaffPage>
        <LoadingState />
      </StaffPage>
    );
  }

  if (state.kind === "error") {
    return (
      <StaffPage>
        <ErrorState onRetry={() => void load()}>{state.message}</ErrorState>
        <Link href="/staff/users" className="ui-btn ui-btn-secondary self-start">
          Back to people
        </Link>
      </StaffPage>
    );
  }

  const { user, metrics, status, latestOrder, possibleGuestOrderCount } = state.data;
  const auth = token ? { token } : null;

  return (
    <StaffPage>
      {/* --- persistent identity header ------------------------------------- */}
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <UserAvatar src={user.avatarUrl} label={userDisplayLabel(user)} size={44} />
            <span className="min-w-0">
              <span className="block truncate">{userDisplayLabel(user)}</span>
              {user.username ? (
                <span className="block truncate text-sm font-normal" style={{ color: "var(--muted)" }}>
                  @{user.username}
                </span>
              ) : null}
            </span>
          </span>
        }
        description={user.email ?? "No email on record"}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {latestOrder ? (
              <Link href={`/staff/orders/${latestOrder.id}`} className="ui-btn ui-btn-secondary">
                Open {latestOrder.orderNumber ?? "latest order"}
              </Link>
            ) : null}
            <Link href="/staff/users" className="ui-btn ui-btn-ghost">
              All people
            </Link>
          </div>
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Badge tone={user.isStaff ? "accent" : "neutral"}>{user.roleName}</Badge>
          {user.isStaff ? <Badge tone="accent">Staff</Badge> : <Badge tone="neutral">Customer</Badge>}
          {user.isOp ? <Badge tone="warning">Owner</Badge> : null}
          {user.isVerified ? <Badge tone="success">Verified</Badge> : null}
          <StatusChip
            value={status.value === "suspended" ? "failed" : status.value === "restricted" ? "pending" : "active"}
            label={ACCOUNT_STATUS_LABELS[status.value]}
          />
        </div>
      </PageHeader>

      <PageTabs tabs={tabs} value={activeTab} onChange={selectTab} ariaLabel="User workspace" />

      {/* --- Overview -------------------------------------------------------- */}
      <TabPanel id="overview" value={activeTab}>
        <Section headingLevel={3} title="Account">
          <Card>
            <Facts>
              <Fact label="Account ID">
                <span className="font-mono text-xs break-all">{user.id}</span>
              </Fact>
              <Fact label="Email">
                {user.email ?? "—"}
                {user.email ? (
                  <span className="ml-2 text-xs" style={{ color: "var(--muted)" }}>
                    {user.emailConfirmed ? "confirmed" : "unconfirmed"}
                  </span>
                ) : null}
              </Fact>
              <Fact label="Joined">{formatDate(user.createdAt)}</Fact>
              <Fact label="Last seen">{formatDateTime(user.lastSeenAt)}</Fact>
              <Fact label="Last sign-in">{formatDateTime(user.lastSignInAt)}</Fact>
              <Fact label="Location">{user.location ?? "—"}</Fact>
              <Fact label="Sign-in methods">
                {user.providers.length ? (
                  <span className="flex flex-wrap gap-1.5">
                    {user.providers.map((provider) => (
                      <Badge key={provider} tone="neutral">
                        {PROVIDER_LABELS[provider] ?? provider}
                      </Badge>
                    ))}
                  </span>
                ) : (
                  "—"
                )}
              </Fact>
              <Fact label="Account status">
                <span className="block">{ACCOUNT_STATUS_LABELS[status.value]}</span>
                <span className="block text-xs" style={{ color: "var(--muted)" }}>
                  {ACCOUNT_STATUS_MEANING[status.value]}
                </span>
              </Fact>
            </Facts>
          </Card>
        </Section>

        <Section
          headingLevel={3}
          title="Customer value"
          description="Money actually received on orders this account owns, less refunds. Unpaid quotes, abandoned checkouts and guest orders are not counted."
        >
          <Card>
            <Facts>
              <Fact label="Lifetime spend">
                <span className="text-lg tabular-nums">{formatCents(metrics.netSpendCents)}</span>
              </Fact>
              <Fact label="Total paid">{formatCents(metrics.paidCents)}</Fact>
              <Fact label="Refunded">{formatCents(metrics.refundedCents)}</Fact>
              <Fact label="Average order">
                {metrics.averageOrderValueCents === null ? "—" : formatCents(metrics.averageOrderValueCents)}
              </Fact>
              <Fact label="Orders">{metrics.orderCount}</Fact>
              <Fact label="Open">{metrics.openOrderCount}</Fact>
              <Fact label="Completed">{metrics.completedOrderCount}</Fact>
              <Fact label="Cancelled">{metrics.cancelledOrderCount}</Fact>
              <Fact label="Open production">{metrics.openProductionCount}</Fact>
              <Fact label="Last order">{formatDate(metrics.lastOrderAt)}</Fact>
            </Facts>
          </Card>
          {possibleGuestOrderCount > 0 ? (
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              {possibleGuestOrderCount} guest {possibleGuestOrderCount === 1 ? "order was" : "orders were"} placed with
              this email address. They are not owned by this account and are excluded from every figure above — see the
              Orders tab.
            </p>
          ) : null}
        </Section>

        {auth ? (
          <UserProfileEditor
            userId={id}
            token={auth.token}
            initial={{
              username: user.username,
              displayName: user.displayName,
              bio: user.bio,
              location: user.location,
              email: user.email,
              isVerified: user.isVerified,
              donationRank: user.donationRank,
            }}
            canEditProfile={state.data.viewer.canEditProfile}
            canVerify={state.data.viewer.canVerify}
            canSetDonationRank={state.data.viewer.canSetDonationRank}
            onChanged={() => void load()}
          />
        ) : null}

        {status.value !== "active" ? (
          <Section headingLevel={3} title="Why this account is limited">
            <Card>
              {status.banReason ? (
                <p className="text-sm">
                  <strong>Suspended:</strong> {status.banReason}{" "}
                  <span style={{ color: "var(--muted)" }}>({formatDate(status.bannedAt)})</span>
                </p>
              ) : null}
              {status.restrictions.map((restriction) => (
                <p key={`${restriction.kind}-${restriction.createdAt}`} className="text-sm">
                  <strong>{restriction.kind} restriction:</strong> {restriction.reason ?? "No reason recorded"}{" "}
                  <span style={{ color: "var(--muted)" }}>
                    ({formatDate(restriction.createdAt)}
                    {restriction.expiresAt ? ` — until ${formatDate(restriction.expiresAt)}` : " — no expiry"})
                  </span>
                </p>
              ))}
            </Card>
          </Section>
        ) : null}
      </TabPanel>

      {/* --- Orders ---------------------------------------------------------- */}
      <TabPanel id="orders" value={activeTab}>
        {auth ? <OrdersPanel userId={id} auth={auth} /> : <LoadingState />}
      </TabPanel>

      {/* --- Support --------------------------------------------------------- */}
      <TabPanel id="support" value={activeTab}>
        {auth ? <SupportPanel userId={id} auth={auth} /> : <LoadingState />}
      </TabPanel>

      {/* --- Activity -------------------------------------------------------- */}
      <TabPanel id="activity" value={activeTab}>
        {auth ? <ActivityPanel userId={id} auth={auth} /> : <LoadingState />}
      </TabPanel>

      {/* --- Roles & access -------------------------------------------------- */}
      <TabPanel id="access" value={activeTab}>
        {auth ? <AccessTab workspace={state.data} auth={auth} onChanged={() => void load()} /> : <LoadingState />}
      </TabPanel>

      {/* --- Notes ----------------------------------------------------------- */}
      <TabPanel id="notes" value={activeTab}>
        {auth ? <NotesPanel userId={id} auth={auth} canWrite={state.data.viewer.canWriteNotes} /> : <LoadingState />}
      </TabPanel>

      {/* --- Communications -------------------------------------------------- */}
      <TabPanel id="communications" value={activeTab}>
        {auth ? <CommunicationsPanel userId={id} auth={auth} /> : <LoadingState />}
      </TabPanel>
    </StaffPage>
  );
}

// ---------------------------------------------------------------------------
// Roles & access
// ---------------------------------------------------------------------------

function AccessTab({
  workspace,
  auth,
  onChanged,
}: {
  workspace: Workspace;
  auth: { token: string };
  onChanged: () => void;
}) {
  const { user, status, viewer } = workspace;

  const [nextRole, setNextRole] = useState(user.roleKey);
  const [roleBusy, setRoleBusy] = useState(false);
  const [roleMessage, setRoleMessage] = useState<string | null>(null);
  const [confirmRole, setConfirmRole] = useState(false);

  const [statusAction, setStatusAction] = useState<StatusAction>(
    status.value === "suspended" ? "unsuspend" : "suspend"
  );
  const [statusKind, setStatusKind] = useState<"site" | "community" | "dm">("site");
  const [reason, setReason] = useState("");
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);

  useEffect(() => setNextRole(user.roleKey), [user.roleKey]);

  const chosen = viewer.assignableRoles.find((r) => r.key === nextRole);
  const roleChanged = nextRole !== user.roleKey;

  const saveRole = async () => {
    setRoleBusy(true);
    setRoleMessage(null);
    try {
      const res = await fetch(`/api/staff/security/users/${user.id}/role`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        // The role the page believes is current, so a change decided against a
        // stale screen is refused rather than applied.
        body: JSON.stringify({ role: nextRole, expectedRole: user.roleKey }),
      });
      const json = (await res.json().catch(() => null)) as
        | { error?: string; requiresApproval?: boolean }
        | null;

      if (!res.ok) {
        setRoleMessage(json?.error ?? "Could not change the role.");
        return;
      }
      setRoleMessage(
        json?.requiresApproval
          ? "Admin role changes need a second admin. A request was filed in the approvals queue."
          : "Role updated."
      );
      onChanged();
    } finally {
      setRoleBusy(false);
      setConfirmRole(false);
    }
  };

  const saveStatus = async () => {
    setStatusBusy(true);
    setStatusMessage(null);
    try {
      const res = await fetch(`/api/staff/users/${user.id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${auth.token}` },
        body: JSON.stringify({
          action: statusAction,
          kind: statusKind,
          reason,
          expectedStatus: status.value,
        }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; pending?: boolean } | null;
      if (!res.ok) {
        setStatusMessage(json?.error ?? "Could not change the status.");
        return;
      }
      setStatusMessage(json?.pending ? "Filed for admin approval." : "Account status updated.");
      setReason("");
      onChanged();
    } finally {
      setStatusBusy(false);
    }
  };

  const reasonTooShort = reason.trim().length < MIN_STATUS_REASON_LENGTH;

  return (
    <>
      <Section headingLevel={3} title="Role" description="A user holds exactly one role. It decides their permissions.">
        <Card>
          <Facts>
            <Fact label="Current role">{user.roleName}</Fact>
            <Fact label="Level">{user.roleRank}</Fact>
            <Fact label="Staff access">{user.isStaff ? "Yes" : "No"}</Fact>
          </Facts>

          {viewer.canAssignRole ? (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <MenuSelect
                ariaLabel="New role"
                value={nextRole}
                /*
                 * The current role is always listed first, and is never in
                 * `assignableRoles` — a no-op assignment is refused with a 409,
                 * and the rank rules exclude anything at or above the actor's
                 * own level, which the target's current role often is. Without
                 * it the control has no option matching its value and renders
                 * an empty "Select", which reads as "this person has no role".
                 */
                options={[
                  { value: user.roleKey, label: `${user.roleName} (current)` },
                  ...viewer.assignableRoles
                    .filter((r) => r.key !== user.roleKey)
                    .map((r) => ({ value: r.key, label: r.name })),
                ]}
                onChange={(value) => {
                  setNextRole(value);
                  setConfirmRole(false);
                }}
              />
              {confirmRole ? (
                <>
                  <button
                    type="button"
                    className="ui-btn ui-btn-danger"
                    disabled={roleBusy}
                    onClick={() => void saveRole()}
                  >
                    {roleBusy ? "Applying…" : `Yes, make them ${chosen?.name ?? nextRole}`}
                  </button>
                  <button type="button" className="ui-chip" onClick={() => setConfirmRole(false)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={!roleChanged || roleBusy}
                  onClick={() => {
                    // Granting or removing staff standing asks first. Moving
                    // between two non-staff roles does not.
                    if (chosen?.dangerous) setConfirmRole(true);
                    else void saveRole();
                  }}
                >
                  Change role
                </button>
              )}
              {roleMessage ? (
                <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                  {roleMessage}
                </span>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
              {viewer.isSelf
                ? "You cannot change your own role. Ask another admin."
                : viewer.outranksViewer
                  ? "This person is at or above your own level, so you cannot change their role."
                  : "You do not have permission to assign roles."}
            </p>
          )}

          {confirmRole && chosen ? (
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              {chosen.isStaff && !user.isStaff
                ? "This grants staff access to the whole staff area."
                : !chosen.isStaff && user.isStaff
                  ? "This removes their staff access immediately."
                  : "This is a significant access change."}
            </p>
          ) : null}
        </Card>
      </Section>

      <Section
        headingLevel={3}
        title="Account status"
        description="Restriction and suspension are application-level. Supabase Auth is not modified, and transactional order email keeps going out either way."
      >
        <Card>
          <p className="text-sm">
            <strong>{ACCOUNT_STATUS_LABELS[status.value]}</strong> — {ACCOUNT_STATUS_MEANING[status.value]}
          </p>

          {viewer.canSuspend || viewer.canRestrict ? (
            <div className="mt-4 grid gap-2">
              <div className="flex flex-wrap items-center gap-2">
                <MenuSelect
                  ariaLabel="Status action"
                  value={statusAction}
                  options={[
                    ...(viewer.canSuspend
                      ? [
                          { value: "suspend", label: "Suspend account" },
                          { value: "unsuspend", label: "Lift suspension" },
                        ]
                      : []),
                    ...(viewer.canRestrict
                      ? [
                          { value: "restrict", label: "Apply restriction" },
                          { value: "unrestrict", label: "Lift restriction" },
                        ]
                      : []),
                  ]}
                  onChange={(value) => setStatusAction(value as StatusAction)}
                />
                {statusAction === "restrict" || statusAction === "unrestrict" ? (
                  <MenuSelect
                    ariaLabel="Restriction area"
                    value={statusKind}
                    options={[
                      { value: "site", label: "Site" },
                      { value: "community", label: "Community" },
                      { value: "dm", label: "Direct messages" },
                    ]}
                    onChange={(value) => setStatusKind(value as "site" | "community" | "dm")}
                  />
                ) : null}
              </div>

              <label className="sr-only" htmlFor="status-reason">
                Reason
              </label>
              <input
                id="status-reason"
                className="ui-input"
                placeholder="Why is this changing? Recorded in the audit log."
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  className="ui-btn ui-btn-danger"
                  disabled={statusBusy || reasonTooShort || viewer.isSelf}
                  onClick={() => void saveStatus()}
                >
                  {statusBusy ? "Applying…" : "Apply"}
                </button>
                <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                  {viewer.isSelf
                    ? "You cannot change your own account status."
                    : statusMessage ?? (reasonTooShort ? "A reason is required." : "")}
                </span>
              </div>
            </div>
          ) : (
            <p className="mt-3 text-xs" style={{ color: "var(--muted)" }}>
              You do not have permission to change account status.
            </p>
          )}
        </Card>
      </Section>

      <UserPermissionOverrides userId={user.id} token={auth.token} canGrant={viewer.canGrantPermissions} />

      <Section headingLevel={3} title="Sign-in methods" description="Read-only. Staff cannot unlink an identity here.">
        <Card>
          {user.providers.length ? (
            <span className="flex flex-wrap gap-1.5">
              {user.providers.map((provider) => (
                <Badge key={provider} tone="neutral">
                  {PROVIDER_LABELS[provider] ?? provider}
                </Badge>
              ))}
            </span>
          ) : (
            <p className="text-sm" style={{ color: "var(--muted)" }}>
              No linked sign-in methods on record.
            </p>
          )}
          <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
            Passwords, tokens and multi-factor settings are never shown here and cannot be edited from staff tools.
            Email is read-only because there is no verified change flow.
          </p>
        </Card>
      </Section>
    </>
  );
}
