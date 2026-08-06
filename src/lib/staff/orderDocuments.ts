/**
 * The printable order documents, defined once.
 *
 * Pure and dependency-free so the page, the fulfillment panel's links and the
 * tests all agree on which documents exist, what each is called, and — the part
 * that actually matters — **whether a given document may show internal
 * information**. A packing slip goes in the box with the parcel; a staff member
 * printing one must not be able to slip internal notes and cost detail into a
 * customer's hands because a template quietly included them.
 */

export const ORDER_DOCUMENTS = ["packing-slip", "pickup-slip", "invoice", "refund-record"] as const;
export type OrderDocument = (typeof ORDER_DOCUMENTS)[number];

export type OrderDocumentMeta = {
  slug: OrderDocument;
  title: string;
  /** One line under the heading, explaining what the sheet is for. */
  purpose: string;
  /**
   * True when the sheet physically reaches the customer.
   *
   * The document renderer reads this and *refuses* to print internal notes,
   * staff notes or margin on any sheet where it is true. That is a property of
   * the document, not a habit of whoever wrote the template.
   */
  reachesCustomer: boolean;
  /** Documents that only make sense for one delivery method. */
  method?: "shipping" | "pickup";
};

export const ORDER_DOCUMENT_META: Readonly<Record<OrderDocument, OrderDocumentMeta>> = {
  "packing-slip": {
    slug: "packing-slip",
    title: "Packing slip",
    purpose: "Goes in the box. What was sent, to whom, and against which order.",
    reachesCustomer: true,
    method: "shipping",
  },
  "pickup-slip": {
    slug: "pickup-slip",
    title: "Pickup slip",
    purpose: "Handed over at collection, with a line for the customer to sign.",
    reachesCustomer: true,
    method: "pickup",
  },
  invoice: {
    slug: "invoice",
    title: "Invoice",
    purpose: "The money: items, delivery, discount, tax, what was paid and what is owed.",
    reachesCustomer: true,
  },
  "refund-record": {
    slug: "refund-record",
    title: "Refund record",
    purpose: "Every refund on this order, with its Stripe reference and settlement state.",
    // Kept internal: it carries failed attempts and internal reasons, which is
    // an accounting record rather than something to hand a customer.
    reachesCustomer: false,
  },
};

export function isOrderDocument(value: string): value is OrderDocument {
  return (ORDER_DOCUMENTS as readonly string[]).includes(value);
}

/**
 * The documents worth offering for an order fulfilled this way.
 *
 * An unrecognised method falls back to **shipping**, matching
 * `fulfillmentTransitionsFor`'s own fallback. Returning nothing method-specific
 * would mean a corrupted `fulfillment_method` silently removed the packing slip
 * from the one order that most needs a human to look at it.
 */
export function documentsForMethod(method: string | null | undefined): OrderDocumentMeta[] {
  const raw = String(method || "shipping");
  const resolved = raw === "pickup" || raw === "shipping" ? raw : "shipping";
  return ORDER_DOCUMENTS.map((slug) => ORDER_DOCUMENT_META[slug]).filter(
    (meta) => !meta.method || meta.method === resolved
  );
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export type InvoiceInput = {
  subtotal_cents: number | null;
  discount_cents: number | null;
  shipping_cents: number | null;
  tax_cents: number | null;
  agreed_price_cents: number | null;
  amount_paid_cents: number;
  amount_refunded_cents: number | null;
};

export type InvoiceLine = { label: string; cents: number; emphasis?: boolean };

/**
 * The invoice's money lines.
 *
 * `agreed_price_cents` is the canonical total on both order kinds and is
 * **never recomputed** here — a printed invoice that disagrees with what the
 * customer was actually charged is worse than one with fewer lines. The
 * components are shown when they are present and are labelled as a breakdown of
 * that total, not as an alternative arithmetic for it.
 *
 * A custom request carries no subtotal or shipping breakdown, so it prints a
 * single line. That is honest: nothing else was ever recorded.
 */
export function invoiceLines(order: InvoiceInput): InvoiceLine[] {
  const lines: InvoiceLine[] = [];
  const subtotal = order.subtotal_cents ?? null;
  const discount = order.discount_cents ?? 0;
  const shipping = order.shipping_cents ?? 0;
  const tax = order.tax_cents ?? 0;

  if (subtotal != null) {
    lines.push({ label: "Items", cents: subtotal });
    if (discount > 0) lines.push({ label: "Discount", cents: -discount });
    if (shipping > 0) lines.push({ label: "Delivery", cents: shipping });
    else if (order.subtotal_cents != null) lines.push({ label: "Delivery", cents: 0 });
    if (tax > 0) lines.push({ label: "Tax", cents: tax });
  }

  lines.push({ label: "Order total", cents: order.agreed_price_cents ?? 0, emphasis: true });

  const paid = order.amount_paid_cents || 0;
  const refunded = order.amount_refunded_cents || 0;
  if (paid > 0) lines.push({ label: "Paid", cents: -paid });
  if (refunded > 0) lines.push({ label: "Refunded to customer", cents: refunded });

  const balance = Math.max(0, (order.agreed_price_cents ?? 0) - Math.max(0, paid - refunded));
  lines.push({ label: balance > 0 ? "Balance due" : "Balance", cents: balance, emphasis: true });

  return lines;
}

export const formatCents = (cents: number) =>
  `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;
