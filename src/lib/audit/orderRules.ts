import type { ChangeSet } from "./diff.ts";

/**
 * Which order fields are audited, and what a given edit should be called.
 *
 * Pure and dependency-free, like `orderLifecycle.ts` and `orderFilters.ts`
 * beside it. The writer in `audit/orders.ts` is server-only because it talks to
 * the database; these are rules, and a rule that cannot be unit-tested is a rule
 * nobody checks.
 */

/**
 * Fields compared on an order edit.
 *
 * Deliberately absent, and why:
 * - `staff_notes`, `final_review_note` — internal prose. That they changed is
 *   recorded in `metadata.also_changed`; what they say is not.
 * - `shipping_address` — the customer's home. The fulfillment method changing
 *   is the auditable fact; the address is on the order.
 * - `stripe_checkout_session_id` — a payment-provider handle, not a business
 *   state, and it is cleared as a side effect of half these transitions.
 */
export const ORDER_AUDIT_FIELDS = [
  "status",
  "payment_status",
  "fulfillment_status",
  "fulfillment_method",
  "agreed_price_cents",
  "deposit_amount_cents",
  "quote_revision",
  "quote_expires_at",
  "target_date",
  "cancellation_reason",
  "shipping_carrier",
  "tracking_number",
  "tracking_url",
] as const;

/** Changed, but recorded by name only — never by content. */
export const ORDER_NOTED_WITHOUT_CONTENT = [
  "staff_notes",
  "final_review_note",
  "shipping_address",
  "final_review_asset_paths",
] as const;

/**
 * Picks the action that names the most consequential thing in this save.
 *
 * One save produces one event. The action is the headline; `changes` still
 * carries every audited field that moved, so naming it "changed status" never
 * hides that the price moved too.
 */
export function resolveOrderAction(changes: ChangeSet): string {
  const statusChange = changes.status;
  if (statusChange && statusChange.after === "cancelled") return "order.cancelled";
  if (statusChange) return "order.status_changed";
  if (changes.quote_revision) return "order.quote_changed";
  if (changes.agreed_price_cents) return "order.price_changed";
  if (changes.deposit_amount_cents) return "order.deposit_changed";
  if (changes.fulfillment_status) return "fulfillment.status_changed";
  if (changes.tracking_number || changes.shipping_carrier || changes.tracking_url) {
    return "fulfillment.tracking_changed";
  }
  if (changes.fulfillment_method) return "order.fulfillment_method_changed";
  if (changes.payment_status) return "order.payment_status_changed";
  if (changes.target_date || changes.quote_expires_at) return "order.schedule_changed";
  return "order.updated";
}
