"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faChevronLeft,
  faChevronRight,
  faXmark,
  faExpand,
  faCube,
} from "@fortawesome/free-solid-svg-icons";
import { ProductModelViewer } from "@/components/ProductModelViewer";
import { isOptimizableImageUrl } from "@/lib/productImages";

export type GalleryImage = { id: string; url: string; alt: string; caption: string | null };

type ProductGalleryProps = {
  images: GalleryImage[];
  productName: string;
  modelUrl: string | null;
  modelPoster: string | null;
};

/**
 * The product gallery.
 *
 * Replaces a square box with two chevrons and a row of 80px thumbnails. What is
 * different, and why:
 *
 * - **The frame never moves.** A 4:3 box is reserved with `aspect-ratio` before
 *   anything loads, so a slow image cannot push the purchase panel down the
 *   page. The old gallery reserved its box too; the thumbnails did not, and a
 *   late-loading strip shifted everything under it.
 * - **Thumbnails are vertical from `lg` and horizontal below.** Vertical is
 *   what gives the primary image the full column width on a desktop; a
 *   horizontal strip costs the image 96px of height for no gain when there is
 *   space beside it.
 * - **Zoom is pointer-position magnification, not a modal.** Hovering the
 *   primary image scales it around the cursor, which is what someone inspecting
 *   a machined finish actually wants. It is disabled under
 *   `prefers-reduced-motion` and on touch, where a hover state does not exist
 *   and the transform would fight the scroll.
 * - **Fullscreen is a real dialog** with focus trapped, Escape to close, focus
 *   restored to the control that opened it, and arrow keys still moving through
 *   the set.
 * - **Resolution is not re-implemented.** The caller passes images already
 *   resolved by `productImages.ts`; this component decides only which one is
 *   showing. A second resolver is how the gallery and the cards start
 *   disagreeing about which photograph is the cover.
 *
 * A broken URL steps forward to the next image rather than dropping to the
 * placeholder, so one dead link in a set of five does not make a product look
 * imageless.
 */
export default function ProductGallery({ images, productName, modelUrl, modelPoster }: ProductGalleryProps) {
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState<string[]>([]);
  const [showModel, setShowModel] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [zoom, setZoom] = useState<{ x: number; y: number } | null>(null);

  const frameRef = useRef<HTMLDivElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const thumbRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const usable = images.filter((image) => !failed.includes(image.url));
  const active = usable[Math.min(index, Math.max(usable.length - 1, 0))] ?? null;
  const count = usable.length;

  const step = useCallback(
    (direction: -1 | 1) => {
      if (count < 2) return;
      setShowModel(false);
      setZoom(null);
      setIndex((current) => (current + direction + count) % count);
    },
    [count]
  );

  // Arrow keys move through the set whenever the gallery holds focus, and
  // always while the fullscreen dialog is open.
  useEffect(() => {
    if (!fullscreen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setFullscreen(false);
        expandRef.current?.focus();
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        step(1);
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        step(-1);
      }
      if (event.key === "Tab") {
        const panel = dialogRef.current;
        if (!panel) return;
        const items = Array.from(
          panel.querySelectorAll<HTMLElement>('button:not([disabled]), [tabindex]:not([tabindex="-1"])')
        );
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [fullscreen, step]);

  // Lock the page behind the fullscreen viewer and move focus into it.
  useEffect(() => {
    if (!fullscreen) return;
    const { body } = document;
    const previous = body.style.overflow;
    body.style.overflow = "hidden";
    const timer = window.setTimeout(() => closeRef.current?.focus(), 0);
    return () => {
      body.style.overflow = previous;
      window.clearTimeout(timer);
    };
  }, [fullscreen]);

  const onImageError = (url: string) => setFailed((current) => [...current, url]);

  const onThumbKeyDown = (event: React.KeyboardEvent, position: number) => {
    const forward = event.key === "ArrowRight" || event.key === "ArrowDown";
    const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
    if (!forward && !back) return;
    event.preventDefault();
    const next = (position + (forward ? 1 : -1) + count) % count;
    setShowModel(false);
    setIndex(next);
    thumbRefs.current[next]?.focus();
  };

  const renderImage = (image: GalleryImage, sizes: string, priority: boolean, className: string) =>
    isOptimizableImageUrl(image.url) ? (
      <Image
        key={image.url}
        src={image.url}
        alt={image.alt}
        fill
        sizes={sizes}
        priority={priority}
        onError={() => onImageError(image.url)}
        className={className}
      />
    ) : (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={image.url}
        src={image.url}
        alt={image.alt}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        onError={() => onImageError(image.url)}
        className={`${className} absolute inset-0 h-full w-full`}
      />
    );

  const showModelView = showModel && modelUrl;

  return (
    <div className="product-gallery">
      <div className="product-gallery-main">
        <div
          ref={frameRef}
          className={`product-gallery-frame${zoom ? " is-zoomed" : ""}`}
          onMouseMove={(event) => {
            if (showModelView || !active) return;
            // Disabled for reduced motion and for coarse pointers, where there
            // is no hover state and the transform fights the scroll.
            if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
            if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setZoom({
              x: ((event.clientX - rect.left) / rect.width) * 100,
              y: ((event.clientY - rect.top) / rect.height) * 100,
            });
          }}
          onMouseLeave={() => setZoom(null)}
          style={zoom ? ({ ["--zoom-x" as string]: `${zoom.x}%`, ["--zoom-y" as string]: `${zoom.y}%` }) : undefined}
        >
          {showModelView ? (
            <ProductModelViewer src={modelUrl} poster={modelPoster || active?.url || null} alt={`3D view of ${productName}`} />
          ) : active ? (
            renderImage(active, "(min-width: 1024px) 46rem, 100vw", index === 0, "product-gallery-image")
          ) : (
            <span className="product-gallery-fallback" aria-hidden="true">
              KM
            </span>
          )}

          {!showModelView && active ? (
            <button
              ref={expandRef}
              type="button"
              onClick={() => setFullscreen(true)}
              className="product-gallery-expand"
              aria-label={`View ${productName} full screen`}
            >
              <FontAwesomeIcon icon={faExpand} className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          ) : null}

          {!showModelView && count > 1 ? (
            <>
              <button
                type="button"
                onClick={() => step(-1)}
                className="product-gallery-nav product-gallery-nav-prev"
                aria-label="Previous image"
              >
                <FontAwesomeIcon icon={faChevronLeft} className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => step(1)}
                className="product-gallery-nav product-gallery-nav-next"
                aria-label="Next image"
              >
                <FontAwesomeIcon icon={faChevronRight} className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
              <span className="product-gallery-counter">
                {Math.min(index, count - 1) + 1} / {count}
              </span>
            </>
          ) : null}
        </div>

        {/* Captions are optional and only rendered when set, so the space below
            the frame does not sit reserved and empty on most products. */}
        {!showModelView && active?.caption ? (
          <p className="product-gallery-caption">{active.caption}</p>
        ) : null}
      </div>

      {count > 1 || modelUrl ? (
        <div className="product-gallery-thumbs" role="group" aria-label="Product images">
          {usable.map((image, position) => (
            <button
              key={image.id}
              ref={(node) => {
                thumbRefs.current[position] = node;
              }}
              type="button"
              onClick={() => {
                setShowModel(false);
                setIndex(position);
              }}
              onKeyDown={(event) => onThumbKeyDown(event, position)}
              className={`product-gallery-thumb${!showModelView && position === index ? " is-selected" : ""}`}
              aria-label={`Show image ${position + 1} of ${count}`}
              aria-current={!showModelView && position === index ? "true" : undefined}
            >
              {isOptimizableImageUrl(image.url) ? (
                <Image src={image.url} alt="" fill sizes="80px" className="object-cover" />
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={image.url} alt="" loading="lazy" className="absolute inset-0 h-full w-full object-cover" />
              )}
            </button>
          ))}

          {modelUrl ? (
            <button
              type="button"
              onClick={() => setShowModel(true)}
              className={`product-gallery-thumb product-gallery-thumb-model${showModelView ? " is-selected" : ""}`}
              aria-label="Show the 3D model"
              aria-current={showModelView ? "true" : undefined}
            >
              <FontAwesomeIcon icon={faCube} className="h-4 w-4" aria-hidden="true" />
              <span>3D</span>
            </button>
          ) : null}
        </div>
      ) : null}

      {fullscreen && active ? (
        <div className="product-lightbox" role="dialog" aria-modal="true" aria-label={`${productName} images`}>
          <div
            className="product-lightbox-backdrop"
            onClick={() => {
              setFullscreen(false);
              expandRef.current?.focus();
            }}
            aria-hidden="true"
          />
          <div ref={dialogRef} className="product-lightbox-panel">
            <button
              ref={closeRef}
              type="button"
              onClick={() => {
                setFullscreen(false);
                expandRef.current?.focus();
              }}
              className="product-lightbox-close"
              aria-label="Close full screen view"
            >
              <FontAwesomeIcon icon={faXmark} className="h-4 w-4" aria-hidden="true" />
            </button>

            <div className="product-lightbox-frame">
              {renderImage(active, "100vw", true, "product-lightbox-image")}
            </div>

            {count > 1 ? (
              <div className="product-lightbox-controls">
                <button type="button" onClick={() => step(-1)} className="product-gallery-nav" aria-label="Previous image">
                  <FontAwesomeIcon icon={faChevronLeft} className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <span className="product-lightbox-counter">
                  {Math.min(index, count - 1) + 1} / {count}
                </span>
                <button type="button" onClick={() => step(1)} className="product-gallery-nav" aria-label="Next image">
                  <FontAwesomeIcon icon={faChevronRight} className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
