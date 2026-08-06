"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import { ConsequentialAction, resultFromResponse } from "@/components/staff/ConsequentialAction";
import { Badge, EmptyState, MetricCard, Notice, Panel } from "@/components/ui/DesignSystem";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  DELIVERY_STATUS_HELP,
  DELIVERY_STATUS_LABELS,
  FILTERABLE_DELIVERY_STATUSES,
  deliveryFiltersToQuery,
  parseDeliveryFilters,
  type DeliveryStatus,
  type DeliveryView,
} from "@/lib/comms/deliveryCenter";
import { EMAIL_TEMPLATE_KEYS } from "@/lib/comms/emailEvents";

/**
 * Email delivery history.
 *
 * What this page shows and what it deliberately does not:
 *
 *   * **A masked recipient**, not a full address. This is a list — filtered,
 *     paginated, and the sort of thing that ends up in a screenshot. Enough of
 *     the address to tell one customer from another and to spot a typo'd
 *     domain, which is the failure this page is most useful for.
 *   * **A failure category**, not the provider's own message. A provider error
 *     can quote the address it refused.
 *   * **No event key and no provider id.** Both are internal handles; an
 *     idempotency key on a screen is a key somebody can reuse.
 *   * **No body, ever.** There is no way to read the text of a sent message
 *     here, and no way to edit one before re-sending it.
 *
 * The search box matches the **order number** and never the recipient. Matching
 * on an address would make this a way to ask "is this person a customer", which
 * is a different capability from reviewing what was sent.
 */

type Payload = {
  deliveries: DeliveryView[];
  total: number;
  page: number;
  pageSize: number;
  canResend: boolean;
};

/** A load that has not succeeded yields no rows and no counts, never zero. */
type State =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; payload: Payload };

const STATUS_TONE: Record<DeliveryStatus | "unknown", "success" | "warning" | "danger" | "neutral"> = {
  delivered: "success",
  sent: "success",
  queued: "neutral",
  failed: "danger",
  skipped: "warning",
  unknown: "neutral",
};

export default function DeliveriesPage() {
  return (
    <Suspense fallback={<div className="ui-card text-sm text-brand-textMuted">Loading…</div>}>
      <DeliveryCenter />
    </Suspense>
  );
}

function DeliveryCenter() {
  const supabase = useMemo(() => supabaseBrowser(), []);
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: access, isLoading } = useMeAccess();
  const permissions = new Set(access?.permissions ?? []);
  const canView = permissions.has("emails.view") || permissions.has("emails.resend");

  // Filters live in the URL and nowhere else. A `useState` mirror is what makes
  // the back button disagree with the list.
  const filters = useMemo(
    () => parseDeliveryFilters(searchParams, EMAIL_TEMPLATE_KEYS),
    [searchParams]
  );
  const [state, setState] = useState<State>({ kind: "loading" });
  const [searchDraft, setSearchDraft] = useState(filters.search);

  const load = useCallback(async () => {
    setState({ kind: "loading" });
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    try {
      const response = await fetch(`/api/staff/emails/deliveries?${deliveryFiltersToQuery(filters)}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        cache: "no-store",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setState({ kind: "error", message: body.error || "Delivery history could not be loaded." });
        return;
      }
      setState({ kind: "ready", payload: (await response.json()) as Payload });
    } catch {
      setState({ kind: "error", message: "Delivery history could not be loaded. Check the connection and retry." });
    }
  }, [filters, supabase]);

  useEffect(() => {
    if (!canView) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [canView, load]);

  const apply = useCallback(
    (patch: Partial<typeof filters>) => {
      const next = { ...filters, ...patch, page: patch.page ?? 1 };
      router.push(`/staff/emails/deliveries?${deliveryFiltersToQuery(next)}`);
    },
    [filters, router]
  );

  if (isLoading) return <div className="ui-card text-sm text-brand-textMuted">Loading…</div>;
  if (!canView) {
    return (
      <AccessDeniedCard message="Delivery history carries customer recipient details, so it needs the View email delivery history permission." />
    );
  }

  const payload = state.kind === "ready" ? state.payload : null;
  const totalPages = payload ? Math.max(1, Math.ceil(payload.total / payload.pageSize)) : 1;
  const failed = payload?.deliveries.filter((row) => row.status === "failed").length ?? null;

  return (
    <main className="page-stack">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="ui-eyebrow">Settings</p>
          <h1 className="mt-1 text-3xl font-semibold">Email delivery history</h1>
          <p className="mt-2 max-w-2xl text-sm text-brand-textMuted">
            Every transactional message this shop has attempted, with what happened to it. Addresses are
            masked and message bodies are never shown here. Re-sending sends the same message to the same
            person — there is no way to change either.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={state.kind === "loading"}
          className="ui-btn ui-btn-secondary disabled:opacity-50"
        >
          {state.kind === "loading" ? "Loading…" : "Refresh"}
        </button>
      </div>

      {state.kind === "error" ? (
        <Notice tone="danger" role="alert">
          {state.message}
        </Notice>
      ) : null}

      <section className="grid gap-3 sm:grid-cols-3" aria-label="Delivery summary">
        <MetricCard
          label="Shown"
          /* A dash, not a zero. An unknown count and "none" are different answers. */
          value={payload ? String(payload.deliveries.length) : "—"}
          detail={payload ? `of ${payload.total} matching` : "Not loaded"}
        />
        <MetricCard
          label="Failed on this page"
          value={failed === null ? "—" : String(failed)}
          detail={failed === null ? "Not loaded" : failed ? "Each can be re-sent" : "Nothing failed here"}
          tone={failed ? "danger" : "default"}
        />
        <MetricCard
          label="Page"
          value={payload ? `${payload.page} / ${totalPages}` : "—"}
          detail={payload ? `${payload.pageSize} per page` : "Not loaded"}
        />
      </section>

      <Panel>
        <h2 className="text-lg font-semibold">Filters</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div>
            <span className="ui-label" id="status-filter-label">
              Status
            </span>
            <div className="mt-2 flex flex-wrap gap-2" role="group" aria-labelledby="status-filter-label">
              {FILTERABLE_DELIVERY_STATUSES.map((status) => {
                const active = filters.status.includes(status);
                return (
                  <button
                    key={status}
                    type="button"
                    aria-pressed={active}
                    title={DELIVERY_STATUS_HELP[status]}
                    onClick={() =>
                      apply({
                        status: active
                          ? filters.status.filter((value) => value !== status)
                          : [...filters.status, status],
                      })
                    }
                    className={`ui-btn min-h-11 px-3 text-xs ${active ? "ui-btn-primary" : "ui-btn-secondary"}`}
                  >
                    {DELIVERY_STATUS_LABELS[status]}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <label className="ui-label" htmlFor="audience-filter">
              Audience
            </label>
            <select
              id="audience-filter"
              className="ui-input mt-2"
              value={filters.audience[0] ?? ""}
              onChange={(event) =>
                apply({ audience: event.target.value ? [event.target.value as "customer" | "staff"] : [] })
              }
            >
              <option value="">Everyone</option>
              <option value="customer">Customers</option>
              <option value="staff">Staff alerts</option>
            </select>
          </div>

          <div>
            <label className="ui-label" htmlFor="from-filter">
              From
            </label>
            <input
              id="from-filter"
              type="date"
              className="ui-input mt-2"
              value={filters.from ?? ""}
              onChange={(event) => apply({ from: event.target.value || null })}
            />
          </div>

          <div>
            <label className="ui-label" htmlFor="to-filter">
              To
            </label>
            <input
              id="to-filter"
              type="date"
              className="ui-input mt-2"
              value={filters.to ?? ""}
              onChange={(event) => apply({ to: event.target.value || null })}
            />
          </div>

          <div className="md:col-span-2">
            <label className="ui-label" htmlFor="search-filter">
              Order number
            </label>
            <form
              className="mt-2 flex gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                apply({ search: searchDraft });
              }}
            >
              <input
                id="search-filter"
                className="ui-input"
                value={searchDraft}
                onChange={(event) => setSearchDraft(event.target.value)}
                placeholder="KM-0007"
                aria-describedby="search-help"
              />
              <button type="submit" className="ui-btn ui-btn-secondary min-h-11">
                Search
              </button>
            </form>
            <p id="search-help" className="mt-1 text-xs text-brand-textMuted">
              Matches the order number only. Recipient addresses are not searchable.
            </p>
          </div>

          <div className="flex items-end">
            <Link href="/staff/emails/deliveries" className="ui-btn ui-btn-secondary min-h-11">
              Clear filters
            </Link>
          </div>
        </div>
      </Panel>

      {state.kind === "loading" ? <EmptyState>Loading delivery history…</EmptyState> : null}

      {payload ? (
        payload.deliveries.length === 0 ? (
          <EmptyState>
            No messages match these filters. That is a complete answer — the query succeeded and found none.
          </EmptyState>
        ) : (
          <Panel>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[46rem] text-left text-sm">
                <caption className="sr-only">Transactional email deliveries, newest first</caption>
                <thead className="text-xs uppercase tracking-wide text-brand-textMuted">
                  <tr>
                    <th scope="col" className="py-2 pr-3">Message</th>
                    <th scope="col" className="py-2 pr-3">To</th>
                    <th scope="col" className="py-2 pr-3">Order</th>
                    <th scope="col" className="py-2 pr-3">Status</th>
                    <th scope="col" className="py-2 pr-3">When</th>
                    <th scope="col" className="py-2">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {payload.deliveries.map((row) => (
                    <tr key={row.id} className="border-t border-zinc-800 align-top">
                      <td className="py-3 pr-3">
                        <p className="font-medium">{row.templateName}</p>
                        <p className="mt-1 text-xs text-brand-textMuted">{row.subject}</p>
                        {row.isResend ? (
                          <Badge tone="neutral" className="mt-2">
                            Re-send
                          </Badge>
                        ) : null}
                      </td>
                      <td className="py-3 pr-3">
                        <span className="font-mono text-xs">{row.maskedRecipient || "—"}</span>
                        <p className="mt-1 text-xs text-brand-textMuted">
                          {row.audience === "customer" ? "Customer" : row.audience === "staff" ? "Staff alert" : "Unknown"}
                        </p>
                      </td>
                      <td className="py-3 pr-3">
                        {row.orderId ? (
                          <Link href={`/staff/orders/${row.orderId}`} className="inline-flex min-h-11 items-center text-brand-accent hover:underline">
                            {row.orderNumber ?? "Order"}
                          </Link>
                        ) : (
                          <span className="text-brand-textMuted">—</span>
                        )}
                      </td>
                      <td className="py-3 pr-3">
                        <Badge tone={STATUS_TONE[row.status]}>{row.statusLabel}</Badge>
                        {row.failureSummary ? (
                          <p className="mt-1 text-xs text-brand-textMuted">{row.failureSummary}</p>
                        ) : null}
                        {row.attemptCount > 1 ? (
                          <p className="mt-1 text-xs text-brand-textMuted">{row.attemptCount} attempts</p>
                        ) : null}
                      </td>
                      <td className="py-3 pr-3 text-xs text-brand-textMuted">
                        {new Date(row.createdAt).toLocaleString()}
                      </td>
                      <td className="py-3">
                        <ResendControl row={row} canResend={payload.canResend} onDone={() => void load()} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <nav className="mt-4 flex items-center justify-between gap-3" aria-label="Delivery history pages">
              <button
                type="button"
                className="ui-btn ui-btn-secondary min-h-11 disabled:opacity-40"
                disabled={payload.page <= 1}
                onClick={() => apply({ page: payload.page - 1 })}
              >
                Previous
              </button>
              <p className="text-xs text-brand-textMuted" aria-live="polite">
                Showing {(payload.page - 1) * payload.pageSize + 1}–
                {Math.min(payload.page * payload.pageSize, payload.total)} of {payload.total}
              </p>
              <button
                type="button"
                className="ui-btn ui-btn-secondary min-h-11 disabled:opacity-40"
                disabled={payload.page >= totalPages}
                onClick={() => apply({ page: payload.page + 1 })}
              >
                Next
              </button>
            </nav>
          </Panel>
        )
      ) : null}
    </main>
  );
}

/**
 * The resend control.
 *
 * Deliberately built on `ConsequentialAction` rather than a plain button: this
 * causes a real email to leave the building, so it gets the same dialog every
 * other consequential staff action gets — current state, proposed state, named
 * effects, a synchronous in-flight guard against a double click, and a conflict
 * that removes the confirm button rather than re-arming it.
 *
 * There is no recipient field and no body field. The dialog shows the *masked*
 * address it will go to, which is enough to confirm you are re-sending to the
 * right person and not enough to be a directory.
 */
function ResendControl({
  row,
  canResend,
  onDone,
}: {
  row: DeliveryView;
  canResend: boolean;
  onDone: () => void;
}) {
  const supabase = useMemo(() => supabaseBrowser(), []);

  if (!canResend) {
    return <span className="text-xs text-brand-textMuted">Needs the re-send permission</span>;
  }
  if (!row.canResend) {
    return (
      <span className="text-xs text-brand-textMuted" title={row.resendBlockedReason ?? undefined}>
        Not re-sendable
      </span>
    );
  }

  return (
    <ConsequentialAction
      label="Re-send"
      title="Re-send this message?"
      tone="default"
      confirmLabel="Re-send it"
      currentState={row.statusLabel}
      nextState="Sent again"
      summary={
        <>
          <strong>{row.templateName}</strong> will be sent again to <strong>{row.maskedRecipient}</strong>
          {row.orderNumber ? ` for ${row.orderNumber}` : ""}. The wording comes from the same template as the
          original; neither the recipient nor the text can be changed here.
        </>
      }
      effects={{
        customer: `The customer receives "${row.subject}" again.`,
        financial: null,
        inventory: null,
        notification: "A new delivery record is written, linked to this one. The original is left untouched.",
      }}
      internalNote={{
        label: "Why are you re-sending it? (internal, optional)",
        placeholder: "Customer said it never arrived",
        help: "Recorded on the audit event. The customer never sees this.",
      }}
      onConfirm={async () => {
        const session = await supabase.auth.getSession();
        const token = session.data.session?.access_token;
        const response = await fetch(`/api/staff/emails/deliveries/${row.id}/resend`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ expectedStatus: row.status }),
        });
        const result = await resultFromResponse(response);
        if (result.ok) onDone();
        return result;
      }}
    />
  );
}
