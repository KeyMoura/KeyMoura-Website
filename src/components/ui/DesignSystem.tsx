import type { HTMLAttributes, ReactNode } from "react";

export function cx(...values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cx("ui-card", className)} {...props} />;
}

type MetricCardProps = HTMLAttributes<HTMLDivElement> & {
  label: string;
  value: ReactNode;
  detail: ReactNode;
  tone?: "default" | "warning" | "danger" | "success";
};

export function MetricCard({
  label,
  value,
  detail,
  tone = "default",
  className,
  ...props
}: MetricCardProps) {
  return (
    <div className={cx("ui-metric", tone !== "default" && `ui-metric-${tone}`, className)} {...props}>
      <p className="ui-metric-label">{label}</p>
      <p className="ui-metric-value">{value}</p>
      <p className="ui-metric-detail">{detail}</p>
    </div>
  );
}

type NoticeProps = HTMLAttributes<HTMLDivElement> & {
  tone?: "info" | "warning" | "danger" | "success";
};

export function Notice({ tone = "info", className, ...props }: NoticeProps) {
  return <div className={cx("ui-notice", `ui-notice-${tone}`, className)} {...props} />;
}

export function EmptyState({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("ui-empty-state", className)} {...props} />;
}

type BadgeProps = HTMLAttributes<HTMLSpanElement> & {
  tone?: "neutral" | "accent" | "warning" | "danger" | "success";
};

/**
 * One form field: label, control, optional help text.
 *
 * **Why this exists.** `/orders/new` set every control's spacing with a shared
 * `const input = "ui-input mt-1"` — 4px between a label and its control, and the
 * label was a bare text node inside `<label className="text-sm">` rather than
 * anything the design system knew about. `Project type *` sat almost on the
 * dropdown's top border, and `/staff/orders/new` used `mt-2` for the identical
 * pattern. Two order forms, two spacings, neither matching `.ui-label`.
 *
 * Fixing the one reported field with a margin would have left nine others wrong
 * and added a fourth spacing value, so the spacing moved into `.ui-label`, which
 * the rest of the project already uses, and this component makes the structure
 * reusable.
 *
 * The `<label>` wraps the control, so association is implicit and needs no ids.
 * Controls that are not real form elements — `MenuSelect` renders a button —
 * take their own `ariaLabel`; a wrapping label does not name a button.
 *
 * The required marker is `aria-hidden` with a text equivalent beside it: a bare
 * `*` is announced as "star" or skipped entirely depending on the screen reader.
 */
export function Field({
  label,
  required = false,
  help,
  className,
  children,
}: {
  label: ReactNode;
  required?: boolean;
  help?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label className={cx("ui-field", className)}>
      <span className="ui-label">
        {label}
        {required ? (
          <>
            <span className="ui-required" aria-hidden="true">
              *
            </span>
            <span className="sr-only"> (required)</span>
          </>
        ) : null}
      </span>
      {children}
      {help ? <span className="ui-help">{help}</span> : null}
    </label>
  );
}

/**
 * The neutral tone *is* the base badge, so it adds no modifier.
 *
 * It used to append a neutral modifier class that no rule in `globals.css` has
 * ever defined — harmless to render, but it made the plainest badge look as
 * though it had a treatment of its own that somebody could go and find.
 */
export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return <span className={cx("ui-badge", tone !== "neutral" && `ui-badge-${tone}`, className)} {...props} />;
}
