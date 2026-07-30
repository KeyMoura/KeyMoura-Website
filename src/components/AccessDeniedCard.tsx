import { AccessDenied } from "@/components/AccessDenied";

type Props = {
  title?: string;
  message?: string;
  backHref?: string;
  backLabel?: string;
};

/**
 * Consistent access-denied shell used across staff pages.
 */
export function AccessDeniedCard({
  title = "Access denied",
  message = "You do not have permission to view this page.",
  backHref = "/staff",
  backLabel = "Back to Staff",
}: Props) {
  return (
    <div className="page-container">
      <AccessDenied
        title={title}
        description={message}
        backHref={backHref}
        backLabel={backLabel}
      />
    </div>
  );
}
