"use client";

import Image from "next/image";
import { choicePresentation } from "@/lib/commerce/optionPresentation";
import { imageMedia } from "@/lib/commerce/optionMedia";
import { isOptimizableImageUrl } from "@/lib/productImages";
import { money, type ProductMedia, type ProductOptionGroup } from "@/lib/commerceTypes";

export function ProductOptionPreview({ group, media }: { group: ProductOptionGroup; media: readonly ProductMedia[] }) {
  const values = (group.product_option_values ?? []).filter((value) => value.is_active !== false);
  const presentation = choicePresentation(group);
  const images = imageMedia(media);
  const label = (value: (typeof values)[number]) => `${value.label}${value.price_adjustment_cents ? ` ${money(value.price_adjustment_cents)}` : ""}`;

  return (
    <div className="option-preview" aria-label={`${group.name || "Option"} customer preview`}>
      <p className="option-preview-eyebrow">Customer preview</p>
      <p className="option-preview-label">{group.name || "Untitled option"}{group.is_required ? <span> · Required</span> : null}</p>
      {!values.length ? <p className="option-preview-empty">Add an available value to preview this option.</p> : presentation === "dropdown" ? (
        <div className="ui-input option-preview-select" aria-hidden="true">{label(values.find((value) => value.is_default) ?? values[0])}<span>⌄</span></div>
      ) : (
        <div className={presentation === "swatches" ? "option-preview-swatches" : "option-preview-buttons"}>
          {values.map((value) => {
            const asset = images.find((item) => item.id === value.media_id);
            return <span key={value.id} className={`option-preview-choice${value.is_default ? " is-selected" : ""}`}>
              {presentation === "swatches" ? <span className="option-preview-image" aria-hidden="true">
                {asset ? isOptimizableImageUrl(asset.url) ? <Image src={asset.url} alt="" fill sizes="42px" className="object-cover" /> : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={asset.url} alt="" />
                ) : <span>—</span>}
              </span> : null}
              <span>{label(value)}</span>
            </span>;
          })}
        </div>
      )}
    </div>
  );
}
