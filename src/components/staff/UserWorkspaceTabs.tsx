"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
 * The loaded tabs of the person workspace.
 *
 * Each panel fetches when its tab is first opened, not when the page loads.
 * Orders, activity, email history and notes are four separate queries against
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

/** Orders that are still somebody's job today. */
const OPEN_ORDER_STATES = new Set([
  "requested",
  "needs_information",
  "accepted",
  "awaiting_payment",
  "in_progress",
  "in_production",
  "customer_review",
  "final_review",
  "ready",
  "processing",
]);

/** Orders where money or the sale went backwards. */
const REVERSED_ORDER_STATES = new Set(["cancelled", "canceled", "refunded", "declined"]);

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

  /*
   * Split by what a person would do about them, not by database status.
   *
   * "Open" is work outstanding; "Closed" is everything settled — completed,
   * cancelled, refunded. Cancelled and refunded rows keep their own chips so the
   * distinction the brief asks for stays visible inside the group.
   */
  const open = orders.filter((order) => OPEN_ORDER_STATES.has(order.status));
  const closed = orders.filter((order) => !OPEN_ORDER_STATES.has(order.status));

  return (
    <>
      <Section
        headingLevel={3}
        title={`Orders (${total})`}
        description="Orders this account owns. Open one for the full workspace."
        actions={
          <Link href={`/staff/orders?customer=${userId}`} className="ui-btn ui-btn-secondary">
            Open in orders →
          </Link>
        }
      >
        {orders.length === 0 ? (
          <EmptyState>This account has not placed an order.</EmptyState>
        ) : (
          <>
            {open.length ? (
              <>
                <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  Open — {open.length}
                </p>
                <Rows>
                  {open.map((order) => (
                    <OrderRow key={order.id} order={order} />
                  ))}
                </Rows>
              </>
            ) : null}

            {closed.length ? (
              <>
                <p className="mt-3 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                  Closed — {closed.length}
                </p>
                <Rows>
                  {closed.map((order) => (
                    <OrderRow key={order.id} order={order} />
                  ))}
                </Rows>
              </>
            ) : null}
          </>
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
          title="Unclaimed guest orders with matching email"
          description="These are NOT part of this account. They are counted in none of its totals, and matching an address is not proof the same person placed them."
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
                    <Badge tone="warning">Not this account</Badge>
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

function OrderRow({ order }: { order: OrderItem }) {
  return (
    <Row
      href={`/staff/orders/${order.id}`}
      // Money that went back gets the stripe an attention row uses, so a
      // refunded order is distinguishable from a completed one at a glance and
      // not only by reading its chip.
      severity={REVERSED_ORDER_STATES.has(order.status) ? "warning" : undefined}
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
  );
}

// ---------------------------------------------------------------------------
// Activity — audit events, and email history beside them
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

/**
 * Events not worth a line on a person's timeline.
 *
 * A read is not a change, and a page view is not a decision. Filtering them out
 * here rather than server-side keeps `/staff/audit` complete — the full log is
 * one link away and shows everything.
 */
const LOW_VALUE_ACTIONS = /(\.viewed|\.read|\.searched|\.exported|\.listed)$/;

function meaningfulEvents(events: ActivityEvent[]): ActivityEvent[] {
  return events.filter((event) => !LOW_VALUE_ACTIONS.test(event.action));
}

export function ActivityPanel({
  userId,
  auth,
  canViewCommunications,
}: {
  userId: string;
  auth: Auth;
  canViewCommunications: boolean;
}) {
  /*
   * Communications is a view of this tab, not a tab of its own.
   *
   * Seven tabs put 681px of strip into a 342px box at 375px wide — half of them
   * unreachable without a sideways scroll nothing signalled. Email history is a
   * short list of things that happened to this account, which is what this tab
   * already is, so it became a segment. Its permission gate is unchanged: the
   * segment does not exist without `emails.view`, and the panel behind it still
   * treats a refusal as an error.
   */
  const [view, setView] = useState<"account" | "email">("account");
  const [scope, setScope] = useState<"all" | "subject" | "actor">("all");

  return (
    <Section
      headingLevel={3}
      title="Activity"
      description="What was done to this account, what this person did, and what KeyMoura sent them."
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {view === "account" ? (
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
          ) : null}
          <Link href={`/staff/audit?actor=${userId}`} className="ui-btn ui-btn-secondary">
            View in audit log →
          </Link>
        </div>
      }
    >
      {canViewCommunications ? (
        <div className="staff-views" role="group" aria-label="Activity view">
          <button
            type="button"
            className="staff-view"
            aria-pressed={view === "account"}
            onClick={() => setView("account")}
          >
            Account activity
          </button>
          <button type="button" className="staff-view" aria-pressed={view === "email"} onClick={() => setView("email")}>
            Communications
          </button>
        </div>
      ) : null}

      {view === "account" ? (
        <AccountActivity userId={userId} auth={auth} scope={scope} />
      ) : (
        <CommunicationsPanel userId={userId} auth={auth} />
      )}
    </Section>
  );
}

function AccountActivity({
  userId,
  auth,
  scope,
  limit,
}: {
  userId: string;
  auth: Auth;
  scope: "all" | "subject" | "actor";
  limit?: number;
}) {
  const { state, reload } = usePanel<{ events: ActivityEvent[]; hasMore: boolean }>(
    `/api/staff/users/${userId}/activity?scope=${scope}${limit ? `&size=${limit}` : ""}`,
    auth.token,
    "You do not have permission to view the audit log."
  );

  if (state.kind === "loading") return <LoadingState />;
  if (state.kind === "error") return <ErrorState onRetry={() => void reload()}>{state.message}</ErrorState>;

  const events = meaningfulEvents(state.data.events);

  if (events.length === 0) return <EmptyState>No recorded activity for this account.</EmptyState>;

  return (
    <>
      <Rows>
        {events.map((event) => (
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
      {state.data.hasMore ? (
        <p className="mt-2 text-xs" style={{ color: "var(--muted)" }}>
          Showing the most recent events.{" "}
          <Link href={`/staff/audit?actor=${userId}`} className="underline">
            See the full log
          </Link>
          .
        </p>
      ) : null}
    </>
  );
}

/** The Overview's five most recent meaningful events. Same loader, no controls. */
export function RecentActivityList({ userId, auth }: { userId: string; auth: Auth }) {
  return <AccountActivity userId={userId} auth={auth} scope="all" limit={5} />;
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
  autoFocusComposer = false,
}: {
  userId: string;
  auth: Auth;
  canWrite: boolean;
  /** Set when the header's "Add note" brought the reader here. */
  autoFocusComposer?: boolean;
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
  const composer = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocusComposer && canWrite) composer.current?.focus();
  }, [autoFocusComposer, canWrite]);

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

  const notes = state.kind === "ready" ? state.data.notes : [];
  const live = notes.filter((note) => !note.archivedAt);
  const archived = notes.filter((note) => note.archivedAt);

  return (
    <Section
      headingLevel={3}
      title="Internal notes"
      description="Staff only. Never shown to the customer, and never sent in an email. A note cannot be edited or deleted once written — archive it instead."
      actions={
        <button type="button" className="ui-chip" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? "Hide archived" : "Show archived"}
        </button>
      }
    >
      {canWrite ? (
        <Card>
          <label className="ui-label" htmlFor="note-body">
            Add a note
          </label>
          <textarea
            id="note-body"
            ref={composer}
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
        notes.length === 0 ? (
          <EmptyState>No internal notes on this account.</EmptyState>
        ) : (
          <>
            <Rows>
              {live.map((note) => (
                <NoteRow key={note.id} note={note} canWrite={canWrite} onArchive={() => void archive(note.id)} />
              ))}
            </Rows>
            {archived.length ? (
              <details className="staff-disclosure mt-3">
                <summary>Archived notes ({archived.length})</summary>
                <div className="staff-disclosure-body">
                  <Rows>
                    {archived.map((note) => (
                      <NoteRow key={note.id} note={note} canWrite={false} onArchive={() => {}} />
                    ))}
                  </Rows>
                </div>
              </details>
            ) : null}
          </>
        )
      ) : null}
    </Section>
  );
}

function NoteRow({
  note,
  canWrite,
  onArchive,
}: {
  note: NoteItem;
  canWrite: boolean;
  onArchive: () => void;
}) {
  return (
    <Row
      title={<span className="whitespace-pre-wrap font-normal">{note.body}</span>}
      meta={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>{note.authorLabel}</span>
          <span>{formatDateTime(note.createdAt)}</span>
          {note.orderNumber ? <span>about {note.orderNumber}</span> : null}
          {note.archivedAt ? (
            <span>
              Archived by {note.archivedByLabel} on {formatDate(note.archivedAt)}
            </span>
          ) : null}
        </span>
      }
      aside={
        <>
          <Badge tone={note.category === "warning" ? "danger" : "neutral"}>
            {NOTE_CATEGORY_LABELS[note.category as NoteCategory] ?? note.category}
          </Badge>
          {canWrite && !note.archivedAt ? (
            <button type="button" className="ui-chip" onClick={onArchive}>
              Archive
            </button>
          ) : null}
          {note.archivedAt ? <Badge tone="neutral">Archived</Badge> : null}
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Support
// ---------------------------------------------------------------------------

type SupportConversationItem = {
  id: string;
  reference: string;
  subject: string;
  category: string;
  status: string;
  priority: string;
  assignedToLabel: string | null;
  relatedOrderNumber: string | null;
  lastMessageAt: string;
  messageCount: number;
  noteCount: number;
};

const OPEN_SUPPORT_STATES = new Set(["open", "waiting_on_staff", "waiting_on_customer"]);

/**
 * This person's support conversations.
 *
 * **A list, not a second copy of the thread.** The conversation lives at
 * `/staff/support/[id]` and that is the only place it is read or replied to;
 * rendering the messages here as well would mean two surfaces to keep right, two
 * places an internal note could be shown by mistake, and a customer's whole
 * correspondence loading on a tab somebody opened to check a role.
 *
 * The data comes from `/api/staff/support?customer=<id>` — the inbox's own
 * endpoint with a filter — rather than a new route. One definition of what a
 * support row is.
 */
export function SupportPanel({ userId, auth }: { userId: string; auth: Auth }) {
  const { state, reload } = usePanel<{ conversations: SupportConversationItem[]; total: number }>(
    `/api/staff/support?customer=${userId}&view=all&sort=recent_activity`,
    auth.token,
    "You do not have permission to view support conversations."
  );

  const grouped = useMemo(() => {
    if (state.kind !== "ready") return { open: [], past: [] };
    return {
      open: state.data.conversations.filter((row) => OPEN_SUPPORT_STATES.has(row.status)),
      past: state.data.conversations.filter((row) => !OPEN_SUPPORT_STATES.has(row.status)),
    };
  }, [state]);

  if (state.kind === "loading") return <LoadingState />;
  if (state.kind === "error") return <ErrorState onRetry={() => void reload()}>{state.message}</ErrorState>;

  const { total } = state.data;

  return (
    <Section
      headingLevel={3}
      title={`Support (${total})`}
      description={
        grouped.open.length
          ? `${grouped.open.length} still open. Open a conversation to read it or reply.`
          : "Nothing open. Open a conversation to read the thread."
      }
      actions={
        <Link href={`/staff/support?customer=${userId}&view=all`} className="ui-btn ui-btn-secondary">
          View all support for this person →
        </Link>
      }
    >
      {total === 0 ? (
        <EmptyState>This account has not contacted support.</EmptyState>
      ) : (
        <>
          {grouped.open.length ? (
            <>
              <p className="text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Open — {grouped.open.length}
              </p>
              <Rows>
                {grouped.open.map((row) => (
                  <SupportRow key={row.id} row={row} />
                ))}
              </Rows>
            </>
          ) : null}

          {grouped.past.length ? (
            <>
              <p className="mt-3 text-xs font-semibold uppercase tracking-wider" style={{ color: "var(--muted)" }}>
                Recent — {grouped.past.length}
              </p>
              <Rows>
                {grouped.past.map((row) => (
                  <SupportRow key={row.id} row={row} />
                ))}
              </Rows>
            </>
          ) : null}
        </>
      )}
    </Section>
  );
}

function SupportRow({ row }: { row: SupportConversationItem }) {
  return (
    <Row
      href={`/staff/support/${row.id}`}
      title={
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs">{row.reference}</span>
          <span>{row.subject}</span>
        </span>
      }
      detail={
        <>
          Updated {formatDateTime(row.lastMessageAt)}
          {row.relatedOrderNumber ? ` · ${row.relatedOrderNumber}` : ""}
          {` · ${row.assignedToLabel ?? "unassigned"}`}
        </>
      }
      aside={
        <>
          {row.priority === "urgent" || row.priority === "high" ? (
            <Badge tone={row.priority === "urgent" ? "danger" : "warning"}>{row.priority}</Badge>
          ) : null}
          <StatusChip value={row.status} />
        </>
      }
    />
  );
}

// ---------------------------------------------------------------------------
// Communications — a view inside Activity
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
  const [showDetail, setShowDetail] = useState(false);

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
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs" style={{ color: "var(--muted)" }}>
          {state.data.total} transactional {state.data.total === 1 ? "message" : "messages"} about this account&apos;s
          orders. Addresses are masked.
        </p>
        <button type="button" className="ui-chip" aria-pressed={showDetail} onClick={() => setShowDetail((v) => !v)}>
          {showDetail ? "Hide delivery detail" : "Advanced"}
        </button>
      </div>

      {message ? (
        <p className="text-xs" aria-live="polite" style={{ color: "var(--muted)" }}>
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
                  {delivery.templateName}
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
                  {/* The masked address and the delivery id are debugging
                      detail, not something a default view needs. */}
                  {showDetail ? <span>{delivery.maskedRecipient}</span> : null}
                  {showDetail ? <span className="font-mono">{delivery.id}</span> : null}
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
                          {busy === delivery.id ? "Sending…" : "Send it again"}
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
    </>
  );
}
