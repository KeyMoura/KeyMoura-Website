"use client";

import { Suspense, useCallback, useEffect, useId, useMemo, useState } from "react";
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
  StaffPage,
  StatusChip,
} from "@/components/staff/StaffPage";
import { Badge } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  ACCOUNT_STATUS_LABELS,
  ACTIVE_WITHIN_OPTIONS,
  activeFilterChips,
  emptyUserFilters,
  formatCents,
  hasActiveUserFilters,
  LOGIN_PROVIDERS,
  LOGIN_PROVIDER_LABELS,
  parseUserFilters,
  segmentFilters,
  userDisplayLabel,
  userFiltersToQuery,
  userSegment,
  USER_SEGMENTS,
  USER_SEGMENT_LABELS,
  USER_SORTS,
  USER_SORT_LABELS,
  type UserDirectoryRow,
  type UserFilters,
  type UserSegment,
  type UserSort,
} from "@/lib/staff/userDirectory";

/**
 * People — the customer and staff directory.
 *
 * Every filter lives in the URL and nowhere else, so a view is bookmarkable and
 * the back button agrees with the list. Filtering, sorting and paging happen on
 * the server; the browser never holds more than one page.
 *
 * ## What this pass changed, and why
 *
 * The toolbar carried **eight** controls side by side and grew to twelve when
 * "More filters" was opened — 78px of controls at 1280 and 147px at 375, above
 * a list whose rows were 110px and 150px tall. A staff member looking for a
 * customer read a control panel first and people second.
 *
 * Now: one segmented control for the question actually asked (everyone /
 * customers / staff / restricted), a search box, a sort, and everything else
 * behind one Filters disclosure. What is currently narrowing the list is stated
 * as chips that can each be removed on their own, rather than as a single
 * "Clear" that also throws away the search.
 *
 * ## Rows, not a table
 *
 * A real `<table>` cannot make the whole row a link, and a link is what a
 * directory row is. So it is a grid that behaves like a table from 900px up —
 * name, access, money and activity in fixed columns that line up down the page —
 * and stacks into a card below that rather than scrolling sideways.
 */

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; users: UserDirectoryRow[]; total: number; hasMore: boolean; searchNote: string | null };

type RoleOption = { key: string; name: string };

/**
 * "3 days ago", for the activity column where the exact minute does not matter.
 *
 * The join date is deliberately not on the row. It answers a question nobody
 * scans a directory for, and it was competing with the one date that matters
 * here — when this person was last around.
 */
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
  const filterPanelId = useId();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("users.view") || permissions.has("users.search");

  const filters = useMemo(() => parseUserFilters(new URLSearchParams(searchParams.toString())), [searchParams]);

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [roles, setRoles] = useState<RoleOption[]>([]);
  const [showFilters, setShowFilters] = useState(
    Boolean(filters.joinedFrom || filters.joinedTo || filters.provider || filters.activeWithinDays || filters.role || filters.orders)
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

  const roleName = useCallback(
    (key: string) => roles.find((role) => role.key === key)?.name ?? key,
    [roles]
  );

  const chips = useMemo(() => activeFilterChips(filters, roleName), [filters, roleName]);
  const segment = userSegment(filters);

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

  const clearOne = (key: keyof UserFilters) => {
    const blank = emptyUserFilters();
    apply({ [key]: blank[key] } as Partial<UserFilters>);
  };

  return (
    <StaffPage>
      <PageHeader
        title="People"
        description="Manage customers, staff access, and account activity."
      />

      {/* --- who am I looking at -------------------------------------------- */}
      <div className="staff-views" role="group" aria-label="Show">
        {USER_SEGMENTS.map((id: UserSegment) => (
          <button
            key={id}
            type="button"
            className="staff-view"
            aria-pressed={segment === id}
            onClick={() => apply(segmentFilters(id))}
          >
            {USER_SEGMENT_LABELS[id]}
          </button>
        ))}
      </div>

      {/* --- search, sort, and everything else behind one control ------------ */}
      <div className="staff-toolbar">
        <div className="staff-toolbar-search">
          <label className="sr-only" htmlFor="user-search">
            Search people
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
          ariaLabel="Sort people"
          value={filters.sort}
          options={USER_SORTS.map((s) => ({ value: s, label: USER_SORT_LABELS[s] }))}
          onChange={(value) => apply({ sort: value as UserSort })}
        />

        {/* A button rather than a chip: this is now the only way to reach six
            filters, and `.ui-chip` renders as a 24px target on a phone. */}
        <button
          type="button"
          className="ui-btn ui-btn-secondary"
          aria-expanded={showFilters}
          aria-controls={filterPanelId}
          onClick={() => setShowFilters((open) => !open)}
        >
          {showFilters ? "Hide filters" : "Filters"}
        </button>
      </div>

      {showFilters ? (
        <div className="staff-filter-panel" id={filterPanelId}>
          <label className="ui-field">
            <span className="ui-label">Role</span>
            <MenuSelect
              ariaLabel="Filter by role"
              value={filters.role ?? ""}
              options={[{ value: "", label: "Any role" }, ...roles.map((r) => ({ value: r.key, label: r.name }))]}
              onChange={(value) => apply({ role: value || null })}
            />
          </label>

          <label className="ui-field">
            <span className="ui-label">Orders</span>
            <MenuSelect
              ariaLabel="Filter by orders"
              value={filters.orders ?? ""}
              options={[
                { value: "", label: "Any" },
                { value: "has_orders", label: "Has orders" },
                { value: "no_orders", label: "No orders" },
              ]}
              onChange={(value) => apply({ orders: (value || null) as UserFilters["orders"] })}
            />
          </label>

          <label className="ui-field">
            <span className="ui-label">Signs in with</span>
            <MenuSelect
              ariaLabel="Filter by login provider"
              value={filters.provider ?? ""}
              options={[
                { value: "", label: "Any method" },
                ...LOGIN_PROVIDERS.map((p) => ({ value: p, label: LOGIN_PROVIDER_LABELS[p] })),
              ]}
              onChange={(value) => apply({ provider: (value || null) as UserFilters["provider"] })}
            />
          </label>

          <label className="ui-field">
            <span className="ui-label">Recent activity</span>
            <MenuSelect
              ariaLabel="Filter by recent activity"
              value={filters.activeWithinDays ? String(filters.activeWithinDays) : ""}
              options={[
                { value: "", label: "Any time" },
                ...ACTIVE_WITHIN_OPTIONS.map((d) => ({
                  value: String(d),
                  label: d === 1 ? "Seen today" : `Seen in ${d} days`,
                })),
              ]}
              onChange={(value) => apply({ activeWithinDays: value ? Number(value) : null })}
            />
          </label>

          <label className="ui-field">
            <span className="ui-label">Joined after</span>
            <input
              type="date"
              className="ui-input"
              value={filters.joinedFrom ?? ""}
              onChange={(event) => apply({ joinedFrom: event.target.value || null })}
            />
          </label>

          <label className="ui-field">
            <span className="ui-label">Joined before</span>
            <input
              type="date"
              className="ui-input"
              value={filters.joinedTo ?? ""}
              onChange={(event) => apply({ joinedTo: event.target.value || null })}
            />
          </label>
        </div>
      ) : null}

      {chips.length ? (
        <div className="staff-filter-chips">
          {chips.map((chip) => (
            <span key={String(chip.key)} className="staff-filter-chip">
              <span className="staff-filter-chip-label">{chip.label}:</span>
              <span>{chip.value}</span>
              <button
                type="button"
                className="staff-filter-chip-remove"
                aria-label={`Remove ${chip.label} filter`}
                onClick={() => clearOne(chip.key)}
              >
                ×
              </button>
            </span>
          ))}
          <button type="button" className="ui-chip" onClick={() => router.replace("/staff/users", { scroll: false })}>
            Clear all
          </button>
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
              {hasActiveUserFilters(filters) ? "Nobody matches these filters." : "No people yet."}
            </EmptyState>
          ) : (
            <>
              <p className="text-xs" style={{ color: "var(--muted)" }}>
                {state.total} {state.total === 1 ? "person" : "people"}
                {state.total > filters.pageSize
                  ? ` — page ${filters.page} of ${Math.ceil(state.total / filters.pageSize)}`
                  : ""}
              </p>

              <div className="staff-people">
                {/* Captions for the columns that exist from 900px up. Hidden
                    below that, where the row is a stacked card and a caption
                    row would name columns that are not there. */}
                <div className="staff-people-head" aria-hidden="true">
                  <span />
                  <span>Person</span>
                  <span>Access</span>
                  <span>Orders &amp; spend</span>
                  <span>Last seen</span>
                </div>

                {state.users.map((user) => {
                  const label = userDisplayLabel(user);
                  // An account with no name falls back to its address, and
                  // printing the address again underneath is the row saying the
                  // same thing twice.
                  const secondary = label === user.email ? "No name on record" : user.email ?? "No email on record";
                  return (
                  <Link key={user.id} href={`/staff/users/${user.id}`} className="staff-person">
                    <span className="staff-person-avatar">
                      <UserAvatar src={user.avatarUrl} label={label} size={32} />
                    </span>

                    <span className="staff-person-identity">
                      <span className="staff-person-name">{label}</span>
                      <span className="staff-person-email">{secondary}</span>
                    </span>

                    <span className="staff-person-role">
                      <Badge tone={user.isStaff ? "accent" : "neutral"}>{user.roleName}</Badge>
                      {user.accountStatus !== "active" ? (
                        <StatusChip
                          value={user.accountStatus === "suspended" ? "failed" : "pending"}
                          label={ACCOUNT_STATUS_LABELS[user.accountStatus]}
                        />
                      ) : null}
                    </span>

                    <span className="staff-person-commerce">
                      <strong>{formatCents(user.netSpendCents)}</strong>
                      {" · "}
                      {user.orderCount} {user.orderCount === 1 ? "order" : "orders"}
                      {user.openOrderCount > 0 ? ` (${user.openOrderCount} open)` : ""}
                    </span>

                    <span className="staff-person-seen">{formatRelative(user.lastSeenAt)}</span>
                  </Link>
                  );
                })}
              </div>

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
