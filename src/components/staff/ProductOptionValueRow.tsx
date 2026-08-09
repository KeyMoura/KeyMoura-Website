"use client";

import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";

import { Field } from "@/components/ui/DesignSystem";
import { imageMedia } from "@/lib/commerce/optionMedia";
import { isOptimizableImageUrl } from "@/lib/productImages";
import type { ProductMedia, ProductOptionValue } from "@/lib/commerceTypes";

/**
 * One purchasable choice, with everything about it that reaches a customer.
 *
 * ## What was missing
 *
 * The editor exposed a label, a saved value, a price change and Remove. Four
 * columns on the row are backed by columns that have existed for months and
 * were **not editable anywhere**: `is_default` decides what the product page
 * pre-selects, `is_active` decides whether the choice can be bought at all,
 * `requires_request` moves the whole configuration onto the quote path, and now
 * `media_id` switches the gallery. Three of those were already being read by the
 * storefront and enforced by the pricing engine; the only way to change one was
 * a hand-written SQL statement.
 *
 * ## The image is a media row, never a URL
 *
 * The picker offers this product's own gallery images and stores their id. A
 * URL copied in here would be a second address for the same photograph: replace
 * the image and the swatch shows the old one; delete it and the swatch is a
 * 404. With the relation, deleting the image nulls the link and the choice stays
 * on sale — which is what the foreign key's `ON DELETE SET NULL` is for.
 */

type Props = {
  value: ProductOptionValue;
  media: readonly ProductMedia[];
  disabled?: boolean;
  onChange: (patch: Partial<ProductOptionValue>) => void;
  onRemove: () => void;
};

export function ProductOptionValueRow({ value, media, disabled = false, onChange, onRemove }: Props) {
  const [picking, setPicking] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const fieldId = useId();

  const images = imageMedia(media);
  const linked = images.find((asset) => asset.id === value.media_id) ?? null;
  /*
   * A link whose image is gone.
   *
   * The foreign key nulls `media_id` when the row is deleted, so this is the
   * narrow window where the editor holds a value loaded before a deletion in
   * another tab. Saying so beats the row quietly reading "No image", which
   * looks like a link that was never made.
   */
  const dangling = Boolean(value.media_id && !linked);

  useEffect(() => {
    if (!picking) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPicking(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [picking]);

  const thumb = (asset: ProductMedia, sizes: string) =>
    isOptimizableImageUrl(asset.url) ? (
      <Image src={asset.url} alt="" fill sizes={sizes} className="object-cover" />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={asset.url} alt="" className="absolute inset-0 h-full w-full object-cover" />
    );

  return (
    <div className="option-value-row">
      <div className="option-value-fields">
        <Field label="Choice label">
          <input
            className="ui-input w-full"
            value={value.label}
            disabled={disabled}
            onChange={(event) => onChange({ label: event.target.value })}
          />
        </Field>
        <Field label="Saved value" help="How this choice is recorded on an order.">
          <input
            className="ui-input w-full"
            value={value.value}
            disabled={disabled}
            onChange={(event) => onChange({ value: event.target.value })}
          />
        </Field>
        {/*
          Price change, in dollars, stored in integer cents.

          Negative is allowed and is a real business case — a cheaper material
          that costs less to machine. The floor is enforced where it matters
          rather than here: `priceLine` clamps the *unit price* at zero, so a
          combination of discounts can never produce a negative line, and no
          single field has to guess what the others are doing.
        */}
        <Field label="Price change ($)" help="Blank or 0 for no extra charge. Negative is allowed.">
          <input
            className="ui-input w-full"
            type="number"
            step=".01"
            disabled={disabled}
            value={Number.isFinite(value.price_adjustment_cents) ? value.price_adjustment_cents / 100 : 0}
            onChange={(event) => {
              const dollars = Number(event.target.value);
              onChange({ price_adjustment_cents: Number.isFinite(dollars) ? Math.round(dollars * 100) : 0 });
            }}
          />
        </Field>
      </div>

      <div className="option-value-media" ref={pickerRef}>
        <span className="ui-label" id={`${fieldId}-media`}>
          Associated image
        </span>
        <div className="option-value-media-controls">
          <span className="option-value-thumb" aria-hidden="true">
            {linked ? thumb(linked, "56px") : <span className="option-value-thumb-blank">—</span>}
          </span>

          <div className="min-w-0 flex-1">
            <p className="option-value-media-name">
              {dangling
                ? "The linked image was deleted."
                : linked
                  ? `Image ${images.indexOf(linked) + 1}${linked.alt_text?.trim() ? ` — ${linked.alt_text.trim()}` : ""}`
                  : "No image. Selecting this choice leaves the gallery where it is."}
            </p>
            <div className="option-value-media-actions">
              <button
                type="button"
                className="ui-btn ui-btn-ghost text-xs"
                disabled={disabled || images.length === 0}
                aria-expanded={picking}
                aria-describedby={`${fieldId}-media`}
                title={images.length === 0 ? "Add an image on the Media tab first." : undefined}
                onClick={() => setPicking((open) => !open)}
              >
                {linked ? "Change image" : "Select image"}
              </button>
              {value.media_id ? (
                <button
                  type="button"
                  className="ui-btn ui-btn-ghost text-xs"
                  disabled={disabled}
                  onClick={() => {
                    onChange({ media_id: null });
                    setPicking(false);
                  }}
                >
                  Clear image
                </button>
              ) : null}
            </div>
          </div>
        </div>

        {picking ? (
          <div className="option-value-media-menu" role="listbox" aria-label="Product images">
            {images.map((asset, position) => {
              const selected = asset.id === value.media_id;
              return (
                <button
                  key={asset.id}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className={`option-value-media-option${selected ? " is-selected" : ""}`}
                  onClick={() => {
                    onChange({ media_id: asset.id });
                    setPicking(false);
                  }}
                >
                  <span className="option-value-thumb" aria-hidden="true">
                    {thumb(asset, "56px")}
                  </span>
                  <span className="min-w-0 truncate text-xs">
                    Image {position + 1}
                    {asset.alt_text?.trim() ? ` — ${asset.alt_text.trim()}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
        ) : null}
      </div>

      <div className="option-value-flags">
        <label className="option-value-flag">
          <input
            type="checkbox"
            checked={Boolean(value.is_default)}
            disabled={disabled}
            onChange={(event) => onChange({ is_default: event.target.checked })}
          />
          <span>Pre-selected</span>
        </label>
        <label className="option-value-flag">
          <input
            type="checkbox"
            checked={value.is_active !== false}
            disabled={disabled}
            onChange={(event) => onChange({ is_active: event.target.checked })}
          />
          <span>Available</span>
        </label>
        <label className="option-value-flag">
          <input
            type="checkbox"
            checked={Boolean(value.requires_request)}
            disabled={disabled}
            onChange={(event) => onChange({ requires_request: event.target.checked })}
          />
          <span>Needs a quote</span>
        </label>
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="ui-btn ui-btn-ghost text-xs text-rose-300"
          aria-label={`Remove ${value.label || "choice"}`}
        >
          Remove
        </button>
      </div>
    </div>
  );
}
