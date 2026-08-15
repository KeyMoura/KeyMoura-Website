"use client";

import { FormEvent, use, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";

import { AccessDeniedCard } from "@/components/AccessDeniedCard";
import {
  Card,
  ErrorState,
  Fact,
  Facts,
  LoadingState,
  PageHeader,
  Section,
  StaffPage,
} from "@/components/staff/StaffPage";
import { Badge } from "@/components/ui/DesignSystem";
import { MenuSelect } from "@/components/ui/MenuSelect";
import { useMeAccess } from "@/lib/hooks/useMeAccess";
import { supabaseBrowser } from "@/lib/supabaseClient";
import {
  MAX_SUPPORT_MESSAGE_LENGTH,
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_STATUSES,
  SUPPORT_STATUS_LABELS,
  SUPPORT_STATUS_MEANING,
  formatSupportAge,
  type SupportCategory,
  type SupportPriority,
  type SupportStatus,
} from "@/lib/support/domain";

/**
 * The staff conversation workspace.
 *
 * ## Two composers, never one
 *
 * A reply and an internal note are separate forms posting to separate endpoints,
 * and the note composer is visibly different — a warning-toned surface that says
 * who will not see it. A single box with a "send to customer" checkbox is the
 * design that eventually mails a staff note to a customer, because the checkbox
 * is one keystroke and the consequence is irreversible.
 *
 * ## Everything reloads from the server
 *
 * No local mutation of the thread. After any action the whole conversation is
 * re-fetched, so what is on screen is what the database holds — including the
 * status the state machine moved to as a *consequence* of the reply, which the
 * browser has no business guessing.
 *
 * ## Stale state is carried, not assumed
 *
 * Each control sends what it believed the value was. Two staff members deciding
 * at once produce one change and one honest 409, rather than the second silently
 * overwriting the first with neither of them knowing.
 */

type Message = {
  id: string;
  author_type: "customer" | "staff" | "system";
  author_user_id: string | null;
  author_label: string;
  visibility: "customer" | "internal";
  body: string;
  created_at: string;
};

type RelatedOrder = {
  id: string;
  order_number: string | null;
  product_name: string;
  status: string;
  payment_status: string;
  fulfillment_status: string;
  created_at: string;
  customer_id: string | null;
  guest_email: string | null;
};

type CustomerSummary = {
  id: string;
  display_name: string | null;
  username: string | null;
  avatar_url: string | null;
  is_verified: boolean | null;
  created_at: string;
  orderCount: number;
  conversationCount: number;
};

type Conversation = {
  id: string;
  reference: string;
  subject: string;
  category: SupportCategory;
  status: SupportStatus;
  priority: SupportPriority;
  customer_id: string | null;
  guest_email: string | null;
  guest_name: string | null;
  requester_label: string;
  requester_email: string | null;
  related_order_id: string | null;
  assigned_to: string | null;
  assigned_to_label: string | null;
  created_at: string;
  last_message_at: string;
  relatedOrder: RelatedOrder | null;
  customer: CustomerSummary | null;
};

type Capabilities = { reply: boolean; manage: boolean; assign: boolean };

type Assignee = { id: string; label: string; isSelf: boolean };

type Loaded = { conversation: Conversation; messages: Message[]; can: Capabilities };

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

function newToken(): string {
  return `stf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export default function StaffSupportConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: access, isLoading: accessLoading } = useMeAccess();
  const permissions = useMemo(() => new Set(access?.permissions ?? []), [access]);
  const canView = permissions.has("support.view");

  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [data, setData] = useState<Loaded | null>(null);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: "danger" | "success"; text: string } | null>(null);
  const [replyToken, setReplyToken] = useState(newToken);
  const [noteToken, setNoteToken] = useState(newToken);

  const authHeaders = useCallback(async (): Promise<Record<string, string> | null> => {
    const { data: session } = await supabaseBrowser().auth.getSession();
    const token = session?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : null;
  }, []);

  const load = useCallback(async () => {
    const headers = await authHeaders();
    if (!headers) {
      setState("error");
      return;
    }
    try {
      const res = await fetch(`/api/staff/support/${id}`, { headers });
      if (res.status === 404) {
        setState("missing");
        return;
      }
      if (!res.ok) throw new Error("failed");
      setData((await res.json()) as Loaded);
      setState("ready");
    } catch {
      setState("error");
    }
  }, [authHeaders, id]);

  useEffect(() => {
    if (accessLoading || !canView) return;
    void load();
  }, [accessLoading, canView, load]);

  useEffect(() => {
    if (accessLoading || !canView) return;
    void (async () => {
      const headers = await authHeaders();
      if (!headers) return;
      try {
        const res = await fetch("/api/staff/support/assignees", { headers });
        if (!res.ok) return;
        const body = (await res.json()) as { assignees?: Assignee[] };
        setAssignees(body.assignees ?? []);
      } catch {
        /* The dropdown falls back to "Unassigned"; the page still works. */
      }
    })();
  }, [accessLoading, authHeaders, canView]);

  /** One place that talks to the write endpoints, so every action reloads and reports the same way. */
  const act = useCallback(
    async (path: string, body: Record<string, unknown>, success: string) => {
      setBusy(true);
      setNotice(null);
      try {
        const headers = await authHeaders();
        if (!headers) throw new Error("Sign in again.");
        const res = await fetch(path, {
          method: path.endsWith(`/staff/support/${id}`) ? "PATCH" : "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const json = (await res.json()) as { error?: string; auditFailed?: boolean };
        if (!res.ok) throw new Error(json.error || "That did not work.");
        await load();
        setNotice({
          tone: json.auditFailed ? "danger" : "success",
          // An unlogged change is never reported as a clean success. The action
          // happened; the operator is told the record of it did not.
          text: json.auditFailed ? `${success}, but the audit record failed to save.` : success,
        });
      } catch (caught) {
        setNotice({ tone: "danger", text: caught instanceof Error ? caught.message : "That did not work." });
      } finally {
        setBusy(false);
      }
    },
    [authHeaders, id, load]
  );

  if (accessLoading || state === "loading") {
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

  if (state === "missing") {
    return (
      <StaffPage>
        <PageHeader title="Conversation not found" description="It may have been opened on a different site." />
        <Link href="/staff/support" className="ui-btn ui-btn-secondary">
          Back to support
        </Link>
      </StaffPage>
    );
  }

  if (state === "error" || !data) {
    return (
      <StaffPage>
        <ErrorState onRetry={() => void load()}>Could not load this conversation.</ErrorState>
      </StaffPage>
    );
  }

  const { conversation, messages, can } = data;

  const submitReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("body") ?? "");
    await act(`/api/staff/support/${id}/reply`, { body: value, clientToken: replyToken }, "Reply sent.");
    form.reset();
    setReplyToken(newToken());
  };

  const submitNote = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const value = String(new FormData(form).get("body") ?? "");
    await act(`/api/staff/support/${id}/notes`, { body: value, clientToken: noteToken }, "Note added.");
    form.reset();
    setNoteToken(newToken());
  };

  return (
    <StaffPage>
      <PageHeader
        title={
          <span className="flex flex-wrap items-baseline gap-3">
            <span className="font-mono text-brand-primary">{conversation.reference}</span>
            <span>{conversation.subject}</span>
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{conversation.requester_label}</span>
            {conversation.customer_id ? (
              <Link href={`/staff/users/${conversation.customer_id}`} className="text-brand-primary hover:underline">
                View account
              </Link>
            ) : (
              <Badge tone="neutral">Guest</Badge>
            )}
            {conversation.requester_email ? (
              <span className="text-brand-textMuted">{conversation.requester_email}</span>
            ) : null}
          </span>
        }
        actions={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={STATUS_TONE[conversation.status]}>{SUPPORT_STATUS_LABELS[conversation.status]}</Badge>
            <Badge tone={PRIORITY_TONE[conversation.priority]}>
              {SUPPORT_PRIORITY_LABELS[conversation.priority]}
            </Badge>
          </span>
        }
      />

      {notice ? (
        <p
          role="status"
          className={`rounded-xl border px-4 py-3 text-sm ${
            notice.tone === "danger"
              ? "border-rose-500/40 bg-rose-500/10 text-rose-200"
              : "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
          }`}
        >
          {notice.text}
        </p>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        {/* --- the conversation ------------------------------------------------ */}
        <div className="space-y-6">
          <Section title="Conversation" description={`Opened ${formatSupportAge(conversation.created_at)}.`}>
            <ol className="space-y-3">
              {messages.map((message) => (
                <li
                  key={message.id}
                  className={`rounded-xl border p-4 ${
                    message.visibility === "internal"
                      ? // Visibly different, deliberately. A note that looks like
                        // a reply is a note somebody will eventually send as one.
                        "border-amber-500/40 bg-amber-500/[.07]"
                      : message.author_type === "customer"
                        ? "border-[var(--border)] bg-[var(--panel)]"
                        : message.author_type === "system"
                          ? "border-[var(--border)] bg-[var(--panel)] text-brand-textMuted"
                          : "border-brand-primary/30 bg-brand-primary/5"
                  }`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="text-sm font-semibold">
                      {message.author_label}
                      {/* The tone stays amber — this must not look like a reply.
                          Only the pill's geometry joins the rest of the app. */}
                      {message.visibility === "internal" ? (
                        <span className="ui-badge ui-badge-warning ml-2">
                          Internal note · the customer cannot see this
                        </span>
                      ) : null}
                      {message.author_type === "system" ? (
                        <span className="ml-2 text-xs font-normal text-brand-textMuted">system</span>
                      ) : null}
                    </span>
                    <span className="text-xs text-brand-textMuted">{formatSupportAge(message.created_at)}</span>
                  </div>
                  {/* Text, never markup. Both a customer's words and a staff
                      member's appear on this page. */}
                  <p className="mt-2 whitespace-pre-wrap leading-7">{message.body}</p>
                </li>
              ))}
            </ol>
          </Section>

          {can.reply ? (
            <>
              <Section
                title="Reply to the customer"
                description="This is emailed to them and cannot be edited afterwards."
                headingLevel={3}
              >
                <form onSubmit={submitReply}>
                  <label className="sr-only" htmlFor="support-reply">
                    Reply
                  </label>
                  <textarea
                    id="support-reply"
                    name="body"
                    required
                    maxLength={MAX_SUPPORT_MESSAGE_LENGTH}
                    className="ui-input min-h-32 w-full"
                    placeholder="Write to the customer."
                  />
                  <button disabled={busy} className="ui-btn ui-btn-primary mt-3 disabled:opacity-60">
                    {busy ? "Working…" : "Send reply"}
                  </button>
                </form>
              </Section>

              <Section
                title="Internal note"
                description="Staff only. Never emailed, never shown to the customer, and cannot be edited or deleted."
                headingLevel={3}
              >
                <form onSubmit={submitNote}>
                  <label className="sr-only" htmlFor="support-note">
                    Internal note
                  </label>
                  <textarea
                    id="support-note"
                    name="body"
                    required
                    maxLength={MAX_SUPPORT_MESSAGE_LENGTH}
                    className="ui-input min-h-24 w-full border-amber-500/40 bg-amber-500/[.05]"
                    placeholder="Context for whoever picks this up next."
                  />
                  <button disabled={busy} className="ui-btn ui-btn-secondary mt-3 disabled:opacity-60">
                    {busy ? "Working…" : "Add internal note"}
                  </button>
                </form>
              </Section>
            </>
          ) : null}
        </div>

        {/* --- the side panel --------------------------------------------------- */}
        <div className="space-y-6">
          <Section title="State" headingLevel={3}>
            <Card className="space-y-4 p-4">
              <label className="block text-sm">
                Status
                <MenuSelect
                  ariaLabel="Change status"
                  className="mt-1"
                  disabled={!can.manage || busy}
                  value={conversation.status}
                  options={SUPPORT_STATUSES.map((s) => ({ value: s, label: SUPPORT_STATUS_LABELS[s] }))}
                  onChange={(value) =>
                    void act(
                      `/api/staff/support/${id}`,
                      { status: value, expectedStatus: conversation.status },
                      `Status changed to ${SUPPORT_STATUS_LABELS[value as SupportStatus].toLowerCase()}.`
                    )
                  }
                />
                <span className="mt-1 block text-xs text-brand-textMuted">
                  {SUPPORT_STATUS_MEANING[conversation.status]}
                </span>
              </label>

              <label className="block text-sm">
                Priority
                <MenuSelect
                  ariaLabel="Change priority"
                  className="mt-1"
                  disabled={!can.manage || busy}
                  value={conversation.priority}
                  options={SUPPORT_PRIORITIES.map((p) => ({ value: p, label: SUPPORT_PRIORITY_LABELS[p] }))}
                  onChange={(value) =>
                    void act(
                      `/api/staff/support/${id}`,
                      { priority: value, expectedPriority: conversation.priority },
                      `Priority set to ${SUPPORT_PRIORITY_LABELS[value as SupportPriority].toLowerCase()}.`
                    )
                  }
                />
              </label>

              <label className="block text-sm">
                Category
                <MenuSelect
                  ariaLabel="Change category"
                  className="mt-1"
                  disabled={!can.manage || busy}
                  value={conversation.category}
                  options={SUPPORT_CATEGORIES.map((c) => ({ value: c, label: SUPPORT_CATEGORY_LABELS[c] }))}
                  onChange={(value) =>
                    void act(`/api/staff/support/${id}`, { category: value }, "Category changed.")
                  }
                />
              </label>

              <label className="block text-sm">
                Assigned to
                <MenuSelect
                  ariaLabel="Assign this conversation"
                  className="mt-1"
                  disabled={!can.assign || busy}
                  value={conversation.assigned_to ?? ""}
                  options={[
                    { value: "", label: "Unassigned" },
                    ...assignees.map((person) => ({
                      value: person.id,
                      label: person.isSelf ? `${person.label} (me)` : person.label,
                    })),
                  ]}
                  onChange={(value) =>
                    void act(
                      `/api/staff/support/${id}/assign`,
                      { assigneeId: value || null, expectedAssigneeId: conversation.assigned_to },
                      value ? "Assigned." : "Unassigned."
                    )
                  }
                />
              </label>
            </Card>
          </Section>

          <Section title="Customer" headingLevel={3}>
            <Card className="p-4">
              {conversation.customer ? (
                <Facts>
                  <Fact label="Account">
                    <Link href={`/staff/users/${conversation.customer.id}`} className="text-brand-primary hover:underline">
                      {conversation.customer.display_name ?? conversation.customer.username ?? "Open account"}
                    </Link>
                  </Fact>
                  <Fact label="Orders">{conversation.customer.orderCount}</Fact>
                  <Fact label="Support requests">{conversation.customer.conversationCount}</Fact>
                  <Fact label="Member since">{formatSupportAge(conversation.customer.created_at)}</Fact>
                </Facts>
              ) : (
                <Facts>
                  <Fact label="Requester">{conversation.requester_label}</Fact>
                  <Fact label="Email">{conversation.requester_email ?? "—"}</Fact>
                  <Fact label="Account">
                    {/* Stated rather than guessed. An address matching an account
                        is not proof it belongs to the person who typed it. */}
                    <span className="text-brand-textMuted">Guest — no account is claimed by this address</span>
                  </Fact>
                </Facts>
              )}
              {conversation.customer_id ? (
                <Link
                  href={`/staff/support?customer=${conversation.customer_id}&view=all`}
                  className="mt-3 inline-flex text-sm font-semibold text-brand-primary hover:underline"
                >
                  All their conversations →
                </Link>
              ) : null}
            </Card>
          </Section>

          <Section title="Related order" headingLevel={3}>
            <Card className="p-4">
              {conversation.relatedOrder ? (
                <>
                  <Facts>
                    <Fact label="Order">
                      <Link
                        href={`/staff/orders/${conversation.relatedOrder.id}`}
                        className="text-brand-primary hover:underline"
                      >
                        {conversation.relatedOrder.order_number ?? "Open order"}
                      </Link>
                    </Fact>
                    <Fact label="Product">{conversation.relatedOrder.product_name}</Fact>
                    <Fact label="Status">{conversation.relatedOrder.status.replaceAll("_", " ")}</Fact>
                    <Fact label="Payment">{conversation.relatedOrder.payment_status.replaceAll("_", " ")}</Fact>
                  </Facts>
                  {can.manage ? (
                    <button
                      type="button"
                      disabled={busy}
                      className="ui-btn ui-btn-ghost mt-3 disabled:opacity-60"
                      onClick={() =>
                        void act(`/api/staff/support/${id}`, { relatedOrderId: null }, "Order unlinked.")
                      }
                    >
                      Unlink this order
                    </button>
                  ) : null}
                </>
              ) : (
                <LinkOrderForm
                  disabled={!can.manage || busy}
                  onLink={(orderId) =>
                    void act(`/api/staff/support/${id}`, { relatedOrderId: orderId }, "Order linked.")
                  }
                />
              )}
            </Card>
          </Section>

          <Section title="History" headingLevel={3}>
            <Card className="p-4">
              <p className="text-sm text-brand-textMuted">
                Every status, priority, assignment and link change on this conversation is recorded in the audit log,
                with who did it and what it was before.
              </p>
              <Link
                href={`/staff/audit?area=support&q=${conversation.reference}`}
                className="mt-3 inline-flex text-sm font-semibold text-brand-primary hover:underline"
              >
                Audit history for {conversation.reference} →
              </Link>
            </Card>
          </Section>
        </div>
      </div>

      <Link href="/staff/support" className="ui-btn ui-btn-ghost">
        ← Back to support
      </Link>
    </StaffPage>
  );
}

/**
 * Linking an order by its number.
 *
 * A number rather than a picker: the staff member is usually reading the number
 * off the customer's message, and a dropdown of every order in the shop is not a
 * control, it is a scroll. The number is resolved to an id here and the id is
 * re-checked by the route.
 */
function LinkOrderForm({ disabled, onLink }: { disabled: boolean; onLink: (orderId: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState("");
  const [looking, setLooking] = useState(false);

  const find = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    setLooking(true);
    try {
      const { data: session } = await supabaseBrowser().auth.getSession();
      const token = session?.session?.access_token;
      if (!token) throw new Error("Sign in again.");
      // `q` and `size` are `orderFilters.PARAM`'s names. The order list's own
      // query model is reused rather than a second search being written here.
      const res = await fetch(`/api/staff/orders?q=${encodeURIComponent(value.trim())}&size=5`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error("Could not look that order up.");
      const body = (await res.json()) as { orders?: { id: string; order_number: string | null }[] };
      const match = (body.orders ?? [])[0];
      if (!match) throw new Error("No order matched that number.");
      onLink(match.id);
      setValue("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not look that order up.");
    } finally {
      setLooking(false);
    }
  };

  if (disabled) return <p className="text-sm text-brand-textMuted">No order is linked.</p>;

  return (
    <form onSubmit={find}>
      <label className="block text-sm">
        Link an order
        <input
          className="ui-input mt-1 w-full"
          placeholder="KM-0012"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-rose-200">
          {error}
        </p>
      ) : null}
      <button disabled={looking || !value.trim()} className="ui-btn ui-btn-secondary mt-3 disabled:opacity-60">
        {looking ? "Looking…" : "Link order"}
      </button>
    </form>
  );
}
