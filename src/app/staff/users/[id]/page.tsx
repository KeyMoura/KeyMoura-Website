"use client";

import { use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import {
  ErrorState,
  LoadingState,
  PageHeader,
  PageTabs,
  StaffPage,
  StatusChip,
  TabPanel,
} from "@/components/staff/StaffPage";
import { UserAccessTab } from "@/components/staff/UserAccessTab";
import { UserAvatar } from "@/components/staff/UserAvatar";
import { UserOverviewTab } from "@/components/staff/UserOverviewTab";
import {
  ActivityPanel,
  NotesPanel,
  OrdersPanel,
  SupportPanel,
} from "@/components/staff/UserWorkspaceTabs";
import { Badge } from "@/components/ui/DesignSystem";
import { useHashTab } from "@/lib/hooks/useHashTab";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import { ACCOUNT_STATUS_LABELS, formatCents, userDisplayLabel } from "@/lib/staff/userDirectory";
import type { UserWorkspace } from "@/lib/staff/userWorkspace";

/**
 * One person, as a staff workspace.
 *
 * ## What this pass changed
 *
 * **Seven tabs became six.** At 375px the strip was 681px of content in a 342px
 * box — half of it unreachable, with nothing signalling a sideways scroll.
 * "Roles & access" became **Access**, and **Communications became a view inside
 * Activity**: email history is a short list of things that happened to this
 * account, which is what Activity already is. Its permission gate is unchanged.
 *
 * **The primary actions are in the header.** They used to be scattered — a note
 * was added inside Notes, a role changed inside Access, an email re-sent inside
 * Communications, with nothing on the header saying any of it existed. The
 * header now names the four things somebody opens this page to do and takes them
 * to the tab that does it.
 *
 * **The header carries the numbers.** Orders, spend, open work and support are
 * the facts a staff member on the phone needs before they read anything else, so
 * they are visible from every tab rather than only from Overview.
 *
 * Every control is hidden when the viewer may not use it **and** refused by the
 * route if it is called anyway. The `viewer` block drives the hiding; it is a
 * courtesy to the person using the page, not the security boundary. The boundary
 * is the route.
 */

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatRelative(iso: string | null): string {
  if (!iso) return "never";
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return "never";
  const days = Math.floor((Date.now() - parsed) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const months = Math.floor(days / 30);
  if (days < 365) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export default function StaffUserWorkspacePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("users.view") || permissions.has("users.search");

  const [token, setToken] = useState<string | null>(null);
  const [noteRequested, setNoteRequested] = useState(false);
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: UserWorkspace }
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
      setState({ kind: "ready", data: (await res.json()) as UserWorkspace });
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
      {
        id: "orders",
        label: "Orders",
        available: viewer?.canViewOrders !== false,
        count: workspace?.metrics.orderCount ?? null,
      },
      // Beside Orders, because "what have they bought" and "what have they asked
      // us" are the two questions a staff member on the phone actually has.
      { id: "support", label: "Support", available: viewer?.canViewSupport === true },
      { id: "access", label: "Access" },
      { id: "notes", label: "Notes", available: viewer?.canViewNotes === true },
      // Communications lives inside Activity as a view, gated separately on
      // `canViewCommunications` — see `ActivityPanel`.
      { id: "activity", label: "Activity", available: viewer?.canViewActivity === true },
    ],
    [viewer, workspace]
  );

  const [activeTab, selectTab] = useHashTab(tabs);

  const openTab = useCallback(
    (next: string) => {
      selectTab(next);
      if (next !== "notes") setNoteRequested(false);
    },
    [selectTab]
  );

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
          Back to People
        </Link>
      </StaffPage>
    );
  }

  const { user, metrics, status, latestOrder, openSupportCount } = state.data;
  const auth = token ? { token } : null;
  const displayName = userDisplayLabel(user);

  return (
    <StaffPage>
      {/* --- persistent identity header ------------------------------------- */}
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <UserAvatar src={user.avatarUrl} label={displayName} size={44} />
            <span className="min-w-0">
              <span className="block truncate">{displayName}</span>
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
                Latest order {latestOrder.orderNumber ?? ""}
              </Link>
            ) : null}
            {state.data.viewer.canWriteNotes ? (
              <button
                type="button"
                className="ui-btn ui-btn-secondary"
                onClick={() => {
                  setNoteRequested(true);
                  selectTab("notes");
                }}
              >
                Add note
              </button>
            ) : null}
            <button type="button" className="ui-btn ui-btn-secondary" onClick={() => openTab("access")}>
              Manage access
            </button>
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
          <StatusChip
            value={status.value === "suspended" ? "failed" : status.value === "restricted" ? "pending" : "active"}
            label={ACCOUNT_STATUS_LABELS[status.value]}
          />
          <span className="text-xs" style={{ color: "var(--muted)" }}>
            Member since {formatDate(user.createdAt)} · last active {formatRelative(user.lastSeenAt)}
          </span>
        </div>

        {/*
         * The numbers, from every tab.
         *
         * `openSupportCount` is `null` when the viewer may not read support at
         * all, and that is rendered as "—" rather than as 0. A zero somebody is
         * not allowed to see is a claim, not a fact.
         */}
        <dl className="staff-metric-strip">
          <div>
            <dt>Orders</dt>
            <dd>{metrics.orderCount}</dd>
          </div>
          <div>
            <dt>Spend</dt>
            <dd>{formatCents(metrics.netSpendCents)}</dd>
          </div>
          <div>
            <dt>Open</dt>
            <dd>{metrics.openOrderCount}</dd>
          </div>
          <div>
            <dt>Refunded</dt>
            <dd>{formatCents(metrics.refundedCents)}</dd>
          </div>
          <div>
            <dt>Support</dt>
            <dd>{openSupportCount === null ? <span className="staff-metric-quiet">—</span> : openSupportCount}</dd>
          </div>
        </dl>
      </PageHeader>

      <PageTabs
        tabs={tabs}
        value={activeTab}
        onChange={openTab}
        ariaLabel="Person workspace"
        className="ui-tabs-wrap"
      />

      {/* --- Overview -------------------------------------------------------- */}
      <TabPanel id="overview" value={activeTab}>
        {auth ? (
          <UserOverviewTab
            workspace={state.data}
            auth={auth}
            onOpenTab={openTab}
            onChanged={() => void load()}
          />
        ) : (
          <LoadingState />
        )}
      </TabPanel>

      {/* --- Orders ---------------------------------------------------------- */}
      <TabPanel id="orders" value={activeTab}>
        {auth ? <OrdersPanel userId={id} auth={auth} /> : <LoadingState />}
      </TabPanel>

      {/* --- Support --------------------------------------------------------- */}
      <TabPanel id="support" value={activeTab}>
        {auth ? <SupportPanel userId={id} auth={auth} /> : <LoadingState />}
      </TabPanel>

      {/* --- Access ---------------------------------------------------------- */}
      <TabPanel id="access" value={activeTab}>
        {auth ? <UserAccessTab workspace={state.data} auth={auth} onChanged={() => void load()} /> : <LoadingState />}
      </TabPanel>

      {/* --- Notes ----------------------------------------------------------- */}
      <TabPanel id="notes" value={activeTab}>
        {auth ? (
          <NotesPanel
            userId={id}
            auth={auth}
            canWrite={state.data.viewer.canWriteNotes}
            autoFocusComposer={noteRequested}
          />
        ) : (
          <LoadingState />
        )}
      </TabPanel>

      {/* --- Activity, with Communications inside it -------------------------- */}
      <TabPanel id="activity" value={activeTab}>
        {auth ? (
          <ActivityPanel
            userId={id}
            auth={auth}
            canViewCommunications={state.data.viewer.canViewCommunications}
          />
        ) : (
          <LoadingState />
        )}
      </TabPanel>
    </StaffPage>
  );
}
