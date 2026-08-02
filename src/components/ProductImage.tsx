"use client";

import Image from "next/image";
import { useState } from "react";
import { isOptimizableImageUrl, productImageCandidates, type ProductImageSource } from "@/lib/productImages";

type ProductImageProps = {
  product: ProductImageSource;
  alt: string;
  /** Cards above the fold should not be lazy. */
  priority?: boolean;
  /** Layout hint for the optimizer; matches the catalog and homepage grids. */
  sizes?: string;
  className?: string;
};

const DEFAULT_SIZES = "(min-width: 1024px) 22rem, (min-width: 640px) 45vw, 100vw";

/**
 * The product image used by every catalog surface.
 *
 * The container always reserves a 4:3 box, so a missing, slow, or broken image
 * never shifts the layout. Broken URLs step forward through the remaining
 * gallery images before falling back to the brand mark, which keeps a product
 * with one dead URL and three good ones from looking imageless.
 *
 * Uploads in this project's Supabase Storage go through next/image, which
 * matters because catalog covers are routinely several thousand pixels wide.
 * Operator-supplied URLs on other hosts are not in the optimizer's allow-list,
 * so those render as a plain <img> rather than failing.
 */
export default function ProductImage({
  product,
  alt,
  priority = false,
  sizes = DEFAULT_SIZES,
  className,
}: ProductImageProps) {
  const candidates = productImageCandidates(product);
  const [index, setIndex] = useState(0);
  const src = candidates[index];
  const nextCandidate = () => setIndex((current) => current + 1);

  return (
    <div className={`product-image ${className ?? ""}`.trim()}>
      {src ? (
        isOptimizableImageUrl(src) ? (
          <Image
            key={src}
            src={src}
            alt={alt}
            fill
            sizes={sizes}
            priority={priority}
            onError={nextCandidate}
            className="product-image-media"
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={src}
            src={src}
            alt={alt}
            loading={priority ? "eager" : "lazy"}
            decoding="async"
            fetchPriority={priority ? "high" : "auto"}
            onError={nextCandidate}
            className="product-image-media"
          />
        )
      ) : (
        <span className="product-image-fallback" aria-hidden="true">
          KM
        </span>
      )}
    </div>
  );
}
