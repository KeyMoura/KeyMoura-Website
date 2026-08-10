/**
 * Where an audit event's records can be opened.
 *
 * Pure, so the links are unit-testable rather than "probably right". Every
 * target here is a route that exists: a link on an audit row that 404s is worse
 * than no link, because it reads as the record having been deleted.
 *
 * `/staff/catalog` has no per-product URL — the editor holds its selection in
 * component state — so a product resolves to its inventory page, which is a
 * real per-product staff surface and carries the stock history the catalog page
 * does not. That is a deliberate substitution, not an oversight.
 */

export type AuditLink = { label: string; href: string };

export type AuditLinkSource = {
  entityType?: string | null;
  entityId?: string | null;
  relatedOrderId?: string | null;
  relatedProductionJobId?: string | null;
  relatedProductId?: string | null;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isId = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

/**
 * Every record this event can open, deduplicated.
 *
 * The entity comes first because it is what the event is *about*; related
 * records follow. An event whose entity is the order it relates to yields one
 * link, not two.
 */
export function auditLinks(event: AuditLinkSource): AuditLink[] {
  const links: AuditLink[] = [];
  const seen = new Set<string>();

  const add = (label: string, href: string) => {
    if (seen.has(href)) return;
    seen.add(href);
    links.push({ label, href });
  };

  if (isId(event.entityId)) {
    switch (event.entityType) {
      case "order":
        add("Open order", `/staff/orders/${event.entityId}`);
        break;
      case "support_conversation":
        add("Open conversation", `/staff/support/${event.entityId}`);
        break;
      case "production_job":
        add("Open production job", `/staff/production/${event.entityId}`);
        break;
      case "product":
        add("Open product", `/staff/inventory/${event.entityId}`);
        break;
      case "user":
        add("Open profile", `/user/${event.entityId}`);
        break;
      default:
        break;
    }
  }

  // Role keys are not uuids, so they are handled outside the id check above.
  if (event.entityType === "role" && event.entityId) {
    add("Open roles", "/staff/security/roles");
  }

  if (isId(event.relatedOrderId)) add("Open order", `/staff/orders/${event.relatedOrderId}`);
  if (isId(event.relatedProductionJobId)) {
    add("Open production job", `/staff/production/${event.relatedProductionJobId}`);
  }
  if (isId(event.relatedProductId)) add("Open product", `/staff/inventory/${event.relatedProductId}`);

  return links;
}
