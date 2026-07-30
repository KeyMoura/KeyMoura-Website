"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { CropState, ImgMeta } from "@/lib/imageCrop";
import { clampCropToBounds, DEFAULT_CROP, getDefaultCropBox } from "@/lib/imageCrop";

type Props = {
  srcUrl: string;
  meta: ImgMeta;
  aspect: number;
  crop: CropState;
  onCropChange: (next: CropState) => void;
  onFrameChange?: (frame: { w: number; h: number }) => void;
  disabled?: boolean;
  maxZoom?: number;
  /** Optional helper text shown above the crop frame. */
  hint?: string;
};

/**
 * A lightweight, dependency-free image cropper.
 *
 * - Fixed crop frame aspect ratio
 * - Drag to pan
 * - Slider (and wheel/trackpad) to zoom
 * - Math is shared with the export helper so the saved crop matches the preview.
 */
export function ImageCropper({
  srcUrl,
  meta,
  aspect,
  crop,
  onCropChange,
  onFrameChange,
  disabled,
  maxZoom = 4,
  hint = "Move the crop box • Zoom to crop",
}: Props) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [frame, setFrame] = useState<{ w: number; h: number }>({
    w: 640,
    h: Math.round(640 / aspect),
  });

  // Keep frame measurements in sync with layout.
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;

    const update = () => {
      const w = el.clientWidth || 640;
      const h = el.clientHeight || Math.round(w / aspect);
      const next = { w, h };
      setFrame(next);
      onFrameChange?.(next);
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, [aspect, onFrameChange]);

  const safe = useMemo(
    () => clampCropToBounds(crop, frame.w, frame.h, meta, aspect, maxZoom),
    [crop, frame.w, frame.h, meta, aspect, maxZoom]
  );

  // If the crop becomes invalid due to resize/meta change, snap it back.
  useEffect(() => {
    if (
      safe.zoom !== crop.zoom ||
      safe.panX !== crop.panX ||
      safe.panY !== crop.panY
    ) {
      onCropChange(safe);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame.w, frame.h, meta.w, meta.h, maxZoom]);

  const box = useMemo(
    () => getDefaultCropBox(frame.w, frame.h, aspect, meta),
    [frame.w, frame.h, aspect, meta]
  );

  // Display sizing: size the image so it *covers the crop box* at zoom=1,
  // then scale via CSS transform for natural zooming (no stretch/contain feel).
  const base = useMemo(() => {
    const wScale = box.w / meta.w;
    const hScale = box.h / meta.h;
    return Math.max(wScale, hScale);
  }, [box.w, box.h, meta.w, meta.h]);

  const dispW = meta.w * base;
  const dispH = meta.h * base;


  const draggingRef = useRef(false);
  const lastRef = useRef<{ x: number; y: number } | null>(null);

  const setSafe = (next: CropState) =>
    onCropChange(clampCropToBounds(next, frame.w, frame.h, meta, aspect, maxZoom));

  const onPointerDown = (e: React.PointerEvent) => {
    if (disabled) return;
    draggingRef.current = true;
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    lastRef.current = { x: e.clientX, y: e.clientY };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (disabled) return;
    if (!draggingRef.current || !lastRef.current) return;

    const dx = e.clientX - lastRef.current.x;
    const dy = e.clientY - lastRef.current.y;
    lastRef.current = { x: e.clientX, y: e.clientY };

    setSafe({ ...safe, panX: safe.panX + dx, panY: safe.panY + dy });
  };

  const onPointerUp = () => {
    draggingRef.current = false;
    lastRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (disabled) return;
    // Trackpad pinch/scroll feels better with smaller steps.
    const delta = Math.sign(e.deltaY) * 0.06;
    const nextZoom = Math.max(1, Math.min(maxZoom, safe.zoom - delta));
    if (nextZoom !== safe.zoom) {
      e.preventDefault();
      setSafe({ ...safe, zoom: nextZoom });
    }
  };

  return (
    <div className="space-y-2">
      <div className="text-[10px] text-brand-textMuted">{hint}</div>

      <div
        ref={frameRef}
        // Pointer handlers are attached to the crop box below.
        onWheel={onWheel}
        className={
          "relative w-full overflow-hidden rounded-lg border border-zinc-700 bg-black/60 " +
          (disabled ? "opacity-70" : "")
        }
        style={{ aspectRatio: `${aspect}` }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={srcUrl}
          alt="Crop preview"
          draggable={false}
          className="absolute left-1/2 top-1/2 select-none"
          style={{
            width: `${dispW}px`,
            height: `${dispH}px`,
            transform: `translate(-50%, -50%) scale(${safe.zoom})`,
          }}
        />

        {/* Crop window (moves; image stays put) */}
        <div
          role="slider"
          aria-label="Crop selection"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          className={
            "absolute left-1/2 top-1/2 rounded-md border border-white/75 ring-1 ring-white/10 " +
            (disabled ? "pointer-events-none" : "cursor-grab active:cursor-grabbing")
          }
          style={{
            width: `${box.w}px`,
            height: `${box.h}px`,
            transform: `translate(calc(-50% + ${safe.panX}px), calc(-50% + ${safe.panY}px))`,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
          }}
        />
      </div>

      <div className="flex items-center gap-3">
        <label className="text-[11px] text-brand-textMuted">Zoom</label>
        <input
          aria-label="Image zoom"
          type="range"
          min={1}
          max={maxZoom}
          step={0.01}
          value={safe.zoom}
          onChange={(e) => setSafe({ ...safe, zoom: Number.parseFloat(e.target.value) })}
          className="w-full"
          disabled={disabled}
        />
        <button
          type="button"
          onClick={() => onCropChange(DEFAULT_CROP)}
          className="rounded-full border border-zinc-700 bg-black/40 px-3 py-1 text-[11px] text-brand-textMuted hover:border-amber-400/70 hover:text-brand-text disabled:opacity-60"
          disabled={disabled}
        >
          Reset
        </button>
      </div>
    </div>
  );
}
