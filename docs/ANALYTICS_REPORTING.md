# Analytics and business reporting

## Authority and formulas

Analytics is read-only and permission-gated by `analytics.view`. Cash uses successful `order_payments.received_at` events for gross collected and successful `order_refunds.created_at` events for refunds. **Net revenue = gross collected − successful refunds**; it can be negative. **AOV = net revenue / distinct orders with a payment in the period**. Quotes, failed checkout attempts, and unpaid cancellations are excluded. Discounts are the applied `orders.discount_cents` snapshot, not unsuccessful code attempts.

Placed orders use `orders.created_at`; completed and cancelled use their canonical status/timestamps. Product names, quantities, and prices should come from immutable order/order-item snapshots. The current schema does not snapshot category, so historical category grouping is deliberately unavailable. Account-customer metrics use `orders.customer_id` only; guest email is never identity proof.

Production duration is `production_jobs.started_at → completed_at`, only when both exist. Overdue means a non-terminal job with `due_date` before today UTC. Blocked comprises explicit hold/wait/rework statuses. Fulfillment timing uses stored paid, ready, shipped, and pickup timestamps; carrier text never proves delivery. Support resolution uses `created_at → resolved_at`. First staff response is not substituted with the last-staff-message timestamp and remains unavailable until a bounded first-message aggregate is introduced.

Returns use structured `order_returns` rows and reason codes. Inventory movement uses `inventory_adjustments`; current low stock uses the existing product counter and threshold. No second ledger is created.

## Ranges, comparison, and limitations

Supported UTC half-open ranges are Today, last 7/30 days, this month, last month, this year, and a validated custom range up to 366 days. Previous-period windows have identical duration and never overlap the selected range. Percentage change is omitted when the previous value is zero. Query state is shareable through `range`, `from`, and `to` parameters.

Queries are performed on the server, bounded by timestamp, capped defensively, and run concurrently without N+1 reads. A database error fails the report; it is never rendered as healthy zeros. CSV export is deferred: the existing audit/export pipeline would need a safe bounded streaming design. No migration is required for this pass. Future database aggregates should provide category snapshots, first support response, item-level refund allocation, and high-volume paging.
