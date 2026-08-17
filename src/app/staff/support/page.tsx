"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  Row,
  Rows,
  StaffPage,
} from "@/components/staff/StaffPage";
import { Badge, Field } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_SHORT,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABELS,
  formatSupportAge,
  type SupportPriority,
  type SupportStatus,
} from "@/lib/support/domain";
import {
  SUPPORT_SORTS,
  SUPPORT_SORT_LABELS,
  SUPPORT_VIEW_LABELS,
  hasActiveSupportFilters,
  parseSupportFilters,
  supportFiltersToQuery,
  type SupportFilters,
  type SupportInboxRow,
  type SupportView,
} from "@/lib/support/filters";

/**
 * The support inbox.
 *
 * ## An inbox, not a table
 *
 * A conversation carries a dozen facts worth showing, and a twelve-column table
 * is unreadable at 1280px and impossible at 375px. So each conversation is a row
 * — who, what, and how long they have been waiting on the left; state on the
 * right — and it reflows to one column on a phone rather than scrolling
 * sideways. The workspace holds everything else.
 *
 * ## The chips are the page
 *
 * Six views, each a real query, with a count that is computed in Postgres rather
 * than by bucketing the current page. `Needs attention` is the default because
 * "somebody is waiting on us" is the only question this page exists to answer,
 * and a count that changed as you paged would make it useless.
 *
 * A count that could not be computed renders as `—`, never as `0`. "Nothing
 * needs attention" and "we could not find out" must not look identical.
 *
 * ## Every filter is in the URL
 *
 * So a view is bookmarkable, the back button agrees with the list, and
 * `/staff/support?customer=<id>` and `?order=<id>` — the links from the user and
 * order workspaces — are ordinary states of this page rather than a second one.
 */

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | {
      kind: "ready";
      conversations: SupportInboxRow[];
      total: number;
      hasMore: boolean;
      searchNote: string | null;
      counts: Record<string, number | null> | null;
    };

/** The chips, in the order a support desk works them. */
const VIEWS: readonly { id: SupportView; countKey?: string }[] = [
  { id: "needs_attention", countKey: "needs_attention" },
  { id: "waiting_on_customer", countKey: "waiting_on_customer" },
  { id: "unassigned", countKey: "unassigned" },
  { id: "mine", countKey: "mine" },
  { id: "high_priority", countKey: "high_priority" },
  { id: "resolved" },
  { id: "all" },
];

const STATUS_TONE: Readonly<Record<SupportStatus, "neutral" | "accent" | "warning" | "danger" | "success">> = {
  open: "warning",
  waiting_on_staff: "warning",
  waiting_on_customer: "accent",
  resolved: "success",
  closed: "neutral",
};

const PRIORITY_TONE: Readonly<Record<SupportPriority, "neutral" | "accent" | "warning" | "danger" | "success">> = {
  urgent: "danger",
  high: "warning",
  normal: "neutral",
  low: "neutral",
};

export default function StaffSupportPage() {
  return (
    <Suspense
      fallback={
        <StaffPage>
          <LoadingState />
        </StaffPage>
      }
    >
      <SupportInbox />
    </Suspense>
  );
}

function SupportInbox() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("support.view");

  const filters = useMemo(
    () => parseSupportFilters(new URLSearchParams(searchParams.toString())),
    [searchParams]
  );

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [showMoreFilters, setShowMoreFilters] = useState(
    Boolean(filters.createdFrom || filters.createdTo || filters.category || filters.priority)
  );

  /*
   * The search box follows the URL, without an effect.
   *
   * Adjusting state during render is the documented pattern for "reset a
   * controlled input when the thing it mirrors changes" — React re-renders
   * immediately with the new value and never commits the stale one. An effect
   * would paint the old text first and then correct it, which is a visible
   * flicker when you press the back button.
   */
  const [urlSearch, setUrlSearch] = useState(filters.search);
  if (urlSearch !== filters.search) {
    setUrlSearch(filters.search);
    setSearchDraft(filters.search);
  }

  const apply = useCallback(
    (next: Partial<SupportFilters>) => {
      // Any change returns to page one. Staying on page four of a narrower result
      // set is how a filter appears to return nothing.
      const merged: Partial<SupportFilters> = { ...filters, ...next, page: next.page ?? 1 };
      const query = supportFiltersToQuery(merged);
      router.replace(query ? `/staff/support?${query}` : "/staff/support", { scroll: false });
    },
    [filters, router]
  );

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    try {
      const { data: session } = await supabaseBrowser().auth.getSession();
      const token = session?.session?.access_token;
      if (!token) {
        setState({ kind: "error", message: "You must be signed in." });
        return;
      }

      const query = supportFiltersToQuery(filters);
      const res = await fetch(`/api/staff/support${query ? `?${query}` : ""}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!res.ok) {
        // A refused query is never rendered as an empty inbox.
        setState({
          kind: "error",
          message:
            res.status === 403
              ? "You do not have permission to view support conversations."
              : "Could not load the support inbox.",
        });
        return;
      }

      const json = (await res.json()) as {
        conversations?: SupportInboxRow[];
        total?: number;
        hasMore?: boolean;
        searchNote?: string | null;
        counts?: Record<string, number | null> | null;
      };

      setState({
        kind: "ready",
        conversations: Array.isArray(json.conversations) ? json.conversations : [],
        total: typeof json.total === "number" ? json.total : 0,
        hasMore: json.hasMore === true,
        searchNote: json.searchNote ?? null,
        counts: json.counts ?? null,
      });
    } catch {
      setState({ kind: "error", message: "Could not load the support inbox." });
    }
  }, [filters]);

  useEffect(() => {
    if (accessLoading || !canView) return;
    // Deferred by a tick so the "loading" state is not set synchronously inside
    // the effect body, which cascades a render. The same shape the order
    // workspace uses.
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [accessLoading, canView, load]);

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
        <AccessDeniedCard message="You do not have permission to view support conversations." />
      </StaffPage>
    );
  }

  const counts = state.kind === "ready" ? state.counts : null;

  return (
    <StaffPage>
      <PageHeader
        title="Support"
        description="Everything a customer has asked us, and where each conversation stands."
      />

      {/*
        --- the views -------------------------------------------------------

        `.staff-view`, the same pill `/staff/orders`, `/staff/fulfillment`,
        `/staff/production`, `/staff/inventory`, `/staff/users` and the dashboard
        already use for exactly this job: switching a queue between saved views.

        This page used to render the role as a row of `.ui-btn` — an outlined
        secondary button that filled solid gold when selected, at a button's
        height and a button's weight. That is the treatment the *actions* on
        every other staff page wear, so the busiest control on Support looked
        like seven primary actions, and its selected state shouted where the
        rest of the application whispers. Nothing here is a new pattern; the
        page is joining the one that already had eight callers.

        `aria-pressed` and the count behaviour are unchanged, including `—` for
        a count that could not be computed.
      */}
      <nav className="staff-views" aria-label="Support views">
        {VIEWS.map((view) => {
          const active = filters.view === view.id;
          const count = view.countKey && counts ? counts[view.countKey] : undefined;
          return (
            <button
              key={view.id}
              type="button"
              aria-pressed={active}
              onClick={() => apply({ view: view.id })}
              className="staff-view"
            >
              {SUPPORT_VIEW_LABELS[view.id]}
              {view.countKey && counts ? (
                <span className="staff-view-count">{count === null ? "—" : count}</span>
              ) : null}
            </button>
          );
        })}
      </nav>

      {/*
        --- search and filters ------------------------------------------------

        A real `<form>`, like `/staff/orders` and `/staff/production`, rather
        than a `<div>` with an `Enter` key handler on the input. The handler
        worked, but a search box that is not in a form gets no Go key on a
        mobile keyboard and no submit semantics for a screen reader, and it left
        this page as the only staff search where the button was the only
        genuine submit. `text-sm` on the buttons is what the other two use.
      */}
      <form
        className="staff-toolbar"
        role="search"
        aria-label="Search support conversations"
        onSubmit={(event) => {
          event.preventDefault();
          apply({ search: searchDraft.trim() });
        }}
      >
        <div className="staff-toolbar-search">
          <label className="sr-only" htmlFor="support-search">
            Search support
          </label>
          <input
            id="support-search"
            type="search"
            className="ui-input"
            placeholder="SUP-0007, KM-0012, subject, name or email"
            value={searchDraft}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
        </div>

        <button type="submit" className="ui-btn ui-btn-secondary text-sm">
          Search
        </button>

        <MenuSelect
          ariaLabel="Filter by status"
          value={filters.status ?? ""}
          options={[
            { value: "", label: "Any status" },
            ...SUPPORT_STATUSES.map((s) => ({ value: s, label: SUPPORT_STATUS_LABELS[s] })),
          ]}
          onChange={(value) => apply({ status: (value || null) as SupportFilters["status"] })}
        />

        <MenuSelect
          ariaLabel="Sort conversations"
          value={filters.sort}
          options={SUPPORT_SORTS.map((s) => ({ value: s, label: SUPPORT_SORT_LABELS[s] }))}
          onChange={(value) => apply({ sort: value as SupportFilters["sort"] })}
        />

        <button
          type="button"
          className="ui-btn ui-btn-ghost text-sm"
          aria-expanded={showMoreFilters}
          onClick={() => setShowMoreFilters((open) => !open)}
        >
          {showMoreFilters ? "Fewer filters" : "More filters"}
        </button>

        {hasActiveSupportFilters(filters) ? (
          <button
            type="button"
            className="ui-btn ui-btn-ghost text-sm"
            onClick={() => router.replace("/staff/support")}
          >
            Clear filters
          </button>
        ) : null}
      </form>

      {showMoreFilters ? (
        <div className="staff-toolbar">
          <MenuSelect
            ariaLabel="Filter by category"
            value={filters.category ?? ""}
            options={[
              { value: "", label: "Any category" },
              ...SUPPORT_CATEGORIES.map((c) => ({ value: c, label: SUPPORT_CATEGORY_SHORT[c] })),
            ]}
            onChange={(value) => apply({ category: (value || null) as SupportFilters["category"] })}
          />
          <MenuSelect
            ariaLabel="Filter by priority"
            value={filters.priority ?? ""}
            options={[
              { value: "", label: "Any priority" },
              ...SUPPORT_PRIORITIES.map((p) => ({ value: p, label: SUPPORT_PRIORITY_LABELS[p] })),
            ]}
            onChange={(value) => apply({ priority: (value || null) as SupportFilters["priority"] })}
          />
          {/*
            `Field`, so the two dates carry the label-above rhythm every other
            filter on the staff side uses. They were the one pair on this page
            with the label *beside* the control and a `ml-2` of its own, which
            is a third spacing value for a job `.ui-label` already decides.
          */}
          <Field label="Opened from" className="min-w-[10rem]">
            <input
              type="date"
              className="ui-input"
              value={filters.createdFrom ?? ""}
              onChange={(event) => apply({ createdFrom: event.target.value || null })}
            />
          </Field>
          <Field label="Opened to" className="min-w-[10rem]">
            <input
              type="date"
              className="ui-input"
              value={filters.createdTo ?? ""}
              onChange={(event) => apply({ createdTo: event.target.value || null })}
            />
          </Field>
        </div>
      ) : null}

      {state.kind === "ready" && state.searchNote ? (
        <p className="text-sm text-brand-textMuted">{state.searchNote}</p>
      ) : null}

      {/* --- the list --------------------------------------------------------- */}
      {state.kind === "loading" ? <LoadingState /> : null}
      {state.kind === "error" ? <ErrorState onRetry={() => void load()}>{state.message}</ErrorState> : null}

      {state.kind === "ready" && !state.conversations.length ? (
        <EmptyState>
          {hasActiveSupportFilters(filters)
            ? "No conversations match these filters."
            : "Nothing is waiting. When a customer writes, it lands here."}
        </EmptyState>
      ) : null}

      {state.kind === "ready" && state.conversations.length ? (
        <>
          <Rows>
            {state.conversations.map((row) => (
              <Row
                key={row.id}
                href={`/staff/support/${row.id}`}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm text-brand-primary">{row.reference}</span>
                    <span className="truncate">{row.subject}</span>
                  </span>
                }
                detail={
                  <span>
                    {row.requesterLabel}
                    {row.isGuest ? <span className="text-brand-textMuted"> · guest</span> : null}
                    {row.relatedOrderNumber ? (
                      <span className="text-brand-textMuted"> · {row.relatedOrderNumber}</span>
                    ) : null}
                  </span>
                }
                meta={
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{SUPPORT_CATEGORY_SHORT[row.category]}</span>
                    <span aria-hidden>·</span>
                    <span>{formatSupportAge(row.lastMessageAt)}</span>
                    <span aria-hidden>·</span>
                    <span>{row.assignedToLabel ?? "Unassigned"}</span>
                    {row.noteCount ? (
                      <>
                        <span aria-hidden>·</span>
                        <span>
                          {row.noteCount} note{row.noteCount === 1 ? "" : "s"}
                        </span>
                      </>
                    ) : null}
                  </span>
                }
                aside={
                  <span className="flex flex-wrap items-center justify-end gap-2">
                    {row.priority !== "normal" ? (
                      <Badge tone={PRIORITY_TONE[row.priority]}>{SUPPORT_PRIORITY_LABELS[row.priority]}</Badge>
                    ) : null}
                    <Badge tone={STATUS_TONE[row.status]}>{SUPPORT_STATUS_LABELS[row.status]}</Badge>
                  </span>
                }
              />
            ))}
          </Rows>

          {/*
            The pagination family the rest of the staff side uses: a
            `<nav aria-label="Pagination">` built on `.staff-toolbar`, with the
            position stated between two secondary buttons.

            "Newer" and "Older" became "Previous" and "Next" because this list
            is not always in time order — four of its sorts are, and the other
            two are by priority and by oldest-waiting, where "Older" names the
            wrong axis. `/staff/orders` and `/staff/inventory` already say
            Previous/Next for the same reason.
          */}
          <nav className="staff-toolbar justify-between" aria-label="Pagination">
            <button
              type="button"
              className="ui-btn ui-btn-secondary text-sm"
              disabled={filters.page <= 1}
              onClick={() => apply({ page: filters.page - 1 })}
            >
              Previous
            </button>
            <span className="text-sm text-brand-textMuted" aria-live="polite">
              {state.total} conversation{state.total === 1 ? "" : "s"} ·{" "}
              <span className="tabular-nums">page {filters.page}</span>
            </span>
            <button
              type="button"
              className="ui-btn ui-btn-secondary text-sm"
              disabled={!state.hasMore}
              onClick={() => apply({ page: filters.page + 1 })}
            >
              Next
            </button>
          </nav>
        </>
      ) : null}

      <p className="text-sm text-brand-textMuted">
        Customers open these at{" "}
        <Link href="/support" className="text-brand-primary hover:underline">
          /support
        </Link>
        .
      </p>
    </StaffPage>
  );
}
