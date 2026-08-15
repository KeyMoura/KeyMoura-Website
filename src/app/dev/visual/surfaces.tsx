"use client";

import {
  Card,
  Facts,
  Fact,
  PageHeader,
  Row,
  Rows,
  Section,
  StatusChip,
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/staff/StaffPage";
import { Badge, Field, MetricCard, Notice } from "@/components/ui/DesignSystem";

/**
 * Page-level surfaces, built from the real shared components.
 *
 * The 3.0 pass verified *roles* — that a button reads the right variable. This
 * file exists for the question that could not answer: whether an actual page's
 * composition holds up at width. Each block below is the same structure the
 * named route renders, so measuring it measures the page.
 *
 * Where a route hand-rolls markup inline (the audit row, the production board
 * row) the classes are reproduced exactly rather than approximated, and a
 * structural test asserts the page still uses them — a harness that quietly
 * diverged from the page it claims to represent would be worse than no harness.
 */

export function Surface({ id, title, note, children }: { id: string; title: string; note?: string; children: React.ReactNode }) {
  return (
    <section id={id} data-surface={id} className="staff-section">
      <div className="staff-section-head">
        <div className="min-w-0">
          <h2 className="staff-section-title">{title}</h2>
          {note ? <p className="staff-section-description">{note}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

/* ---------------------------------------------------------------- headers */

export function PageHeaderSurface() {
  return (
    <div className="grid gap-6" data-probe="page-headers">
      <PageHeader
        title="Orders"
        description="Everything customers have bought, and what each one is waiting on."
        actions={
          <>
            <button type="button" className="ui-btn ui-btn-primary">Create proposal</button>
            <button type="button" className="ui-btn ui-btn-ghost">Export</button>
          </>
        }
      />
      <PageHeader title="Audit log" description="Recent activity across KeyMoura." />
      <PageHeader
        kind="Business tools"
        title="Reconciliation"
        description="A read-only instrument. Nothing here changes an order."
      />
    </div>
  );
}

/* --------------------------------------------------------------- toolbars */

export function ToolbarSurface() {
  return (
    <div className="grid gap-3" data-probe="toolbar">
      <div className="staff-toolbar">
        <div className="staff-toolbar-search">
          <input className="ui-input" placeholder="Search orders, customers, SKUs…" aria-label="Search" />
        </div>
        <button type="button" className="ui-select-trigger w-auto">Any status</button>
        <button type="button" className="ui-select-trigger w-auto">Any assignee</button>
        <button type="button" className="ui-btn ui-btn-ghost">More filters</button>
        <button type="button" className="ui-btn ui-btn-ghost">Clear</button>
      </div>
      <div className="staff-filter-panel">
        <Field label="From"><input type="date" className="ui-input" /></Field>
        <Field label="To"><input type="date" className="ui-input" /></Field>
        <Field label="Priority"><button type="button" className="ui-select-trigger">Any</button></Field>
        <Field label="Machine"><button type="button" className="ui-select-trigger">Any</button></Field>
      </div>
      <p className="staff-row-meta">128 orders · 12 need attention</p>
    </div>
  );
}

/* ------------------------------------------------------- production board */

const boardJobs = [
  { id: "j1", number: "JOB-1042", title: "Billet Shift Knob", order: "KM-0231", who: "Sam Ortiz", status: "in_progress", priority: "urgent", blocker: null, done: 3, total: 7, qc: 1, due: "Due tomorrow" },
  { id: "j2", number: "JOB-1043", title: "Adjustable Rear Subframe Alignment Fixture With Extended Arms", order: null, who: null, status: "blocked", priority: "high", blocker: "Waiting on 6061 stock", done: 0, total: 12, qc: 0, due: "Due in 6 days" },
  { id: "j3", number: "JOB-1044", title: "Pedal Spacer", order: "KM-0233", who: "Ali Chen", status: "queued", priority: "normal", blocker: null, done: 0, total: 4, qc: 0, due: "No due date" },
];

export function ProductionBoardSurface() {
  return (
    <div className="staff-rows" data-probe="production-board">
      {boardJobs.map((job) => (
        <a key={job.id} href="#production" className="staff-row">
          <div className="staff-row-main">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs text-brand-textMuted">{job.number}</span>
              <span className="staff-row-title">{job.title}</span>
              <span className="staff-row-meta">× 2</span>
            </div>
            <div className="staff-row-detail">
              {job.order ? <span className="text-brand-accent">Order {job.order}</span> : <span>No source order</span>}
              {job.who ? ` · ${job.who}` : " · Unassigned"}
            </div>
            {job.blocker ? <div className="staff-row-meta mt-1 text-amber-200">{job.blocker}</div> : null}
          </div>
          <div className="staff-row-aside flex-col !items-start gap-1 sm:!items-end">
            <span className="flex flex-wrap gap-1.5">
              <StatusChip value={job.status} />
              <Badge tone={job.priority === "urgent" ? "danger" : job.priority === "high" ? "warning" : "neutral"}>
                {job.priority}
              </Badge>
            </span>
            <span className="text-xs">{job.due}</span>
            <span className="text-xs tabular-nums text-brand-textMuted">
              {job.done} / {job.total} tasks{job.qc ? " · QC waiting" : ""}
            </span>
          </div>
        </a>
      ))}
    </div>
  );
}

export function ProductionTableSurface() {
  return (
    <div className="ui-table-wrap" data-probe="production-table">
      <table className="ui-table min-w-[940px]">
        <caption className="sr-only">Production jobs, one row per job</caption>
        <thead>
          <tr>
            {["Job", "Order", "Item", "Status", "Priority", "Assignee", "Machine", "Due"].map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
            <th scope="col" className="is-numeric">Progress</th>
            <th scope="col">Updated</th>
          </tr>
        </thead>
        <tbody>
          {boardJobs.map((job) => (
            <tr key={job.id}>
              <td><span className="font-mono text-brand-accent">{job.number}</span></td>
              <td>{job.order ?? "Stock"}</td>
              <td className="max-w-64 truncate" title={job.title}>{job.title}</td>
              <td><StatusChip value={job.status} /></td>
              <td><Badge tone={job.priority === "urgent" ? "danger" : "neutral"}>{job.priority}</Badge></td>
              <td>{job.who ?? "Unassigned"}</td>
              <td className="text-brand-textMuted">Not assigned</td>
              <td>{job.due}</td>
              <td className="is-numeric">{job.done} / {job.total}</td>
              <td className="whitespace-nowrap text-brand-textMuted">14 Aug 2026</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* -------------------------------------------------------------- audit log */

const auditEvents = [
  { id: "a1", actor: "Ethan Moura", badge: "Admin", action: "changed the price of", entity: "Billet Shift Knob", sensitive: false, summary: "$84.00 → $89.00", when: "12 minutes ago" },
  { id: "a2", actor: "System", badge: null, action: "granted the role", entity: "support", sensitive: true, summary: "Role hierarchy updated for 1 account", when: "2 hours ago" },
];

export function AuditSurface() {
  return (
    <div className="staff-rows" data-probe="audit">
      {auditEvents.map((event) => (
        <div key={event.id} className="staff-row-plain">
          <button
            type="button"
            className="flex w-full flex-col gap-1 px-3 py-2.5 text-left transition hover:bg-[var(--panel-strong)] sm:flex-row sm:items-center sm:gap-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-[13px] font-medium text-brand-text">{event.actor}</span>
                {event.badge ? <Badge>{event.badge}</Badge> : null}
                <span className="text-[13px] text-[var(--text)]">{event.action}</span>
                <span className="font-mono text-[12px] text-brand-accent">{event.entity}</span>
                {event.sensitive ? <Badge tone="warning">Security</Badge> : null}
              </div>
              <div className="staff-row-detail">{event.summary}</div>
            </div>
            <time className="shrink-0 staff-row-meta sm:text-right">{event.when}</time>
          </button>
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------- directory */

const people = [
  { id: "u1", name: "Ethan Moura", email: "ethan@keymoura.com", role: "Administrator", staff: true, status: "active", spend: "$4,182.00", orders: 14, open: 2, seen: "2 minutes ago" },
  { id: "u2", name: "A Customer With A Genuinely Very Long Display Name", email: "someone.with.a.long.address@example-domain.co.uk", role: "Customer", staff: false, status: "suspended", spend: "$96.00", orders: 1, open: 0, seen: "3 months ago" },
];

export function DirectorySurface() {
  return (
    <div className="staff-people" data-probe="directory">
      {people.map((person) => (
        <a key={person.id} href="#users" className="staff-person">
          <span className="staff-person-avatar">
            <span className="block h-8 w-8 rounded-full border border-[var(--border)] bg-[var(--panel-strong)]" />
          </span>
          <span className="staff-person-identity">
            <span className="staff-person-name">{person.name}</span>
            <span className="staff-person-email">{person.email}</span>
          </span>
          <span className="staff-person-role">
            <Badge tone={person.staff ? "accent" : "neutral"}>{person.role}</Badge>
            {person.status !== "active" ? <StatusChip value="failed" label="Suspended" /> : null}
          </span>
          <span className="staff-person-commerce">
            <strong>{person.spend}</strong>
            {" · "}
            {person.orders} {person.orders === 1 ? "order" : "orders"}
            {person.open > 0 ? ` (${person.open} open)` : ""}
          </span>
          <span className="staff-person-seen">{person.seen}</span>
        </a>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- support */

export function SupportInboxSurface() {
  return (
    <Rows data-probe="support-inbox">
      {[
        { id: "s1", subject: "Where is my order?", who: "ethan@keymoura.com", status: "open", priority: "urgent", notes: 2 },
        { id: "s2", subject: "Can this be anodised in a different colour before it ships next week?", who: "guest@example.com", status: "pending", priority: "normal", notes: 0 },
      ].map((row) => (
        <Row
          key={row.id}
          href="#support"
          title={row.subject}
          detail={row.who}
          meta={
            <span className="flex flex-wrap items-center gap-2">
              <span>Order question</span>
              <span aria-hidden>·</span>
              <span>4 hours ago</span>
              <span aria-hidden>·</span>
              <span>Unassigned</span>
              {row.notes ? (
                <>
                  <span aria-hidden>·</span>
                  <span>{row.notes} notes</span>
                </>
              ) : null}
            </span>
          }
          aside={
            <span className="flex flex-wrap items-center justify-end gap-2">
              {row.priority !== "normal" ? <Badge tone="danger">Urgent</Badge> : null}
              <StatusChip value={row.status} />
            </span>
          }
        />
      ))}
    </Rows>
  );
}

export function SupportThreadSurface() {
  return (
    <ol className="space-y-3" data-probe="support-thread">
      {[
        { id: "m1", who: "ethan@keymoura.com", kind: "customer", body: "Hi — could you tell me when this is likely to ship?", when: "4 hours ago" },
        { id: "m2", who: "You", kind: "staff", body: "It goes out on Friday. I'll send tracking as soon as it's scanned.", when: "2 hours ago" },
        { id: "m3", who: "You", kind: "internal", body: "Stock arrives Thursday — do not promise earlier than Friday.", when: "1 hour ago" },
      ].map((message) => (
        <li
          key={message.id}
          data-message-kind={message.kind}
          className={`rounded-xl border p-4 ${
            message.kind === "internal"
              ? "border-amber-500/40 bg-amber-500/[.07]"
              : message.kind === "customer"
                ? "border-[var(--border)] bg-[var(--panel)]"
                : "border-brand-primary/30 bg-brand-primary/5"
          }`}
        >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-sm font-semibold">
              {message.who}
              {message.kind === "internal" ? (
                <span className="ui-badge ui-badge-warning ml-2">
                  Internal note · the customer cannot see this
                </span>
              ) : null}
            </span>
            <span className="text-xs text-brand-textMuted">{message.when}</span>
          </div>
          <p className="mt-2 whitespace-pre-wrap leading-7">{message.body}</p>
        </li>
      ))}
    </ol>
  );
}

export function SupportComposerSurface() {
  return (
    <div className="grid gap-3">
      <Card>
        <Field label="Reply">
          <textarea className="ui-input" rows={3} placeholder="Write a reply…" />
        </Field>
        <div className="ui-action-row mt-3">
          <button type="button" className="ui-btn ui-btn-primary">Send reply</button>
          <button type="button" className="ui-btn ui-btn-ghost">Add internal note</button>
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- analytics */

export function AnalyticsSurface() {
  return (
    <div className="grid gap-4" data-probe="analytics">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Revenue" value="$12,480" detail="+8% vs previous 30 days" />
        <MetricCard label="Orders" value="128" detail="+3% vs previous 30 days" />
        <MetricCard label="Average order" value="$97.50" detail="−2% vs previous 30 days" tone="warning" />
        <MetricCard label="Refunds" value="$310" detail="2 refunds" tone="danger" />
      </div>
      <Card>
        <h3 className="staff-section-title">Revenue by day</h3>
        <div className="mt-3 h-40 rounded-lg border border-[var(--border)] bg-[var(--panel-strong)]" role="img" aria-label="Chart placeholder" />
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------- automation */

export function AutomationSurface() {
  return (
    <div className="grid gap-3" data-probe="automation">
      {[
        { id: "r1", name: "Email the customer when a job completes", on: true, runs: 42, last: "12 minutes ago" },
        { id: "r2", name: "Flag orders with no production job after 48 hours", on: false, runs: 0, last: "Never run" },
      ].map((rule) => (
        <Card key={rule.id}>
          <div className="staff-section-head">
            <div className="min-w-0">
              <h3 className="staff-section-title">{rule.name}</h3>
              <p className="staff-section-description">Trigger: job status changes · Action: send email</p>
            </div>
            <div className="staff-section-actions">
              <Badge tone={rule.on ? "success" : "neutral"}>{rule.on ? "Enabled" : "Paused"}</Badge>
              <button type="button" className="ui-btn ui-btn-ghost">Edit</button>
            </div>
          </div>
          <Facts className="mt-3">
            <Fact label="Runs">{rule.runs}</Fact>
            <Fact label="Last run">{rule.last}</Fact>
            <Fact label="Owner">System</Fact>
          </Facts>
        </Card>
      ))}
    </div>
  );
}

/* --------------------------------------------------------------- customer */

export function CustomerOrderSurface() {
  return (
    <div className="grid gap-4" data-probe="customer-order">
      <header className="staff-record-header">
        <div className="staff-record-top">
          <div className="min-w-0">
            <p className="staff-record-eyebrow">Order KM-0231</p>
            <h2 className="staff-record-title">Billet Shift Knob</h2>
            <p className="staff-row-meta mt-1">Placed 12 August 2026</p>
          </div>
          <div className="staff-record-states">
            <StatusChip value="in_progress" prefix="Order" />
            <StatusChip value="paid" prefix="Payment" />
          </div>
        </div>
      </header>
      <Card>
        <Facts>
          <Fact label="Total">$89.00</Fact>
          <Fact label="Payment">Paid · Visa ····4242</Fact>
          <Fact label="Fulfilment">Ships Friday</Fact>
          <Fact label="Lead time">3 days</Fact>
        </Facts>
      </Card>
      <Rows>
        <Row
          title="Billet Shift Knob"
          detail="Anodised black · M10 insert"
          aside={<span className="staff-row-figure">$89.00</span>}
        />
      </Rows>
    </div>
  );
}

/* ------------------------------------------------------------------ states */

export function StatesSurface() {
  return (
    <div className="grid gap-3" data-probe="states">
      <EmptyState>No products match this view.</EmptyState>
      <LoadingState>Loading the production queue…</LoadingState>
      <ErrorState>Products are not shown because the catalog could not be loaded. This is not the same as the catalog being empty.</ErrorState>
      <Notice tone="warning">Two jobs are blocked and need a decision.</Notice>
    </div>
  );
}

export function StaffSurfaces() {
  return (
    <>
      <Surface id="page-headers" title="Page headers" note="Orders, Audit log, and a Business tool — the three header shapes.">
        <PageHeaderSurface />
      </Surface>
      <Surface id="toolbars" title="Toolbars and filters">
        <ToolbarSurface />
      </Surface>
      <Surface id="production-board" title="Production board rows">
        <ProductionBoardSurface />
      </Surface>
      <Surface id="production-table" title="Production list table">
        <ProductionTableSurface />
      </Surface>
      <Surface id="audit" title="Audit log rows">
        <AuditSurface />
      </Surface>
      <Surface id="directory" title="User directory rows">
        <DirectorySurface />
      </Surface>
      <Surface id="support-inbox" title="Support inbox">
        <SupportInboxSurface />
      </Surface>
      <Surface id="support-thread" title="Support conversation" note="Customer-visible, staff reply, and an internal note.">
        <SupportThreadSurface />
        <SupportComposerSurface />
      </Surface>
      <Surface id="analytics" title="Analytics">
        <AnalyticsSurface />
      </Surface>
      <Surface id="automation" title="Automation rules">
        <AutomationSurface />
      </Surface>
      <Surface id="customer-order" title="Customer order detail">
        <CustomerOrderSurface />
      </Surface>
      <Surface id="states" title="Empty, loading and error states">
        <StatesSurface />
      </Surface>
      <Section title="Fulfillment queue">
        <Rows data-probe="fulfillment">
          <Row
            href="#fulfillment"
            title="Billet Shift Knob"
            detail="KM-0231 · Ethan Moura"
            meta="Ready to ship · Royal Mail Tracked 48"
            aside={
              <span className="flex flex-wrap items-center justify-end gap-2">
                <Badge tone="accent">Shipping</Badge>
                <Badge tone="danger">No tracking</Badge>
              </span>
            }
          />
          <Row
            href="#fulfillment"
            title="Pedal Spacer"
            detail="KM-0233 · Collection"
            meta="Awaiting pickup"
            aside={<StatusChip value="pending" />}
          />
        </Rows>
      </Section>
    </>
  );
}
