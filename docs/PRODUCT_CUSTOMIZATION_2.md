# Product customization and order configuration 2.0

## Checkout audit

Baseline: local branch `work` at `f66bff913b7012772887fec2c9e8a6815421d8c5` with a clean tree. The repository contains 56 migration files. This audit used the Codex checkout only; GitHub/main and production migration parity were not independently checked.

The existing architecture already has ordered `product_option_groups` and ordered `product_option_values`. Values have `is_default`, `is_active`, `requires_request`, and the canonical `price_adjustment_cents`. Groups use `input_type=select` for dropdowns, `input_type=radio` for buttons, and `display_style=swatches` for image swatches. Values link to `product_media` through nullable `media_id`; the additive repository migration uses `ON DELETE SET NULL` and a same-product trigger. No new schema is needed by this pass and no migration was applied.

Cart and checkout both call the server pricing domain. It loads adjustments from option-value rows, validates active values and required choices, applies product-level stock, and supplies the configured subtotal to discounts and the Stripe checkout amount. The client price is preview-only. There is no variant inventory or second option-price source.

Before this pass, direct-order `order_items.selected_options` copied only option keys and machine values. Product name and configured unit/line prices were immutable, but option/value display names and adjustments were not. Checkout now stores an immutable JSON snapshot containing option id/name, value id/name and the purchase-time adjustment. Customer, guest and staff order readers render that snapshot and never rejoin current option tables. Product-request orders retain their existing specification snapshot; Production continues to read order context rather than creating a second customization record.

The storefront already switches the gallery to linked media without navigation, leaves it unchanged for an unlinked value, preserves other selections, and allows subsequent manual browsing. The 3D viewer warning remains: “Textures may not be accurate.” This pass also removes the implicit first-value choice: required groups start empty unless staff explicitly marked an active default.
