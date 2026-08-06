"use client";

import type { CatalogProduct } from "@/lib/commerceTypes";
import { Notice } from "@/components/ui/DesignSystem";

/**
 * Delivery, packaging and stock rules for one product.
 *
 * The twelve columns behind this already decide real behaviour —
 * `checkoutFulfillment.ts` reads `requires_shipping`, `pickup_eligible`,
 * `fulfillment_required` and the package dimensions to work out which delivery
 * methods a cart may offer and what the parcel weighs — and pass 8 shipped them
 * with **no editing surface**, so every product sat on the column defaults and
 * the owner had no way to say that a keyring does not need a 2kg default box.
 *
 * Three things this deliberately does:
 *
 * 1. **States the consequence of each switch**, because "Pickup eligible" off
 *    means a cart containing this product stops offering collection *for every
 *    other item in it too*. That is not guessable from the label.
 * 2. **Refuses the incoherent combination out loud.** A product that neither
 *    ships nor is collectable cannot be bought at all if it still requires
 *    fulfillment, so that pairing is called out where it is set rather than
 *    discovered at somebody's checkout.
 * 3. **Distinguishes the product's own size from its packed size.** They are
 *    different columns because they are different measurements, and shipping is
 *    priced on the box.
 */

type Props = {
  draft: Partial<CatalogProduct>;
  onChange: (patch: Partial<CatalogProduct>) => void;
  disabled: boolean;
};

const input = "ui-input";

/** Reads a nullable numeric column into a controlled text input. */
const numberValue = (value: number | null | undefined) => (value == null ? "" : String(value));

/**
 * A blank box means "not set", not zero.
 *
 * `Number("")` is 0, and a package weight of 0 grams is a real value that would
 * make the shipping calculator price a parcel as weightless rather than fall
 * back to the configured default. Clearing a field has to write null.
 */
const toNumberOrNull = (raw: string) => {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
};

function Switch({
  label,
  help,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  help: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-3 rounded-xl border border-zinc-800 bg-black/25 p-3 text-sm">
      <input
        type="checkbox"
        className="mt-1"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="min-w-0">
        <span className="block font-medium">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-brand-textMuted">{help}</span>
      </span>
    </label>
  );
}

export function ProductShippingEditor({ draft, onChange, disabled }: Props) {
  // Every default matches the column default, so an unedited product reads back
  // exactly as the database will treat it.
  const requiresShipping = draft.requires_shipping ?? true;
  const pickupEligible = draft.pickup_eligible ?? true;
  const fulfillmentRequired = draft.fulfillment_required ?? true;
  const isReturnable = draft.is_returnable ?? true;

  const undeliverable = fulfillmentRequired && !requiresShipping && !pickupEligible;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">How it is delivered</h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Switch
            label="Needs to be shipped"
            help="Off for something with nothing to post — a digital file, a service, or a fitting done in person."
            checked={requiresShipping}
            disabled={disabled}
            onChange={(next) => onChange({ requires_shipping: next })}
          />
          <Switch
            label="Can be collected"
            help="Turning this off removes local pickup from any cart containing this product, including its other items."
            checked={pickupEligible}
            disabled={disabled}
            onChange={(next) => onChange({ pickup_eligible: next })}
          />
          <Switch
            label="Needs fulfilling at all"
            help="Off means the order is complete on payment. Nothing appears in the fulfillment queue for it."
            checked={fulfillmentRequired}
            disabled={disabled}
            onChange={(next) => onChange({ fulfillment_required: next })}
          />
          <Switch
            label="Can be returned"
            help="Off excludes this product from returns regardless of the shop-wide window. Bespoke work usually belongs here."
            checked={isReturnable}
            disabled={disabled}
            onChange={(next) => onChange({ is_returnable: next })}
          />
        </div>
        {undeliverable ? (
          <Notice tone="warning" role="alert" className="mt-3">
            This product needs fulfilling but can neither be shipped nor collected, so a cart containing it will
            refuse at checkout with “This order cannot be delivered right now.” Enable a delivery route, or turn
            off “Needs fulfilling at all”.
          </Notice>
        ) : null}
      </div>

      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">Packed size and weight</h3>
        <p className="mt-1 text-xs text-brand-textMuted">
          Used to price a parcel. Leave a box empty to fall back to the shop defaults in{" "}
          <span className="text-brand-text">Settings → Shipping, pickup &amp; policy</span>. Empty is not zero.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <label className="text-sm">
            Packed weight (g)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.package_weight_grams)}
              onChange={(event) => onChange({ package_weight_grams: toNumberOrNull(event.target.value) })}
            />
          </label>
          <label className="text-sm">
            Box length (mm)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.package_length_mm)}
              onChange={(event) => onChange({ package_length_mm: toNumberOrNull(event.target.value) })}
            />
          </label>
          <label className="text-sm">
            Box width (mm)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.package_width_mm)}
              onChange={(event) => onChange({ package_width_mm: toNumberOrNull(event.target.value) })}
            />
          </label>
          <label className="text-sm">
            Box height (mm)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.package_height_mm)}
              onChange={(event) => onChange({ package_height_mm: toNumberOrNull(event.target.value) })}
            />
          </label>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">The product itself</h3>
        <p className="mt-1 text-xs text-brand-textMuted">
          The part’s own dimensions, shown to customers. Separate from the box above, because shipping is priced on
          the box and customers ask about the part.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-4">
          <label className="text-sm">
            Length (mm)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.length_mm)}
              onChange={(event) => onChange({ length_mm: toNumberOrNull(event.target.value) })}
            />
          </label>
          <label className="text-sm">
            Width (mm)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.width_mm)}
              onChange={(event) => onChange({ width_mm: toNumberOrNull(event.target.value) })}
            />
          </label>
          <label className="text-sm">
            Height (mm)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.height_mm)}
              onChange={(event) => onChange({ height_mm: toNumberOrNull(event.target.value) })}
            />
          </label>
          <label className="text-sm">
            Unpacked weight (g)
            <input
              className={`${input} mt-1 w-full`}
              type="number"
              min="0"
              step="1"
              disabled={disabled}
              value={numberValue(draft.weight_grams)}
              onChange={(event) => onChange({ weight_grams: toNumberOrNull(event.target.value) })}
            />
          </label>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">
          What customers are told
        </h3>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label className="text-sm sm:col-span-2">
            Shipping notes
            <textarea
              className={`${input} mt-1 min-h-20 w-full`}
              disabled={disabled}
              value={draft.shipping_notes ?? ""}
              onChange={(event) => onChange({ shipping_notes: event.target.value })}
              placeholder="Ships in a rigid box. Oversize surcharge does not apply."
            />
          </label>
          <label className="text-sm">
            Return notes
            <textarea
              className={`${input} mt-1 min-h-20 w-full`}
              disabled={disabled}
              value={draft.return_notes ?? ""}
              onChange={(event) => onChange({ return_notes: event.target.value })}
              placeholder="Returnable unpacked and unfitted within 30 days."
            />
          </label>
          <label className="text-sm">
            Cancellation notes
            <textarea
              className={`${input} mt-1 min-h-20 w-full`}
              disabled={disabled}
              value={draft.cancellation_notes ?? ""}
              onChange={(event) => onChange({ cancellation_notes: event.target.value })}
              placeholder="Cannot be cancelled once material is cut."
            />
          </label>
          <label className="text-sm">
            Stated dimensions
            <input
              className={`${input} mt-1 w-full`}
              disabled={disabled}
              value={draft.dimensions_text ?? ""}
              onChange={(event) => onChange({ dimensions_text: event.target.value })}
              placeholder="45 mm diameter × 62 mm"
            />
          </label>
          <label className="text-sm">
            Stated package size
            <input
              className={`${input} mt-1 w-full`}
              disabled={disabled}
              value={draft.package_dimensions_text ?? ""}
              onChange={(event) => onChange({ package_dimensions_text: event.target.value })}
              placeholder="120 × 100 × 80 mm boxed"
            />
          </label>
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wide text-brand-textMuted">Tax</h3>
        <label className="mt-3 block max-w-sm text-sm">
          Product tax code
          <input
            className={`${input} mt-1 w-full`}
            disabled={disabled}
            value={draft.tax_code ?? ""}
            onChange={(event) => onChange({ tax_code: event.target.value })}
            placeholder="txcd_99999999"
          />
          <span className="mt-1 block text-xs text-brand-textMuted">
            Stored for when Stripe Tax is enabled. Nothing reads it today and every order records $0.00 tax —
            carrying the field now means turning tax on later is a settings change rather than a schema change on
            live orders.
          </span>
        </label>
      </div>
    </div>
  );
}
