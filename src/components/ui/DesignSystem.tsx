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

export function Badge({ tone = "neutral", className, ...props }: BadgeProps) {
  return <span className={cx("ui-badge", `ui-badge-${tone}`, className)} {...props} />;
}
