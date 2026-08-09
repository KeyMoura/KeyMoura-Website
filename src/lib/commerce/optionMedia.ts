import type { ProductMedia, ProductOptionGroup, ProductOptionValue } from "@/lib/commerceTypes";

/**
 * Which gallery image an option selection should show.
 *
 * Pure, so the rule can be tested without a browser and so the storefront and
 * the staff editor cannot drift on what "this colour has an image" means.
 *
 * ## Why resolution goes through the product's own media list
 *
 * `media_id` is a foreign key and a database trigger already refuses a row
 * belonging to another product. This resolves against the gallery the page is
 * actually rendering anyway, which makes a stale or impossible link **inert**
 * rather than broken: an id that is not in this product's images simply yields
 * no image, and the gallery stays where it is. Belt and braces, and the braces
 * are the cheap half.
 */

/**
 * A gallery entry as the product page builds it: the `product_media` id, in
 * display order, plus the resolved URL where one is available.
 *
 * Structurally compatible with `GalleryImage`, so the page passes the same array
 * to the gallery and to the options panel and there is no second list to keep in
 * step. `url` is optional because the *matching* only ever needs the id — the
 * swatches want a thumbnail, and a value linked to an image the page could not
 * resolve renders as a labelled tile rather than a broken one.
 */
export type GalleryMediaRef = { id: string; url?: string };

/** Option values that carry a usable image, keyed by `${option_key}:${value}`. */
export function optionImageIndex(
  groups: readonly ProductOptionGroup[],
  gallery: readonly GalleryMediaRef[]
): Map<string, string> {
  const usable = new Set(gallery.map((entry) => entry.id));
  const index = new Map<string, string>();

  for (const group of groups) {
    for (const value of group.product_option_values ?? []) {
      const mediaId = value.media_id ?? null;
      // An inactive value can still be linked; it just cannot be selected, so
      // there is no need to special-case it here.
      if (mediaId && usable.has(mediaId)) {
        index.set(optionImageKey(group.option_key, value.value), mediaId);
      }
    }
  }
  return index;
}

export function optionImageKey(optionKey: string, value: string): string {
  return `${optionKey}:${value}`;
}

/**
 * The image for one selection, or null when that choice has none.
 *
 * Null is the "leave the gallery alone" answer, and it is deliberately distinct
 * from "the first image": a customer who has browsed to photograph four and then
 * picks a size with no photograph of its own should stay on photograph four.
 */
export function imageForSelection(
  index: ReadonlyMap<string, string>,
  optionKey: string,
  value: string | null | undefined
): string | null {
  if (!value) return null;
  return index.get(optionImageKey(optionKey, value)) ?? null;
}

/**
 * The image implied by a whole set of selections, used for the *initial* view.
 *
 * Later changes are driven one at a time by the control that changed — "most
 * recently selected wins" is a fact about the interaction, not about the state,
 * and cannot be recovered from a `Record` whose keys have no order. This exists
 * for first paint, where there is no interaction yet, and it walks the groups in
 * their staff-defined order so the answer is stable rather than dependent on
 * object key order.
 */
export function initialImageForSelections(
  groups: readonly ProductOptionGroup[],
  index: ReadonlyMap<string, string>,
  selections: Readonly<Record<string, string>>
): string | null {
  for (const group of groups) {
    const found = imageForSelection(index, group.option_key, selections[group.option_key]);
    if (found) return found;
  }
  return null;
}

/**
 * True when a group should be drawn as image swatches.
 *
 * Both halves are required. `display_style` is the staff's explicit instruction
 * — never inferred from the option being called "Colour" — and at least one
 * value must actually resolve to an image, because a swatch row with no
 * thumbnails is a worse control than the buttons it replaced.
 */
export function rendersAsSwatches(
  group: ProductOptionGroup,
  index: ReadonlyMap<string, string>
): boolean {
  if (group.display_style !== "swatches") return false;
  return (group.product_option_values ?? []).some((value) =>
    index.has(optionImageKey(group.option_key, value.value))
  );
}

/** The media rows for a product's images, in gallery order. Staff-editor side. */
export function imageMedia(media: readonly ProductMedia[]): ProductMedia[] {
  return media.filter((asset) => asset.kind === "image");
}

/**
 * A short human label for a linked image, for the staff editor's value row.
 *
 * Position is what a person actually uses to find a photograph in a gallery
 * ("the third one"), so it leads; the alt text is the confirmation.
 */
export function describeLinkedMedia(
  media: readonly ProductMedia[],
  mediaId: string | null | undefined
): string | null {
  if (!mediaId) return null;
  const images = imageMedia(media);
  const position = images.findIndex((asset) => asset.id === mediaId);
  if (position === -1) return null;
  const alt = images[position].alt_text?.trim();
  return alt ? `Image ${position + 1} — ${alt}` : `Image ${position + 1}`;
}

/**
 * Values whose linked image has since been deleted.
 *
 * The foreign key nulls `media_id` when the row goes, so this is not about
 * dangling ids — it is the editor telling staff that a link they set is gone,
 * rather than the row silently reverting to "no image" and looking untouched.
 */
export function valuesWithMissingMedia(
  groups: readonly ProductOptionGroup[],
  media: readonly ProductMedia[]
): ProductOptionValue[] {
  const usable = new Set(imageMedia(media).map((asset) => asset.id));
  return groups.flatMap((group) =>
    (group.product_option_values ?? []).filter((value) => value.media_id && !usable.has(value.media_id))
  );
}
