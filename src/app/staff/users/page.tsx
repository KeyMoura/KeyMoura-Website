"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { UserAvatar } from "@/components/staff/UserAvatar";
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Row,
  Rows,
  StaffPage,
  StatusChip,
} from "@/components/staff/StaffPage";
import { Badge } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_LABELS,
  ACTIVE_WITHIN_OPTIONS,
  formatCents,
  hasActiveUserFilters,
  LOGIN_PROVIDERS,
  parseUserFilters,
  USER_SORTS,
  USER_SORT_LABELS,
  userDisplayLabel,
  userFiltersToQuery,
  type UserDirectoryRow,
  type UserFilters,
  type UserSort,
} from "@/lib/staff/userDirectory";

/**
 * The staff user directory.
 *
 * Every filter lives in the URL and nowhere else, so a view is bookmarkable and
 * the back button agrees with the list. Filtering, sorting and paging happen on
 * the server — the browser never holds more than one page, which is the
 * difference between this and `/staff/security/users`, which it replaces.
 *
 * ## Rows, not a table
 *
 * A user carries eleven facts worth showing and a table with eleven columns is
 * unreadable at 1280px and impossible at 375px. So each user is a row with an
 * identity on the left and its numbers on the right, and the row reflows to a
 * single column on a phone rather than scrolling sideways. Everything else is
 * one click away on the workspace.
 */

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; users: UserDirectoryRow[]; total: number; hasMore: boolean; searchNote: string | null };

type RoleOption = { key: string; name: string };

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "3 days ago", for the activity column where the exact minute does not matter. */
function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return "Never";
  const days = Math.floor((Date.now() - parsed) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 30) return `${days} days ago`;
  // Pluralized rather than interpolated blind: a 40-day gap reads "1 months
  // ago" otherwise, which is the kind of small wrongness that makes a page
  // look untended.
  const months = Math.floor(days / 30);
  if (days < 365) return months === 1 ? "1 month ago" : `${months} months ago`;
  const years = Math.floor(days / 365);
  return years === 1 ? "1 year ago" : `${years} years ago`;
}

export default function StaffUsersPage() {
  return (
    <Suspense fallback={<StaffPage><LoadingState /></StaffPage>}>
      <UserDirectory />
    </Suspense>
  );
}

function UserDirectory() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("users.view") || permissions.has("users.search");

  const filters = useMemo(() => parseUserFilters(new URLSearchParams(searchParams.toString())), [searchParams]);

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [showMoreFilters, setShowMoreFilters] = useState(
    Boolean(filters.joinedFrom || filters.joinedTo || filters.provider || filters.activeWithinDays)
  );

  useEffect(() => setSearchDraft(filters.search), [filters.search]);

  const apply = useCallback(
    (next: Partial<UserFilters>) => {
      // Any filter change returns to page one. Staying on page 4 of a narrower
      // result set is how a filter appears to return nothing.
      const merged: Partial<UserFilters> = { ...filters, ...next, page: next.page ?? 1 };
      const query = userFiltersToQuery(merged);
      router.replace(query ? `/staff/users?${query}` : "/staff/users", { scroll: false });
    },
    [filters, router]
  );

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const supabase = supabaseBrowser();
      const { data: session } = await supabase.auth.getSession();
      const token = session?.session?.access_token;
      if (!token) {
        setState({ kind: "error", message: "You must be signed in." });
        return;
      }

      const query = userFiltersToQuery(filters);
      const res = await fetch(`/api/staff/users${query ? `?${query}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        // A refused query is never rendered as an empty list. "Nobody matched"
        // and "the server said no" look identical otherwise.
        setState({
          kind: "error",
          message: res.status === 403 ? "You do not have permission to view users." : "Could not load the directory.",
        });
        return;
      }

      const json = (await res.json()) as {
        users?: UserDirectoryRow[];
        total?: number;
        hasMore?: boolean;
        searchNote?: string | null;
      };

      setState({
        kind: "ready",
        users: Array.isArray(json.users) ? json.users : [],
        total: typeof json.total === "number" ? json.total : 0,
        hasMore: json.hasMore === true,
        searchNote: json.searchNote ?? null,
      });
    } catch {
      setState({ kind: "error", message: "Could not load the directory." });
    }
  }, [filters]);

  useEffect(() => {
    if (accessLoading || !canView) return;
    void load();
  }, [accessLoading, canView, load]);

  // The role filter's options come from the roles table, so a role somebody
  // created appears here without a code change.
  useEffect(() => {
    if (accessLoading || !canView) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/public/roles");
        if (!res.ok) return;
        const json = (await res.json()) as { roles?: { key?: unknown; name?: unknown; label?: unknown }[] };
        if (cancelled || !Array.isArray(json.roles)) return;
        setRoles(
          json.roles
            .filter((r): r is { key: string; name?: string; label?: string } => typeof r?.key === "string")
            .map((r) => ({ key: r.key, name: String(r.name ?? r.label ?? r.key) }))
        );
      } catch {
        /* The filter falls back to "All roles"; the list still works. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accessLoading, canView]);

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

  const roleOptions = [
    { value: "", label: "All roles" },
    ...roles.map((r) => ({ value: r.key, label: r.name })),
  ];

  return (
    <StaffPage>
      <PageHeader
        title="People & accounts"
        description="Staff and member accounts, what they have ordered, and what access they hold."
      />

      {/* --- search and filters ---------------------------------------------- */}
      <div className="staff-toolbar">
        <div className="staff-toolbar-search">
          <label className="sr-only" htmlFor="user-search">
            Search users
          </label>
          <input
            id="user-search"
            type="search"
            className="ui-input"
            placeholder="Name, username, email, user ID, or KM-0012"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") apply({ search: searchDraft.trim() });
            }}
          />
        </div>

        <button type="button" className="ui-btn ui-btn-secondary" onClick={() => apply({ search: searchDraft.trim() })}>
          Search
        </button>

        <MenuSelect
          ariaLabel="Filter by role"
          value={filters.role ?? ""}
          options={roleOptions}
          onChange={(value) => apply({ role: value || null })}
        />

        <MenuSelect
          ariaLabel="Filter by account type"
          value={filters.kind ?? ""}
          options={[
            { value: "", label: "Everyone" },
            { value: "staff", label: "Staff" },
            { value: "customer", label: "Customers" },
          ]}
          onChange={(value) => apply({ kind: (value || null) as UserFilters["kind"] })}
        />

        <MenuSelect
          ariaLabel="Filter by account status"
          value={filters.status ?? ""}
          options={[
            { value: "", label: "Any status" },
            ...ACCOUNT_STATUSES.map((s) => ({ value: s, label: ACCOUNT_STATUS_LABELS[s] })),
          ]}
          onChange={(value) => apply({ status: (value || null) as UserFilters["status"] })}
        />

        <MenuSelect
          ariaLabel="Filter by orders"
          value={filters.orders ?? ""}
          options={[
            { value: "", label: "Any orders" },
            { value: "has_orders", label: "Has orders" },
            { value: "no_orders", label: "No orders" },
          ]}
          onChange={(value) => apply({ orders: (value || null) as UserFilters["orders"] })}
        />

        <MenuSelect
          ariaLabel="Sort"
          value={filters.sort}
          options={USER_SORTS.map((s) => ({ value: s, label: USER_SORT_LABELS[s] }))}
          onChange={(value) => apply({ sort: value as UserSort })}
        />

        <button
          type="button"
          className="ui-chip"
          aria-expanded={showMoreFilters}
          onClick={() => setShowMoreFilters((open) => !open)}
        >
          {showMoreFilters ? "Fewer filters" : "More filters"}
        </button>

        {hasActiveUserFilters(filters) ? (
          <button type="button" className="ui-chip" onClick={() => router.replace("/staff/users", { scroll: false })}>
            Clear
          </button>
        ) : null}
      </div>

      {showMoreFilters ? (
        <div className="staff-toolbar">
          <MenuSelect
            ariaLabel="Filter by login provider"
            value={filters.provider ?? ""}
            options={[
              { value: "", label: "Any provider" },
              ...LOGIN_PROVIDERS.map((p) => ({ value: p, label: p === "email" ? "Email" : p === "google" ? "Google" : "Facebook" })),
            ]}
            onChange={(value) => apply({ provider: (value || null) as UserFilters["provider"] })}
          />

          <MenuSelect
            ariaLabel="Filter by recent activity"
            value={filters.activeWithinDays ? String(filters.activeWithinDays) : ""}
            options={[
              { value: "", label: "Any activity" },
              ...ACTIVE_WITHIN_OPTIONS.map((d) => ({
                value: String(d),
                label: d === 1 ? "Seen today" : `Seen in ${d} days`,
              })),
            ]}
            onChange={(value) => apply({ activeWithinDays: value ? Number(value) : null })}
          />

          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            Joined after
            <input
              type="date"
              className="ui-input"
              value={filters.joinedFrom ?? ""}
              onChange={(event) => apply({ joinedFrom: event.target.value || null })}
            />
          </label>

          <label className="flex items-center gap-2 text-xs" style={{ color: "var(--muted)" }}>
            Joined before
            <input
              type="date"
              className="ui-input"
              value={filters.joinedTo ?? ""}
              onChange={(event) => apply({ joinedTo: event.target.value || null })}
            />
          </label>
        </div>
      ) : null}

      {/* --- results ---------------------------------------------------------- */}
      {state.kind === "loading" ? <LoadingState /> : null}
      {state.kind === "error" ? <ErrorState onRetry={() => void load()}>{state.message}</ErrorState> : null}

      {state.kind === "ready" ? (
        <>
          {state.searchNote ? (
            <Card className="text-sm" style={{ color: "var(--muted)" }}>
              {state.searchNote}
            </Card>
          ) : null}

          {state.users.length === 0 ? (
            <EmptyState>
              {hasActiveUserFilters(filters) ? "No users match these filters." : "No users yet."}
            </EmptyState>
          ) : (
            <>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {state.total} {state.total === 1 ? "person" : "people"}
                {state.total > filters.pageSize
                  ? ` — page ${filters.page} of ${Math.ceil(state.total / filters.pageSize)}`
                  : ""}
              </p>

              <Rows>
                {state.users.map((user) => (
                  <Row
                    key={user.id}
                    href={`/staff/users/${user.id}`}
                    title={
                      <span className="flex items-center gap-2.5 min-w-0">
                        <UserAvatar
                          src={user.avatarUrl}
                          label={userDisplayLabel(user)}
                          size={32}
                        />
                        <span className="min-w-0">
                          <span className="block truncate">{userDisplayLabel(user)}</span>
                          {user.username ? (
                            <span className="block truncate text-xs font-normal" style={{ color: "var(--muted)" }}>
                              @{user.username}
                            </span>
                          ) : null}
                        </span>
                      </span>
                    }
                    detail={user.email ?? "No email on record"}
                    meta={
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span>Joined {formatWhen(user.createdAt)}</span>
                        <span>Seen {formatRelative(user.lastSeenAt)}</span>
                        {user.openProductionCount > 0 ? (
                          <span>
                            {user.openProductionCount} open {user.openProductionCount === 1 ? "job" : "jobs"}
                          </span>
                        ) : null}
                      </span>
                    }
                    aside={
                      <>
                        <Badge tone={user.isStaff ? "accent" : "neutral"}>{user.roleName}</Badge>
                        {user.isStaff ? <Badge tone="accent">Staff</Badge> : null}
                        {user.isVerified ? <Badge tone="success">Verified</Badge> : null}
                        {user.accountStatus !== "active" ? (
                          <StatusChip
                            value={user.accountStatus === "suspended" ? "failed" : "pending"}
                            label={ACCOUNT_STATUS_LABELS[user.accountStatus]}
                          />
                        ) : null}
                        <span className="text-right text-xs tabular-nums" style={{ color: "var(--muted)" }}>
                          <span className="block" style={{ color: "var(--text)" }}>
                            {formatCents(user.netSpendCents)}
                          </span>
                          <span className="block">
                            {user.orderCount} {user.orderCount === 1 ? "order" : "orders"}
                            {user.openOrderCount > 0 ? ` · ${user.openOrderCount} open` : ""}
                          </span>
                        </span>
                      </>
                    }
                  />
                ))}
              </Rows>

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary"
                  disabled={filters.page <= 1}
                  onClick={() => apply({ page: filters.page - 1 })}
                >
                  Previous
                </button>
                <span className="text-xs" style={{ color: "var(--muted)" }}>
                  Page {filters.page}
                </span>
                <button
                  type="button"
                  className="ui-btn ui-btn-secondary"
                  disabled={!state.hasMore}
                  onClick={() => apply({ page: filters.page + 1 })}
                >
                  Next
                </button>
              </div>
            </>
          )}
        </>
      ) : null}

      <p className="text-xs" style={{ color: "var(--muted)" }}>
        Spend counts money received on orders this account owns, less refunds. Guest orders are never included —{" "}
        <Link href="/staff/orders" className="underline">
          find those in orders
        </Link>
        .
      </p>
    </StaffPage>
  );
}
