import Link from "next/link";

type Props = {
  title?: string;
  description?: string;
  backHref?: string;
  backLabel?: string;
};

/**
 * Consistent access-denied UI used across staff pages.
 */
export function AccessDenied({
  title = "Access denied",
  description = "You do not have permission to view this page.",
  backHref = "/staff/moderation/reports",
  backLabel = "Back to Staff",
}: Props) {
  return (
    <section className="ui-card p-6" role="alert" aria-labelledby="access-denied-title">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border border-red-500/30 bg-red-500/10 text-red-200">
          <span aria-hidden>⛔</span>
        </div>
        <div className="min-w-0">
          <h1 id="access-denied-title" className="text-base font-semibold text-[var(--text)]">
            {title}
          </h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>
          <div className="mt-4">
            <Link className="ui-btn ui-btn-subtle" href={backHref}>
              {backLabel}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
