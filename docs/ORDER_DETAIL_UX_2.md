# Customer Order Detail UX 2.0 audit

## Starting point

The authenticated page was a client-side operations-style workspace: a product-name header, a generic badge, next-step card, six-stage stepper, collapsed overview, multiple action panels, collapsed request details, fulfillment card, full order chat, lifecycle controls, and a mixed activity feed. Pricing appeared in several places, customization was buried, and status-history notes were rendered even though those notes are not a customer-safe updates contract. On mobile, the horizontal stepper and nested cards competed for width and primary actions were separated from the summary.

The guest page was safer at the server boundary, but used a separate summary and items design, exposed the raw commercial status with underscores, and did not provide the same overall progress model. Its named projection, verified httpOnly guest session, immutable `order_items` snapshots, payment-aware checkout predicate, customer-only fulfillment snapshot, and non-internal message query were useful foundations.

Staff-only production jobs, machines, operators, blockers, costing, staff notes, provider IDs, and complete audit history remain outside the customer workspace. Support remains the canonical general conversation system; existing order chat is retained rather than introducing another message store.

## Information architecture and decisions

Both routes now share a vertically readable overview: dominant order-number/status/total header, conditional attention card, applicable progress timeline, items and immutable customization, payment summary, and shipping or pickup. Existing quote, proposal, payment, finished-review, server-evaluated cancellation/return, order-message, and support flows remain below it.

Progress dates only use event-specific fields. Unknown statuses fall back to “Order in progress.” Refund reasons and status-history notes are not customer updates. The page does not invent self-service guest cancellation or returns; guest users are directed to support, while authenticated eligibility remains determined by the lifecycle API. No schema change is required.

The authenticated query now names its customer-facing columns instead of selecting the complete order row. Guest access still requires the verified cookie; UUID or email knowledge is not ownership. Related data is fetched in one bounded parallel batch, and the guest resolver keeps its bounded item/message queries.

## Remaining gaps

The schema has no explicit customer-visible production-start timestamp or dedicated customer-update event projection, so those dates are intentionally absent and the existing order conversation remains the source of customer communication. Product images are not shown because no immutable image snapshot is available. An open support-conversation lookup is not added because the current support flow safely pre-associates the owned order and adding a second conversation query would duplicate the canonical support experience.
