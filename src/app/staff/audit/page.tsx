"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";

import { MenuSelect } from "@/components/ui/MenuSelect";
import { Badge, EmptyState, Field, Notice } from "@/components/ui/DesignSystem";
import { ErrorState, LoadingState, PageHeader, StaffPage } from "@/components/staff/StaffPage";
import { AUDIT_AREAS, AUDIT_AREA_LABELS, actionLabel, actionsForArea, type AuditArea } from "@/lib/audit/actions";
import { auditLinks } from "@/lib/audit/links";
import {
  AUDIT_PAGE_SIZE,
  auditFiltersToQuery,
  hasActiveFilters,
  parseAuditFilters,
  type AuditFilters,
} from "@/lib/audit/query";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";

/**
 * The staff audit log.
 *
 * Every filter lives in the URL and nowhere else, so a view is bookmarkable and
 * the back button agrees with the list. Filtering and paging happen on the
 * server — the browser never holds more than one page, which is the difference
 * between this and the page it replaces.
 */

type RenderedChange = {
  field: string;
  label: string;
  before: string;
  after: string;
  summarized: boolean;
};

type AuditEventView = {
  id: string;
  occurredAt: string;
  action: string;
  actionLabel: string;
  area: AuditArea;
  sensitive: boolean;
  actorKind: string;
  actorUserId: string | null;
  actorLabel: string;
  actorRole: string | null;
  entityType: string | null;
  entityId: string | null;
  entityLabel: string | null;
  relatedOrderId: string | null;
  relatedProductionJobId: string | null;
  relatedProductId: string | null;
  summary: string | null;
  changes: RenderedChange[];
  metadata: Record<string, unknown>;
  source: string | null;
  correlationId: string | null;
};

type ActorOption = { id: string; label: string; kind: string; count: number };

type PageState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; events: AuditEventView[]; nextCursor: string | null; hasMore: boolean };

function formatWhen(iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatFullWhen(iso: string): string {
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Stripe and Resend are systems; the badge says so rather than implying a person. */
function actorBadge(event: AuditEventView): string | null {
  switch (event.actorKind) {
    case "provider":
      return "Provider";
    case "system":
      return "System";
    case "scheduled":
      return "Scheduled";
    case "customer":
      return "Customer";
    default:
      return null;
  }
}

export default function StaffAuditPage() {
  return (
    <Suspense
      fallback={
        <StaffPage>
          <div className="ui-empty-state" role="status">Loading…</div>
        </StaffPage>
      }
    >
      <AuditLog />
    </Suspense>
  );
}

function AuditLog() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading: accessLoading } = useMeAccess();

  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("audit.view") || permissions.has("audit.read");

  const filters = useMemo(() => parseAuditFilters(new URLSearchParams(searchParams.toString())), [searchParams]);

  const [state, setState] = useState<PageState>({ kind: "loading" });
  const [searchDraft, setSearchDraft] = useState(filters.search);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actors, setActors] = useState<ActorOption[]>([]);
  const [showMoreFilters, setShowMoreFilters] = useState(
    Boolean(filters.from || filters.to || filters.orderId || filters.productionJobId || filters.productId)
  );

  useEffect(() => setSearchDraft(filters.search), [filters.search]);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const supabase = supabaseBrowser();
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;

    try {
      const response = await fetch(`/api/staff/audit?${auditFiltersToQuery(filters)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: body.error || "The audit log could not be loaded." });
        return;
      }
      const payload = (await response.json()) as {
        events: AuditEventView[];
        nextCursor: string | null;
        hasMore: boolean;
      };
      setState({ kind: "ready", events: payload.events, nextCursor: payload.nextCursor, hasMore: payload.hasMore });
    } catch {
      setState({ kind: "error", message: "The audit log could not be loaded. Check the connection and retry." });
    }
  }, [filters]);

  useEffect(() => {
    if (!canView) return;
    void load();
  }, [canView, load]);

  useEffect(() => {
    if (!canView) return;
    const loadActors = async () => {
      const supabase = supabaseBrowser();
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      const response = await fetch("/api/staff/audit/actors", {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      }).catch(() => null);
      if (!response?.ok) return;
      const payload = (await response.json().catch(() => null)) as { actors?: ActorOption[] } | null;
      setActors(payload?.actors ?? []);
    };
    void loadActors();
  }, [canView]);

  /** Any filter change resets paging: a cursor from the old result set is meaningless. */
  const apply = useCallback(
    (patch: Partial<AuditFilters>) => {
      const next = { ...filters, ...patch, cursor: patch.cursor ?? null };
      const query = auditFiltersToQuery(next);
      router.push(query ? `/staff/audit?${query}` : "/staff/audit");
      setExpandedId(null);
    },
    [filters, router]
  );

  const actionOptions = useMemo(() => {
    const actions = filters.area ? actionsForArea(filters.area) : [];
    return actions.map((action) => ({ value: action, label: actionLabel(action) }));
  }, [filters.area]);

  if (accessLoading) {
    return (
      <StaffPage>
        <div className="ui-empty-state" role="status">Loading…</div>
      </StaffPage>
    );
  }

  if (!canView) {
    return (
      <StaffPage>
        <PageHeader title="Audit log" />
        <Notice tone="warning" role="alert">
          You do not have permission to view the audit log.
        </Notice>
      </StaffPage>
    );
  }

  const events = state.kind === "ready" ? state.events : [];

  /*
   * The shell already supplies `page-container-wide` and its gutters. This page
   * used to add `mx-auto max-w-6xl p-4` inside that, so the audit log was 8rem
   * narrower than every other staff page and carried a second ring of padding —
   * and its heading was `text-xl` beside everyone else's `.staff-page-title`.
   */
  return (
    <StaffPage>
      <PageHeader title="Audit log" description="Recent activity across KeyMoura." />

      {/* Primary filters. Everything rarer is behind "More filters" so the
          common case — search, who, which area — is not buried. */}
      <div className="staff-toolbar">
        <form
          onSubmit={(submitEvent) => {
            submitEvent.preventDefault();
            apply({ search: searchDraft.trim() });
          }}
        >
          <input
            value={searchDraft}
            onChange={(changeEvent) => setSearchDraft(changeEvent.target.value)}
            placeholder="Search KM-0012, a product, an action…"
            aria-label="Search the audit log"
            className="ui-input no-zoom-input w-64 max-w-full text-sm"
          />
        </form>

        <MenuSelect
          ariaLabel="Actor"
          value={filters.actor ?? "all"}
          onChange={(next) => apply({ actor: next === "all" ? null : next })}
          className="ui-select-trigger w-auto text-sm"
          options={[
            { value: "all", label: "Anyone" },
            ...actors.map((option) => ({ value: option.id, label: option.label })),
          ]}
        />

        <MenuSelect
          ariaLabel="Area"
          value={filters.area ?? "all"}
          onChange={(next) => apply({ area: next === "all" ? null : (next as AuditArea), action: null })}
          className="ui-select-trigger w-auto text-sm"
          options={[
            { value: "all", label: "All areas" },
            ...AUDIT_AREAS.map((area) => ({ value: area, label: AUDIT_AREA_LABELS[area] })),
          ]}
        />

        {/* The action list depends on the area, so it appears only once an area
            narrows it. Two hundred ungrouped actions is not a filter. */}
        {filters.area ? (
          <MenuSelect
            ariaLabel="Action"
            value={filters.action ?? "all"}
            onChange={(next) => apply({ action: next === "all" ? null : next })}
            className="ui-select-trigger w-auto text-sm"
            options={[{ value: "all", label: "All actions" }, ...actionOptions]}
          />
        ) : null}

        <button
          type="button"
          onClick={() => setShowMoreFilters((previous) => !previous)}
          className="ui-btn ui-btn-ghost text-sm"
          aria-expanded={showMoreFilters}
        >
          {showMoreFilters ? "Fewer filters" : "More filters"}
        </button>

        {hasActiveFilters(filters) ? (
          <button type="button" onClick={() => apply({ ...emptyPatch })} className="ui-btn ui-btn-ghost text-sm">
            Clear
          </button>
        ) : null}
      </div>

      {showMoreFilters ? (
        <div className="staff-filter-panel !flex flex-wrap items-end gap-3">
          {/* `Field`, so the label rhythm is `.ui-label`'s rather than a fourth
              hand-rolled `flex flex-col gap-1` with its own type size. */}
          <Field label="From">
            <input
              type="date"
              value={filters.from ?? ""}
              onChange={(changeEvent) => apply({ from: changeEvent.target.value || null })}
              className="ui-input no-zoom-input text-sm"
            />
          </Field>
          <Field label="To">
            <input
              type="date"
              value={filters.to ?? ""}
              onChange={(changeEvent) => apply({ to: changeEvent.target.value || null })}
              className="ui-input no-zoom-input text-sm"
            />
          </Field>
          {filters.orderId ? (
            <FilterChip label="Order" onClear={() => apply({ orderId: null })} />
          ) : null}
          {filters.productionJobId ? (
            <FilterChip label="Production job" onClear={() => apply({ productionJobId: null })} />
          ) : null}
          {filters.productId ? <FilterChip label="Product" onClear={() => apply({ productId: null })} /> : null}
          <p className="staff-row-meta">
            Order, job and product filters are set by clicking “Only this” on an event.
          </p>
        </div>
      ) : null}

      {/* A failure is not an empty log, and must not be dressed as one. */}
      {state.kind === "error" ? <ErrorState>{state.message}</ErrorState> : null}

      {state.kind === "loading" ? (
        <LoadingState>Loading the audit log…</LoadingState>
      ) : (
        <div className="staff-rows">
          {events.length === 0 ? (
            <EmptyState>
              {hasActiveFilters(filters)
                ? "No events match these filters."
                : "No activity recorded yet. Events appear here as staff and system changes happen."}
            </EmptyState>
          ) : (
            events.map((event) => (
              <AuditRow
                key={event.id}
                event={event}
                expanded={expandedId === event.id}
                onToggle={() => setExpandedId((previous) => (previous === event.id ? null : event.id))}
                onScopeTo={(patch) => apply(patch)}
              />
            ))
          )}
        </div>
      )}

      {/*
        The same pagination family as `/staff/orders`, `/staff/inventory` and
        `/staff/support`: a named `<nav>` on `.staff-toolbar`, the position
        stated between two secondary buttons.

        The wording stays "Newest"/"Older" here, and that is the one place a
        difference is justified: this list is cursor-paged strictly by time and
        has no page number to be on, so "Previous" would name a page that does
        not exist. The treatment is shared even though the words are not.
      */}
      {state.kind === "ready" && (state.hasMore || filters.cursor) ? (
        <nav className="staff-toolbar justify-between" aria-label="Pagination">
          <button
            type="button"
            disabled={!filters.cursor}
            onClick={() => apply({ cursor: null })}
            className="ui-btn ui-btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            Newest
          </button>
          <span className="staff-row-meta" aria-live="polite">
            {events.length} {events.length === 1 ? "event" : "events"} · {filters.pageSize} per page
          </span>
          <button
            type="button"
            disabled={!state.hasMore}
            onClick={() => apply({ cursor: state.nextCursor })}
            className="ui-btn ui-btn-secondary text-sm disabled:cursor-not-allowed disabled:opacity-40"
          >
            Older
          </button>
        </nav>
      ) : null}
    </StaffPage>
  );
}

const emptyPatch: Partial<AuditFilters> = {
  search: "",
  actor: null,
  area: null,
  action: null,
  from: null,
  to: null,
  orderId: null,
  productionJobId: null,
  productId: null,
  cursor: null,
  pageSize: AUDIT_PAGE_SIZE,
};

/**
 * An active filter, shown so it can be taken off again.
 *
 * `.staff-view` with `aria-pressed`, which is the pill every other staff
 * surface uses for an engaged filter — same shape, same accent-tinted active
 * treatment. It used to be a hand-rolled amber box at 32px with its own radius
 * and its own border colour, which read as a warning rather than as a filter and
 * matched nothing else in the row it sat in.
 *
 * The × keeps a text equivalent: on its own it is announced as "times" or
 * skipped, and this control's whole job is to say what removing it will do.
 */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <button type="button" aria-pressed onClick={onClear} className="staff-view">
      {label}
      <span aria-hidden="true">×</span>
      <span className="sr-only">(remove this filter)</span>
    </button>
  );
}

function AuditRow({
  event,
  expanded,
  onToggle,
  onScopeTo,
}: {
  event: AuditEventView;
  expanded: boolean;
  onToggle: () => void;
  onScopeTo: (patch: Partial<AuditFilters>) => void;
}) {
  const badge = actorBadge(event);
  const links = auditLinks(event);

  return (
    <div className="staff-row-plain">
      {/* The whole row is the control. A "View" button in the last column means
          the obvious click target does nothing, which is how the previous page
          behaved. */}
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition hover:bg-[var(--panel-strong)] sm:flex-row sm:items-center sm:gap-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium text-brand-text">{event.actorLabel}</span>
            {/*
              These two were hand-rolled pills — 4px radius, 10px type, 1px
              padding — beside `.ui-badge`s everywhere else in the staff area.
              Same information, a different shape on every other page.
            */}
            {badge ? <Badge>{badge}</Badge> : null}
            <span className="text-[13px] text-[var(--text)]">{event.actionLabel}</span>
            {event.entityLabel ? (
              <span className="font-mono text-[12px] text-brand-accent">{event.entityLabel}</span>
            ) : null}
            {event.sensitive ? <Badge tone="warning">Security</Badge> : null}
          </div>
          {event.summary ? <div className="staff-row-detail">{event.summary}</div> : null}
        </div>

        <time dateTime={event.occurredAt} className="shrink-0 staff-row-meta sm:text-right">
          {formatWhen(event.occurredAt)}
        </time>
      </button>

      {expanded ? (
        <div className="border-t border-[var(--border)] bg-[var(--panel-strong)] px-3 py-3">
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-[12px] sm:grid-cols-2">
            <Detail term="Actor">
              {event.actorUserId ? (
                <Link href={`/user/${event.actorUserId}`} className="text-amber-200 hover:underline">
                  {event.actorLabel}
                </Link>
              ) : (
                event.actorLabel
              )}
              {event.actorRole ? <span className="text-[var(--muted)]"> · {event.actorRole}</span> : null}
            </Detail>
            <Detail term="When">{formatFullWhen(event.occurredAt)}</Detail>
            <Detail term="Action">{event.actionLabel}</Detail>
            <Detail term="Affected">
              {event.entityLabel || event.entityId || "—"}
              {event.entityType ? <span className="text-[var(--muted)]"> · {event.entityType.replaceAll("_", " ")}</span> : null}
            </Detail>
          </dl>

          {event.changes.length ? (
            <div className="mt-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
              <div className="staff-fact-label">Changes</div>
              <ul className="mt-2 space-y-1.5">
                {event.changes.map((change) => (
                  <li key={change.field} className="text-[12px]">
                    <div className="text-[var(--muted)]">{change.label}</div>
                    <div className="text-brand-text">
                      <span className="text-[var(--muted)]">{change.before}</span>
                      <span className="mx-1.5 text-[var(--muted)] opacity-70">→</span>
                      <span>{change.after}</span>
                      {change.summarized ? <span className="ml-2 text-[11px] text-[var(--muted)]">(length only)</span> : null}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {links.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {links.map((link) => (
                <Link key={link.href} href={link.href} className="ui-btn ui-btn-ghost text-sm">
                  {link.label}
                </Link>
              ))}
            </div>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {event.relatedOrderId ? (
              <ScopeButton label="Only this order" onClick={() => onScopeTo({ orderId: event.relatedOrderId })} />
            ) : null}
            {event.relatedProductionJobId ? (
              <ScopeButton
                label="Only this job"
                onClick={() => onScopeTo({ productionJobId: event.relatedProductionJobId })}
              />
            ) : null}
            {event.relatedProductId ? (
              <ScopeButton label="Only this product" onClick={() => onScopeTo({ productId: event.relatedProductId })} />
            ) : null}
            {event.actorUserId ? (
              <ScopeButton label="Only this person" onClick={() => onScopeTo({ actor: event.actorUserId })} />
            ) : null}
          </div>

          {/* Raw values are available but are never the primary interface. */}
          <details className="mt-3">
            <summary className="staff-fact-label cursor-pointer">
              Advanced
            </summary>
            <div className="mt-2 space-y-1 font-mono text-[11px] text-[var(--muted)]">
              <div>action: {event.action}</div>
              <div>event id: {event.id}</div>
              {event.entityId ? <div>entity id: {event.entityId}</div> : null}
              {event.source ? <div>source: {event.source}</div> : null}
              {event.correlationId ? <div>correlation: {event.correlationId}</div> : null}
            </div>
            {Object.keys(event.metadata).length ? (
              <pre className="mt-2 max-h-64 overflow-auto rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 text-[11px] text-[var(--muted)]">
                {JSON.stringify(event.metadata, null, 2)}
              </pre>
            ) : null}
          </details>
        </div>
      ) : null}
    </div>
  );
}

function Detail({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="staff-fact-label">{term}</dt>
      <dd className="text-brand-text">{children}</dd>
    </div>
  );
}

function ScopeButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="ui-btn ui-btn-ghost text-sm">
      {label}
    </button>
  );
}
