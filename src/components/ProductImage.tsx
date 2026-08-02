"use client";

import { useState } from "react";
import { productImageCandidates, type ProductImageSource } from "@/lib/productImages";

type ProductImageProps = {
  product: ProductImageSource;
  alt: string;
  /** Cards above the fold should not be lazy. */
  priority?: boolean;
  className?: string;
};

/**
 * The product image used by every catalog surface.
 *
 * The container always reserves a 4:3 box, so a missing, slow, or broken image
 * never shifts the layout. Broken URLs step forward through the remaining
 * gallery images before falling back to the brand mark, which keeps a product
 * with one dead URL and three good ones from looking imageless.
 *
 * Product images are operator-supplied URLs that are not restricted to a
 * configured host, so next/image optimization does not apply here.
 */
export default function ProductImage({ product, alt, priority = false, className }: ProductImageProps) {
  const candidates = productImageCandidates(product);
  const [index, setIndex] = useState(0);
  const src = candidates[index];

  return (
    <div className={`product-image ${className ?? ""}`.trim()}>
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={src}
          src={src}
          alt={alt}
          loading={priority ? "eager" : "lazy"}
          decoding="async"
          fetchPriority={priority ? "high" : "auto"}
          onError={() => setIndex((current) => current + 1)}
          className="product-image-media"
        />
      ) : (
        <span className="product-image-fallback" aria-hidden="true">
          KM
        </span>
      )}
    </div>
  );
}
