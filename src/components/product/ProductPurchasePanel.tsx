"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useMemo, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faShareNodes, faCheck } from "@fortawesome/free-solid-svg-icons";
import { MenuSelect } from "@/components/ui/MenuSelect";
import QuantityField from "@/components/commerce/QuantityField";
import WishlistButton from "@/components/commerce/WishlistButton";
import ProductStickyBar from "@/components/product/ProductStickyBar";
import { useProductGallery } from "@/components/product/ProductGalleryContext";
import { useCartMutations } from "@/lib/hooks/useCart";
import {
  allowsDirectPurchase,
  allowsRequest,
  PURCHASE_MODE_COPY,
  type PurchaseMode,
} from "@/lib/commerce/purchaseModes";
import {
  imageForSelection,
  optionImageIndex,
  rendersAsSwatches,
  type GalleryMediaRef,
} from "@/lib/commerce/optionMedia";
import { money, type ProductOptionGroup } from "@/lib/commerceTypes";

type ProductPurchasePanelProps = {
  productId: string;
  productName: string;
  purchaseMode: PurchaseMode;
  startingPriceCents: number | null;
  available: boolean;
  inStock: boolean;
  maxQuantity: number | null;
  groups: ProductOptionGroup[];
  requestHref: string;
  shareUrl: string;
  /**
   * The gallery this product is showing, in display order, so an option value's
   * `media_id` can be resolved to something actually on screen. Optional: a
   * product with no images simply never switches.
   */
  gallery?: GalleryMediaRef[];
};

type Selections = Record<string, string>;

/**
 * Options, quantity, and the buy actions.
 *
 * This is a convenience, never a control. The server re-checks the purchase
 * mode, the price, the options and the stock when the line is added, when the
 * cart is displayed, and again at checkout — so what this panel shows or hides
 * cannot change what is actually purchasable. That is why the price shown here
 * is labelled an estimate whenever options can move it: the number that matters
 * is the one the cart derives.
 *
 * The interesting case is `direct_or_request`. A product can be directly
 * purchasable and still be pushed onto the request path by the configuration
 * chosen — an option value flagged `requires_request` is the shop saying "I can
 * make that, but not at the listed price". When one is selected the panel
 * swaps Add to Cart for the request action and says which choice did it, rather
 * than leaving a disabled button with no explanation. Selecting it is not an
 * error, so nothing is marked invalid.
 */
export default function ProductPurchasePanel({
  productId,
  productName,
  purchaseMode,
  startingPriceCents,
  available,
  inStock,
  maxQuantity,
  groups,
  requestHref,
  shareUrl,
  gallery = [],
}: ProductPurchasePanelProps) {
  const { add } = useCartMutations();
  const { showMedia } = useProductGallery();

  const [selections, setSelections] = useState<Selections>(() => {
    const initial: Selections = {};
    for (const group of groups) {
      const values = group.product_option_values ?? [];
      const preset = values.find((value) => value.is_default) ?? values[0];
      // A required group starts on its default so the common path is one click;
      // an optional group starts empty so "no preference" stays the default.
      if (group.is_required && preset) initial[group.option_key] = preset.value;
    }
    return initial;
  });
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState("");
  const [showErrors, setShowErrors] = useState(false);
  const [copied, setCopied] = useState(false);

  /**
   * Groups this panel renders as a choice.
   *
   * Two filters, for two different reasons:
   *
   * - **Input type.** Free text, numbers, checkboxes and file uploads are
   *   request-wizard concerns. A cart line stores option *values* from a fixed
   *   set, so only `select` and `radio` can drive one.
   * - **Purchase mode.** On a `request_only` product the wizard below owns the
   *   whole configuration, and it renders every group including these. Showing
   *   them here too would ask the customer to choose a material twice, in two
   *   controls that do not talk to each other, with only the second one
   *   reaching the order.
   */
  const choiceGroups = useMemo(
    () =>
      allowsDirectPurchase(purchaseMode)
        ? groups.filter((group) => ["select", "radio"].includes(group.input_type))
        : [],
    [groups, purchaseMode]
  );

  /** Which `option_key:value` pairs resolve to an image this gallery is showing. */
  const imageIndex = useMemo(() => optionImageIndex(groups, gallery), [groups, gallery]);

  /*
   * One place every option choice goes through.
   *
   * The gallery switch has to sit with the state change rather than in an
   * effect watching `selections`: an effect cannot tell *which* group moved, and
   * "the most recently selected image-bearing option wins" is a fact about the
   * interaction. A `Record` has no order to recover it from.
   *
   * Choosing a value with no image is explicitly not a gallery event — the
   * customer keeps whatever they were looking at, including a photograph they
   * browsed to by hand.
   */
  const choose = useCallback(
    (optionKey: string, value: string) => {
      setSelections((current) => ({ ...current, [optionKey]: value }));
      setMessage("");
      const mediaId = imageForSelection(imageIndex, optionKey, value);
      if (mediaId) showMedia(mediaId);
    },
    [imageIndex, showMedia]
  );

  const missing = useMemo(
    () => choiceGroups.filter((group) => group.is_required && !selections[group.option_key]),
    [choiceGroups, selections]
  );

  const selectedValues = useMemo(
    () =>
      choiceGroups
        .map((group) => ({
          group,
          value: (group.product_option_values ?? []).find((v) => v.value === selections[group.option_key]),
        }))
        .filter((entry) => entry.value),
    [choiceGroups, selections]
  );

  const requestOnlyChoice = selectedValues.find((entry) => entry.value?.requires_request);

  const adjustment = selectedValues.reduce(
    (total, entry) => total + (entry.value?.price_adjustment_cents ?? 0),
    0
  );

  const unitPrice = startingPriceCents == null ? null : startingPriceCents + adjustment;
  const total = unitPrice == null ? null : unitPrice * quantity;

  const modeAllowsRequest = allowsRequest(purchaseMode);
  const modeAllowsBuy = allowsDirectPurchase(purchaseMode);

  // The configuration, not just the product, decides whether the cart is
  // reachable.
  const canBuy =
    modeAllowsBuy && startingPriceCents != null && available && inStock && !requestOnlyChoice;
  const canRequest = modeAllowsRequest && available;

  function addToCart() {
    setMessage("");
    if (missing.length) {
      setShowErrors(true);
      const first = document.getElementById(`option-${missing[0].option_key}`);
      first?.focus();
      setMessage(`Choose ${missing.map((group) => group.name).join(", ")} first.`);
      return;
    }
    add.mutate(
      { productId, quantity, selectedOptions: selections },
      {
        onSuccess: () => setMessage("Added to your cart."),
        // The server's refusal is the useful message: it names the option or
        // the stock level that blocked the line.
        onError: (error) => setMessage(error.message),
      }
    );
  }

  async function share() {
    const data = { title: productName, url: shareUrl };
    try {
      if (typeof navigator !== "undefined" && navigator.share) {
        await navigator.share(data);
        return;
      }
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2200);
    } catch {
      // A dismissed share sheet and a denied clipboard both land here and
      // neither is a failure worth reporting.
    }
  }

  /**
   * The headline price.
   *
   * A request-only product with a starting price shows "From $20.00", not
   * "Priced after review" — the catalog card already says "From $20.00" for the
   * same product, and a page that contradicts the card a customer just clicked
   * reads as a pricing error. The caveat is not dropped, it moves to the line
   * underneath, which is where `PURCHASE_MODE_COPY` already explains that
   * nothing is charged before a quote is approved.
   *
   * Only a genuinely unpriced product says "Priced after review", because then
   * it is the whole truth.
   */
  const priceLabel =
    startingPriceCents == null
      ? "Priced after review"
      : modeAllowsBuy
        ? `$${((total ?? 0) / 100).toFixed(2)}`
        : `From $${(startingPriceCents / 100).toFixed(2)}`;

  return (
    <div className="product-purchase">
      <div className="product-purchase-price">
        <p className="product-price">{priceLabel}</p>
        {/* Direct purchase explains how the number was reached; every other
            mode explains what happens before anything is charged. */}
        {modeAllowsBuy && startingPriceCents != null ? (
          <p className="product-price-note">
            {quantity > 1 ? `${quantity} × $${((unitPrice ?? 0) / 100).toFixed(2)}` : null}
            {quantity > 1 && adjustment !== 0 ? " · " : null}
            {adjustment !== 0 ? `includes ${money(adjustment)} in options` : null}
          </p>
        ) : (
          <p className="product-price-note">{PURCHASE_MODE_COPY[purchaseMode].customerHint}</p>
        )}
      </div>

      {choiceGroups.length ? (
        <div className="product-options">
          {choiceGroups.map((group) => {
            const values = group.product_option_values ?? [];
            const isMissing = showErrors && group.is_required && !selections[group.option_key];
            const describedBy = `option-help-${group.option_key}`;

            return (
              <fieldset key={group.id} className="product-option-group">
                <legend className="product-option-legend">
                  {group.name}
                  {group.is_required ? (
                    <span className="product-option-required"> (required)</span>
                  ) : (
                    <span className="product-option-optional"> (optional)</span>
                  )}
                </legend>

                {group.description ? (
                  <p id={describedBy} className="product-option-description">
                    {group.description}
                  </p>
                ) : null}

                {rendersAsSwatches(group, imageIndex) ? (
                  /*
                   * Image swatches.
                   *
                   * A radio group, so it is one tab stop with arrow keys inside
                   * it, and every swatch carries its label as real text — the
                   * thumbnail is `aria-hidden` decoration. That is what stops
                   * this being colour-only: the name is written under the image,
                   * the selected one is ringed *and* ticked *and* `aria-checked`,
                   * and a value with no image of its own still appears here as a
                   * labelled tile rather than silently vanishing from the list.
                   */
                  <div
                    role="radiogroup"
                    aria-label={group.name}
                    className={`product-option-swatches${isMissing ? " is-invalid" : ""}`}
                  >
                    {values.map((value) => {
                      const checked = selections[group.option_key] === value.value;
                      const mediaId = imageIndex.get(`${group.option_key}:${value.value}`);
                      const image = mediaId ? gallery.find((entry) => entry.id === mediaId) : undefined;
                      return (
                        <button
                          key={value.id}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          tabIndex={checked || (!selections[group.option_key] && value === values[0]) ? 0 : -1}
                          id={checked ? `option-${group.option_key}` : undefined}
                          onClick={() => choose(group.option_key, value.value)}
                          className={`product-option-swatch${checked ? " is-selected" : ""}`}
                        >
                          <span className="product-option-swatch-frame" aria-hidden="true">
                            {image?.url ? (
                              <Image src={image.url} alt="" fill sizes="72px" className="object-cover" />
                            ) : (
                              <span className="product-option-swatch-blank">—</span>
                            )}
                          </span>
                          <span className="product-option-swatch-label">{value.label}</span>
                          {value.price_adjustment_cents ? (
                            <span className="product-option-swatch-price">
                              {money(value.price_adjustment_cents)}
                            </span>
                          ) : null}
                          {value.requires_request ? (
                            <span className="product-option-choice-note">Quoted</span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ) : group.input_type === "select" ? (
                  <MenuSelect
                    value={selections[group.option_key] ?? ""}
                    onChange={(value) => choose(group.option_key, value)}
                    ariaLabel={group.name}
                    align="left"
                    className={`ui-select-trigger product-option-select${isMissing ? " is-invalid" : ""}`}
                    options={[
                      ...(group.is_required ? [] : [{ value: "", label: "No preference" }]),
                      ...values.map((value) => ({
                        value: value.value,
                        label: `${value.label}${
                          value.price_adjustment_cents ? ` (${money(value.price_adjustment_cents)})` : ""
                        }${value.requires_request ? " — quoted" : ""}`,
                      })),
                    ]}
                  />
                ) : (
                  <div className="product-option-choices">
                    {values.map((value) => {
                      const checked = selections[group.option_key] === value.value;
                      return (
                        <label
                          key={value.id}
                          className={`product-option-choice${checked ? " is-selected" : ""}`}
                        >
                          <input
                            type="radio"
                            name={group.option_key}
                            id={checked ? `option-${group.option_key}` : undefined}
                            checked={checked}
                            onChange={() => choose(group.option_key, value.value)}
                            className="sr-only"
                          />
                          <span className="product-option-choice-label">{value.label}</span>
                          {value.price_adjustment_cents ? (
                            <span className="product-option-choice-price">
                              {money(value.price_adjustment_cents)}
                            </span>
                          ) : null}
                          {value.requires_request ? (
                            <span className="product-option-choice-note">Quoted</span>
                          ) : null}
                        </label>
                      );
                    })}
                  </div>
                )}

                {isMissing ? (
                  <p role="alert" className="product-option-error">
                    Choose a {group.name.toLowerCase()}.
                  </p>
                ) : null}
              </fieldset>
            );
          })}
        </div>
      ) : null}

      {requestOnlyChoice ? (
        <p className="product-purchase-notice" role="status">
          <strong>{requestOnlyChoice.value?.label}</strong> is quoted rather than sold at the listed
          price. Send a request and we will price this configuration before anything is charged.
        </p>
      ) : null}

      {canBuy ? (
        <QuantityField
          id="product-quantity"
          value={quantity}
          max={maxQuantity}
          onCommit={(next) => {
            setQuantity(next);
            setMessage("");
          }}
        />
      ) : null}

      <div className="product-actions">
        {canBuy ? (
          <button
            type="button"
            onClick={addToCart}
            disabled={add.isPending}
            className="ui-btn ui-btn-primary product-action-primary"
          >
            {add.isPending ? "Adding…" : "Add to cart"}
          </button>
        ) : null}

        {canRequest ? (
          <Link
            href={requestHref}
            className={`ui-btn product-action-primary ${canBuy ? "ui-btn-secondary" : "ui-btn-primary"}`}
          >
            {canBuy ? "Request a custom version" : "Request a quote"}
          </Link>
        ) : null}

        {!canBuy && !canRequest ? (
          <p className="ui-notice ui-notice-info" role="status">
            {available ? "This product is out of stock right now." : "This product is not currently available."}
          </p>
        ) : null}
      </div>

      {canBuy && canRequest ? (
        <p className="product-action-hint">
          Buy the standard configuration now, or request changes and we will price them first.
        </p>
      ) : null}

      <div className="product-secondary-actions">
        <WishlistButton productId={productId} productName={productName} selectedOptions={selections} />
        <button type="button" onClick={share} className="ui-btn ui-btn-ghost product-share">
          <FontAwesomeIcon icon={copied ? faCheck : faShareNodes} className="h-3.5 w-3.5" aria-hidden="true" />
          {copied ? "Link copied" : "Share"}
        </button>
      </div>

      {message ? (
        <p
          role="status"
          aria-live="polite"
          className={`product-purchase-message ${add.isError ? "is-error" : "is-success"}`}
        >
          {message}{" "}
          {!add.isError && message.startsWith("Added") ? (
            <Link href="/cart" className="underline hover:no-underline">
              View cart
            </Link>
          ) : null}
        </p>
      ) : null}

      {/* Mirrors whichever primary action this configuration actually offers,
          so the bar never advertises a cart on a request-only product. */}
      {canBuy ? (
        <ProductStickyBar label="Add to cart" price={priceLabel} onBuy={addToCart} />
      ) : canRequest ? (
        <ProductStickyBar label="Request a quote" price={null} href={requestHref} />
      ) : null}
    </div>
  );
}
