"use client";

import Link from "next/link";
import ProductImage from "@/components/ProductImage";
import {
  availabilityLabel,
  productCanBeRequested,
  type CatalogProduct,
} from "@/lib/commerceTypes";
import type { ProductMediaRef } from "@/lib/productImages";
import { normalizePurchaseMode, type PurchaseMode } from "@/lib/commerce/purchaseModes";

export type ProductCardProduct = Pick<
  CatalogProduct,
  "id" | "name" | "slug" | "short_description" | "image_url" | "category" | "starting_price_cents" | "is_custom"
> &
  Partial<Pick<CatalogProduct, "purchase_mode">> &
  Partial<
    Pick<
      CatalogProduct,
      "availability_status" | "lead_time_text" | "inventory_policy" | "inventory_quantity" | "continue_selling_when_out_of_stock"
    >
  > & { product_media?: ProductMediaRef[] | null };

export function productPrice(cents: number | null | undefined): string {
  return cents == null ? "Price after review" : `From $${(cents / 100).toFixed(2)}`;
}

/**
 * A directly purchasable product has a real price, not a starting point, so
 * "From $40" would understate what the customer is actually committing to.
 */
export function priceLabel(mode: PurchaseMode, cents: number | null | undefined): string {
  if (cents == null) return "Price after review";
  if (mode === "direct_purchase") return `$${(cents / 100).toFixed(2)}`;
  return `From $${(cents / 100).toFixed(2)}`;
}

export function cardAction(mode: PurchaseMode, available: boolean): string {
  if (!available) return "View";
  if (mode === "direct_purchase") return "Buy now";
  if (mode === "direct_or_request") return "Buy or customize";
  return "Customize";
}

type ProductCardProps = {
  product: ProductCardProduct;
  /** Availability and stock chips are meaningful in the catalog, noise on the homepage. */
  showAvailability?: boolean;
  priority?: boolean;
};

/**
 * One product card for the whole site. The homepage and the catalog grid used
 * to carry separate markup and separate image handling, which is how the
 * homepage ended up rendering placeholders for products that had images.
 *
 * The card exposes exactly one link. The product name carries it and stretches
 * over the whole card, so the entire card is clickable without giving keyboard
 * and screen-reader users three redundant stops on the same destination.
 */
export default function ProductCard({ product, showAvailability = true, priority = false }: ProductCardProps) {
  const href = `/catalog/${product.slug}`;
  const mode = normalizePurchaseMode(product.purchase_mode);
  const canRequest =
    product.availability_status == null
      ? true
      : productCanBeRequested({
          availability_status: product.availability_status,
          inventory_policy: product.inventory_policy ?? "unlimited",
          inventory_quantity: product.inventory_quantity ?? 0,
          continue_selling_when_out_of_stock: product.continue_selling_when_out_of_stock ?? false,
        });

  return (
    <article className="product-card">
      <ProductImage product={product} alt={product.name} priority={priority} />

      <div className="product-card-body">
        <div className="flex items-center justify-between gap-2 text-xs text-brand-textMuted">
          <span>{product.category || "Custom work"}</span>
          {product.is_custom ? <span className="ui-badge ui-badge-accent">Customizable</span> : null}
        </div>

        <h3 className="mt-2 text-xl font-semibold">
          <Link href={href} className="product-card-link">
            {product.name}
          </Link>
        </h3>

        {product.short_description ? (
          <p className="mt-2 line-clamp-2 text-sm leading-6 text-brand-textMuted">{product.short_description}</p>
        ) : null}

        {showAvailability && product.availability_status ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <span className={`ui-badge ${canRequest ? "ui-badge-success" : "ui-badge-danger"}`}>
              {availabilityLabel(product.availability_status)}
            </span>
            {product.lead_time_text ? <span className="ui-badge">{product.lead_time_text}</span> : null}
          </div>
        ) : null}

        <div className="product-card-footer">
          <p className="text-sm font-semibold text-brand-primary">{priceLabel(mode, product.starting_price_cents)}</p>
          <span className="product-card-action">{cardAction(mode, canRequest)}</span>
        </div>
      </div>
    </article>
  );
}
