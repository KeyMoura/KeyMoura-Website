"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Row,
  Rows,
  Section,
  StatusChip,
} from "@/components/staff/StaffPage";
import { Badge } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { actionLabel } from "@/lib/audit/actions";
import {
  MAX_NOTE_LENGTH,
  NOTE_CATEGORIES,
  NOTE_CATEGORY_LABELS,
  type NoteCategory,
} from "@/lib/staff/userAccess";
import { formatCents } from "@/lib/staff/userDirectory";

/**
 * The loaded tabs of the user workspace.
 *
 * Each panel fetches when its tab is first opened, not when the page loads.
 * Orders, activity, communications and notes are four separate queries against
 * four different tables, and running all of them to render one of them is how a
 * workspace becomes slow for the ninety per cent of visits that only wanted the
 * Overview.
 *
 * Every panel treats a refused request as an error, never as an empty list.
 * "This customer has sent no emails" and "you may not read email history" are
 * different sentences, and rendering the first when the second is true is the
 * defect this codebase has now fixed on five separate pages.
 */

/** Only the caller's bearer token. The server decides who they are from it. */
type Auth = { token: string };

async function authedFetch(url: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${token}` },
  });
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const parsed = new Date(iso);
  if (!Number.isFinite(parsed.getTime())) return "—";
  return parsed.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Shared loader shape, so each panel is a fetch and a render rather than a state machine. */
function usePanel<T>(url: string | null, token: string | null, forbiddenMessage: string) {
  const [state, setState] = useState<
    { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; data: T }
  >({ kind: "loading" });

  const load = useCallback(async () => {
    if (!url || !token) return;
    setState({ kind: "loading" });
    try {
      const res = await authedFetch(url, token);
      if (!res.ok) {
        setState({ kind: "error", message: res.status === 403 ? forbiddenMessage : "Could not load this." });
        return;
      }
      setState({ kind: "ready", data: (await res.json()) as T });
    } catch {
      setState({ kind: "error", message: "Could not load this." });
    }
  }, [url, token, forbiddenMessage]);

  useEffect(() => {
    void load();
  }, [load]);

  return { state, reload: load };
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

type OrderItem = {
  id: string;
  orderNumber: string | null;
  status: string;
  paymentStatus: string;
  fulfillmentStatus: string;
  productName: string;
  quantity: number;
  totalCents: number | null;
  paidCents: number;
  refundedCents: number;
  createdAt: string;
  production: { id: string; jobNumber: string | null; title: string | null; status: string; priority: string | null; dueDate: string | null }[];
};

type GuestMatch = { id: string; orderNumber: string | null; status: string; createdAt: string };

export function OrdersPanel({ userId, auth }: { userId: string; auth: Auth }) {
  const [page, setPage] = useState(1);
  const { state, reload } = usePanel<{
    orders: OrderItem[];
    total: number;
    hasMore: boolean;
    possibleGuestOrders: GuestMatch[];
    possibleGuestOrderTotal: number;
  }>(`/api/staff/users/${userId}/orders?page=${page}`, auth.token, "You do not have permission to view orders.");

  if (state.kind === "loading") return <LoadingState />;
  if (state.kind === "error") return <ErrorState onRetry={() => void reload()}>{state.message}</ErrorState>;

  const { orders, total, hasMore, possibleGuestOrders, possibleGuestOrderTotal } = state.data;

  return (
    <>
      <Section
        headingLevel={3}
        title={`Orders (${total})`}
        description="Orders this account owns. Click through for the full workspace."
      >
        {orders.length === 0 ? (
          <EmptyState>This account has not placed an order.</EmptyState>
        ) : (
          <Rows>
            {orders.map((order) => (
              <Row
                key={order.id}
                href={`/staff/orders/${order.id}`}
                title={`${order.orderNumber ?? "Draft"} — ${order.productName}`}
                detail={
                  <>
                    {formatDate(order.createdAt)} · {order.quantity} ×{" "}
                    {order.totalCents === null ? "not priced" : formatCents(order.totalCents)}
                    {order.refundedCents > 0 ? ` · ${formatCents(order.refundedCents)} refunded` : ""}
                  </>
                }
                meta={
                  order.production.length ? (
                    <span className="flex flex-wrap gap-x-3 gap-y-1">
                      {order.production.map((job) => (
                        <Link
                          key={job.id}
                          href={`/staff/production/${job.id}`}
                          className="underline"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {job.jobNumber ?? "Job"} · {job.status.replaceAll("_", " ")}
                          {job.dueDate ? ` · due ${formatDate(job.dueDate)}` : ""}
                        </Link>
                      ))}
                    </span>
                  ) : null
                }
                aside={
                  <>
                    <StatusChip value={order.status} />
                    <StatusChip value={order.paymentStatus} prefix="Payment " />
                    <StatusChip value={order.fulfillmentStatus} prefix="Delivery " />
                  </>
                }
              />
            ))}
          </Rows>
        )}

        {total > orders.length || page > 1 ? (
          <div className="mt-3 flex items-center justify-between gap-3">
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </button>
            <span className="text-xs" style={{ color: "var(--muted)" }}>
              Page {page}
            </span>
            <button
              type="button"
              className="ui-btn ui-btn-secondary"
              disabled={!hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </button>
          </div>
        ) : null}
      </Section>

      {/*
       * Guest orders, clearly not owned.
       *
       * Shown because a staff member on the phone needs to know they exist. The
       * wording is the load-bearing part: these are matched on email, and email
       * equality is not proof of ownership. They are counted in no metric on
       * this page.
       */}
      {possibleGuestOrderTotal > 0 ? (
        <Section
          headingLevel={3}
          title="Possible guest orders"
          description="Guest orders placed with the same email address. These are NOT owned by this account, are not counted in its totals, and matching an address is not proof the same person placed them."
        >
          <Rows>
            {possibleGuestOrders.map((order) => (
              <Row
                key={order.id}
                href={`/staff/orders/${order.id}`}
                title={order.orderNumber ?? "Guest order"}
                detail={formatDate(order.createdAt)}
                aside={
                  <>
                    <Badge tone="warning">Unclaimed guest order</Badge>
                    <StatusChip value={order.status} />
                  </>
                }
              />
            ))}
          </Rows>
          {possibleGuestOrderTotal > possibleGuestOrders.length ? (
            <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
              Showing {possibleGuestOrders.length} of {possibleGuestOrderTotal}.
            </p>
          ) : null}
        </Section>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

type ActivityEvent = {
  id: string;
  occurredAt: string;
  action: string;
  actionLabel: string;
  area: string;
  sensitive: boolean;
  actorLabel: string;
  entityLabel: string | null;
  relatedOrderId: string | null;
  summary: string | null;
  changes: { field: string; label: string; before: string; after: string }[];
  isSubject: boolean;
};

export function ActivityPanel({ userId, auth }: { userId: string; auth: Auth }) {
  const [scope, setScope] = useState<"all" | "subject" | "actor">("all");
  const { state, reload } = usePanel<{ events: ActivityEvent[]; hasMore: boolean }>(
    `/api/staff/users/${userId}/activity?scope=${scope}`,
    auth.token,
    "You do not have permission to view the audit log."
  );

  return (
    <Section
      headingLevel={3}
      title="Audit activity"
      description="Recorded changes to this account, and changes this person made."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <MenuSelect
            ariaLabel="Activity scope"
            value={scope}
            options={[
              { value: "all", label: "Everything" },
              { value: "subject", label: "Changes to this account" },
              { value: "actor", label: "Changes they made" },
            ]}
            onChange={(value) => setScope(value as "all" | "subject" | "actor")}
          />
          <Link href={`/staff/audit?actor=${userId}`} className="ui-btn ui-btn-secondary">
            View full audit log →
          </Link>
        </div>
      }
    >
      {state.kind === "loading" ? <LoadingState /> : null}
      {state.kind === "error" ? <ErrorState onRetry={() => void reload()}>{state.message}</ErrorState> : null}
      {state.kind === "ready" ? (
        state.data.events.length === 0 ? (
          <EmptyState>No recorded activity for this account.</EmptyState>
        ) : (
          <Rows>
            {state.data.events.map((event) => (
              <Row
                key={event.id}
                title={
                  <span className="flex flex-wrap items-center gap-2">
                    {event.actionLabel || actionLabel(event.action)}
                    {event.sensitive ? <Badge tone="warning">Sensitive</Badge> : null}
                  </span>
                }
                detail={event.summary ?? event.entityLabel ?? null}
                meta={
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{event.actorLabel}</span>
                    <span>{formatDateTime(event.occurredAt)}</span>
                    {event.relatedOrderId ? (
                      <Link href={`/staff/orders/${event.relatedOrderId}`} className="underline">
                        Open order
                      </Link>
                    ) : null}
                  </span>
                }
                aside={
                  <Badge tone={event.isSubject ? "accent" : "neutral"}>
                    {event.isSubject ? "To this account" : "By this person"}
                  </Badge>
                }
              />
            ))}
          </Rows>
        )
      ) : null}
      {state.kind === "ready" && state.data.hasMore ? (
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Showing the most recent events.{" "}
          <Link href={`/staff/audit?actor=${userId}`} className="underline">
            See the full log
          </Link>
          .
        </p>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

type NoteItem = {
  id: string;
  authorLabel: string;
  body: string;
  category: string;
  orderNumber: string | null;
  archivedAt: string | null;
  archivedByLabel: string | null;
  createdAt: string;
};

export function NotesPanel({
  userId,
  auth,
  canWrite,
}: {
  userId: string;
  auth: Auth;
  canWrite: boolean;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const { state, reload } = usePanel<{ notes: NoteItem[] }>(
    `/api/staff/users/${userId}/notes${showArchived ? "?archived=1" : ""}`,
    auth.token,
    "You do not have permission to read staff notes."
  );

  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState<NoteCategory>("general");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const submit = async () => {
    if (!draft.trim() || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const res = await authedFetch(`/api/staff/users/${userId}/notes`, auth.token, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: draft.trim(), category }),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; auditFailed?: boolean } | null;
      if (!res.ok) {
        setMessage(json?.error ?? "Could not save the note.");
        return;
      }
      setDraft("");
      setCategory("general");
      setMessage(json?.auditFailed ? "Note saved, but the audit event failed to record." : "Note added.");
      await reload();
    } finally {
      setSaving(false);
    }
  };

  const archive = async (noteId: string) => {
    const res = await authedFetch(`/api/staff/users/${userId}/notes/${noteId}/archive`, auth.token, {
      method: "POST",
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    setMessage(res.ok ? "Note archived." : json?.error ?? "Could not archive the note.");
    await reload();
  };

  return (
    <Section
      headingLevel={3}
      title="Staff notes"
      description="Internal only. Never shown to the customer. Notes cannot be edited or deleted once written — archive them instead."
      actions={
        <button type="button" className="ui-chip" onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      }
    >
      {canWrite ? (
        <Card className="mb-3">
          <label className="sr-only" htmlFor="note-body">
            New note
          </label>
          <textarea
            id="note-body"
            className="ui-input"
            rows={3}
            maxLength={MAX_NOTE_LENGTH}
            placeholder="Prefers email over phone. Discussed a replacement knob in anodised black."
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <p className="mt-1 text-xs" style={{ color: "var(--muted)" }}>
            Do not record payment card details, passwords, or sensitive personal or medical information.
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <MenuSelect
              ariaLabel="Note category"
              value={category}
              options={NOTE_CATEGORIES.map((c) => ({ value: c, label: NOTE_CATEGORY_LABELS[c] }))}
              onChange={(value) => setCategory(value as NoteCategory)}
            />
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={!draft.trim() || saving}
              onClick={() => void submit()}
            >
              {saving ? "Saving…" : "Add note"}
            </button>
            {message ? (
              <span className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
                {message}
              </span>
            ) : null}
          </div>
        </Card>
      ) : null}

      {state.kind === "loading" ? <LoadingState /> : null}
      {state.kind === "error" ? <ErrorState onRetry={() => void reload()}>{state.message}</ErrorState> : null}
      {state.kind === "ready" ? (
        state.data.notes.length === 0 ? (
          <EmptyState>No staff notes on this account.</EmptyState>
        ) : (
          <Rows>
            {state.data.notes.map((note) => (
              <Row
                key={note.id}
                title={<span className="whitespace-pre-wrap font-normal">{note.body}</span>}
                meta={
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span>{note.authorLabel}</span>
                    <span>{formatDateTime(note.createdAt)}</span>
                    {note.orderNumber ? <span>about {note.orderNumber}</span> : null}
                    {note.archivedAt ? <span>Archived by {note.archivedByLabel} on {formatDate(note.archivedAt)}</span> : null}
                  </span>
                }
                aside={
                  <>
                    <Badge tone={note.category === "warning" ? "danger" : "neutral"}>
                      {NOTE_CATEGORY_LABELS[note.category as NoteCategory] ?? note.category}
                    </Badge>
                    {canWrite && !note.archivedAt ? (
                      <button type="button" className="ui-chip" onClick={() => void archive(note.id)}>
                        Archive
                      </button>
                    ) : null}
                    {note.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
                  </>
                }
              />
            ))}
          </Rows>
        )
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Communications
// ---------------------------------------------------------------------------

type DeliveryItem = {
  id: string;
  orderId: string | null;
  orderNumber: string | null;
  templateName: string;
  maskedRecipient: string;
  subject: string;
  status: string;
  statusLabel: string;
  failureSummary: string | null;
  createdAt: string;
  isResend: boolean;
  canResend: boolean;
  resendBlockedReason: string | null;
};

export function CommunicationsPanel({ userId, auth }: { userId: string; auth: Auth }) {
  const { state, reload } = usePanel<{ deliveries: DeliveryItem[]; total: number; canResend: boolean }>(
    `/api/staff/users/${userId}/communications`,
    auth.token,
    "You do not have permission to view email history."
  );

  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const resend = async (deliveryId: string) => {
    setBusy(deliveryId);
    setMessage(null);
    try {
      // The existing resend route, which already writes `email.manual_resend` to
      // the audit log. No second sender is built here.
      const res = await authedFetch(`/api/staff/emails/deliveries/${deliveryId}/resend`, auth.token, {
        method: "POST",
      });
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      setMessage(res.ok ? "Re-sent." : json?.error ?? "Could not re-send.");
      await reload();
    } finally {
      setBusy(null);
      setConfirming(null);
    }
  };

  if (state.kind === "loading") return <LoadingState />;
  if (state.kind === "error") return <ErrorState onRetry={() => void reload()}>{state.message}</ErrorState>;

  return (
    <Section
      headingLevel={3}
      title={`Email history (${state.data.total})`}
      description="Transactional email sent about this account's orders. Addresses are masked; provider message ids are not shown."
    >
      {message ? (
        <p className="mb-2 text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
          {message}
        </p>
      ) : null}

      {state.data.deliveries.length === 0 ? (
        <EmptyState>No email has been sent to this account.</EmptyState>
      ) : (
        <Rows>
          {state.data.deliveries.map((delivery) => (
            <Row
              key={delivery.id}
              title={delivery.subject}
              detail={
                <>
                  {delivery.templateName} → {delivery.maskedRecipient}
                  {delivery.failureSummary ? ` · ${delivery.failureSummary}` : ""}
                </>
              }
              meta={
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>{formatDateTime(delivery.createdAt)}</span>
                  {delivery.orderId ? (
                    <Link href={`/staff/orders/${delivery.orderId}`} className="underline">
                      {delivery.orderNumber ?? "Open order"}
                    </Link>
                  ) : null}
                  {delivery.isResend ? <span>Re-sent copy</span> : null}
                </span>
              }
              aside={
                <>
                  <StatusChip value={delivery.status} label={delivery.statusLabel} />
                  {state.data.canResend && delivery.canResend ? (
                    confirming === delivery.id ? (
                      <span className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="ui-btn ui-btn-danger"
                          disabled={busy === delivery.id}
                          onClick={() => void resend(delivery.id)}
                        >
                          {busy === delivery.id ? "Sending…" : "Send it"}
                        </button>
                        <button type="button" className="ui-chip" onClick={() => setConfirming(null)}>
                          Cancel
                        </button>
                      </span>
                    ) : (
                      // Confirmed, because this puts a real email in somebody's
                      // inbox — not an action a mis-click should complete.
                      <button type="button" className="ui-chip" onClick={() => setConfirming(delivery.id)}>
                        Re-send
                      </button>
                    )
                  ) : null}
                </>
              }
            />
          ))}
        </Rows>
      )}
    </Section>
  );
}
