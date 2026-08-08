import type { HTMLAttributes, ReactNode } from "react";

import { Badge, EmptyState, Notice, cx } from "@/components/ui/DesignSystem";
import {
  availableTabs,
  stateText,
  stateTone,
  type ChipTone,
  type StaffTab,
} from "@/lib/staff/pageFramework";

/**
 * The staff application's shared page vocabulary.
 *
 * ## Why this file exists
 *
 * Every staff page used to build its own chrome. `/staff/orders` opened with
 * `<p className="ui-eyebrow">Today</p>` above a `text-3xl` heading;
 * `/staff/settings/commerce` used the same eyebrow with the word "Commerce";
 * `/staff/catalog` used it for "Commerce" too, on a page that is not the same
 * section. The result was seven pages that shared a stylesheet and nothing else
 * — the reason the staff area reads as a collection rather than an application.
 *
 * These components are deliberately thin. They own **structure and spacing**
 * and nothing about data: no fetching, no permission checks, no state. That
 * keeps them usable from a server component and keeps the pages honest about
 * where their decisions are made.
 *
 * ## The nesting rule
 *
 * `Section` draws **no border**. Grouping is done with a heading and
 * whitespace, and a border is added only by wrapping content in `Card` — which
 * a `Section` never does for you. That is what stops the
 * card-inside-card-inside-card stacking: a page cannot accidentally produce it,
 * because producing it requires deliberately nesting two `Card`s.
 */

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** The page root. Owns the vertical rhythm every staff page now shares. */
export function StaffPage({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <main className={cx("staff-page", className)} {...props} />;
}

/**
 * The page's identity and its primary actions.
 *
 * `actions` is a single slot on purpose. Primary actions were previously
 * scattered — "Create proposal" beside the orders heading, "Create draft
 * product" in a form halfway down the catalog page, "Add a delivery method"
 * inside a fieldset in settings — so there was nowhere to look for "the thing
 * this page lets me make".
 *
 * There is no eyebrow. The breadcrumb above already says which section this is,
 * and repeating it in accent caps was two answers to the same question.
 */
export function PageHeader({
  title,
  description,
  actions,
  kind,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  /**
   * A quiet label above the title, for pages that are **not** part of the daily
   * path — the Business diagnostics.
   *
   * Deliberately not the old per-page eyebrow, which repeated the section name
   * in accent caps and was a second answer to a question the breadcrumb had
   * already answered. This says something the breadcrumb cannot: that
   * Reconciliation, Integration health and Launch readiness are read-only
   * instruments you consult, not queues you work. Muted rather than accented,
   * because it is a caveat and not a heading.
   */
  kind?: string;
  children?: ReactNode;
}) {
  return (
    <header className="staff-page-header">
      <div className="staff-page-heading">
        {kind ? <p className="staff-page-kind">{kind}</p> : null}
        <h1 className="staff-page-title">{title}</h1>
        {description ? <p className="staff-page-description">{description}</p> : null}
        {children}
      </div>
      {actions ? <div className="staff-page-actions">{actions}</div> : null}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Sections and cards
// ---------------------------------------------------------------------------

/**
 * A named block of a page. Borderless by design — see the nesting rule above.
 */
export function Section({
  title,
  description,
  actions,
  children,
  className,
  headingLevel = 2,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** 2 by default. Use 3 inside a tab panel that already has an `h2`. */
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 3 ? "h3" : "h2";
  return (
    <section className={cx("staff-section", className)}>
      {title || actions ? (
        <div className="staff-section-head">
          <div className="min-w-0">
            <Heading className="staff-section-title">{title}</Heading>
            {description ? <p className="staff-section-description">{description}</p> : null}
          </div>
          {actions ? <div className="staff-section-actions">{actions}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A bordered surface. The only thing in the framework that draws a box. */
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-card", className)} {...props} />;
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

/**
 * Controlled tabs. State lives with the caller — usually in the URL hash, so a
 * tab is linkable and the back button works.
 *
 * Tabs marked `available: false` are dropped rather than disabled: a tab that
 * refuses when pressed teaches a staff member to distrust the whole strip.
 */
export function PageTabs({
  tabs,
  value,
  onChange,
  ariaLabel,
  className,
}: {
  tabs: readonly StaffTab[];
  value: string | null;
  onChange: (id: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const open = availableTabs(tabs);
  if (open.length < 2) return null;
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx("ui-tabs", className)}>
      {open.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`staff-tab-${tab.id}`}
            aria-selected={active}
            aria-controls={`staff-tabpanel-${tab.id}`}
            // Roving tabindex: one stop for the whole strip, then arrow keys —
            // the pattern a screen reader announces as a tab list.
            tabIndex={active ? 0 : -1}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const index = open.findIndex((candidate) => candidate.id === value);
              const next = open[(index + step + open.length) % open.length];
              onChange(next.id);
              document.getElementById(`staff-tab-${next.id}`)?.focus();
            }}
            onClick={() => onChange(tab.id)}
            className={cx("ui-tab", active && "is-active")}
          >
            {tab.label}
            {typeof tab.count === "number" ? (
              <span className="ml-1.5 tabular-nums opacity-70">{tab.count}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/** The panel a tab controls. Renders nothing when its tab is not selected. */
export function TabPanel({
  id,
  value,
  children,
  className,
}: {
  id: string;
  value: string | null;
  children: ReactNode;
  className?: string;
}) {
  if (id !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`staff-tabpanel-${id}`}
      aria-labelledby={`staff-tab-${id}`}
      tabIndex={0}
      className={cx("staff-page", className)}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

/** The one list surface. Replaces four hand-rolled `divide-y` stacks. */
export function Rows({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("staff-rows", className)} {...props} />;
}

/**
 * One row of a list: what it is, what it needs, and what to do about it.
 *
 * `title`/`detail`/`aside` is the shape every staff queue converged on by hand.
 * Making it a component is what lets the dashboard, the order list, the
 * fulfillment queue and the production queue look like the same application
 * instead of four takes on a row.
 */
export function Row({
  title,
  detail,
  meta,
  aside,
  href,
  onClick,
  severity,
  className,
}: {
  title: ReactNode;
  detail?: ReactNode;
  meta?: ReactNode;
  aside?: ReactNode;
  href?: string;
  onClick?: () => void;
  severity?: "critical" | "warning" | "info";
  className?: string;
}) {
  const body = (
    <>
      <div className="staff-row-main">
        <div className="staff-row-title">{title}</div>
        {detail ? <div className="staff-row-detail">{detail}</div> : null}
        {meta ? <div className="staff-row-meta mt-1">{meta}</div> : null}
      </div>
      {aside ? <div className="staff-row-aside">{aside}</div> : null}
    </>
  );
  const classes = cx("staff-row", severity && `staff-attention staff-attention-${severity}`, className);
  // A plain `<a>` rather than `next/link`: `Row` is used from list pages that
  // already import Link where they need prefetching, and keeping this
  // dependency-free lets it render from a server component unchanged.
  if (href) {
    return (
      <a href={href} className={classes}>
        {body}
      </a>
    );
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

/**
 * A state, coloured the same way on every page.
 *
 * Pass the raw database value; the wording and the tone both come from
 * `pageFramework.ts`. Passing a pre-formatted string was the old habit, and it
 * is how "Awaiting Payment", "awaiting payment" and "Awaiting payment" all
 * ended up on screen at once.
 */
export function StatusChip({
  value,
  label,
  tone,
  prefix,
}: {
  value: string | null | undefined;
  /** Override the derived wording. The tone still comes from `value`. */
  label?: ReactNode;
  tone?: ChipTone;
  /** A quiet qualifier, e.g. `Payment`. Announced, so states never collide. */
  prefix?: string;
}) {
  const text = label ?? stateText(value);
  if (!text) return null;
  return (
    <Badge tone={tone ?? stateTone(value)}>
      {prefix ? <span className="opacity-60">{prefix}</span> : null}
      {text}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** A block of stated values. For reading, never for editing. */
export function Facts({ className, ...props }: HTMLAttributes<HTMLDListElement>) {
  return <dl className={cx("staff-facts", className)} {...props} />;
}

export function Fact({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="staff-fact-label">{label}</dt>
      <dd className="staff-fact-value">{children}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

/** A two-column field grid that collapses to one below `sm`. */
export function FormGrid({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("staff-form-grid", className)} {...props} />;
}

/** A field that should span the full width of a `FormGrid`. */
export function FormWide({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("staff-form-wide", className)} {...props} />;
}

/**
 * A checkbox and its label.
 *
 * Deliberately not `Field`: a checkbox's label belongs beside the control, not
 * above it, and forcing it through the label-above component is what produced
 * the floating, unattached checkbox labels across the settings pages.
 */
export function CheckField({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: ReactNode;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="staff-check">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="staff-check-text">
        {label}
        {help ? <span className="staff-check-help">{help}</span> : null}
      </span>
    </label>
  );
}

/**
 * The single save control for a page.
 *
 * One page, one save. The product editor previously had a save in its sticky
 * header and separate write-on-click behaviour inside the option editor, so
 * "have my changes been kept" had two different answers depending on which
 * field you touched.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  disabled,
  message,
  children,
}: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  disabled?: boolean;
  message?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="staff-save-bar">
      <button
        type="button"
        onClick={onSave}
        disabled={Boolean(disabled) || saving || !dirty}
        className="ui-btn ui-btn-primary disabled:cursor-not-allowed disabled:opacity-50"
      >
        {saving ? "Saving…" : "Save changes"}
      </button>
      <span className="staff-save-status" aria-live="polite">
        {saving ? "Saving…" : dirty ? "Unsaved changes" : message || "Everything saved"}
      </span>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/** A load in progress. `role="status"` so it is announced, not silent. */
export function LoadingState({ children = "Loading…" }: { children?: ReactNode }) {
  return <EmptyState role="status">{children}</EmptyState>;
}

/**
 * A failure, stated where the content would have been.
 *
 * Separate from `EmptyState` on purpose, and it never renders a count or a
 * reassuring sentence — "nothing needs attention" and "we could not find out"
 * look identical otherwise, which is the class of bug this codebase has fixed
 * on four pages already.
 */
export function ErrorState({
  children,
  onRetry,
}: {
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <Notice tone="danger" role="alert">
      {children}
      {onRetry ? (
        <button type="button" onClick={onRetry} className="ui-btn ui-btn-secondary mt-3 text-sm">
          Retry
        </button>
      ) : null}
    </Notice>
  );
}

export { EmptyState };
