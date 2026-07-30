"use client";

export type ImgMeta = { w: number; h: number };

export type CropState = {
  /** Zoom multiplier relative to the base "cover" scale (1 = just covers the preview frame). */
  zoom: number;
  /** Crop-window translation in CSS pixels relative to the preview frame center. */
  panX: number;
  /** Crop-window translation in CSS pixels relative to the preview frame center. */
  panY: number;
};

export const DEFAULT_CROP: CropState = { zoom: 1, panX: 0, panY: 0 };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function coverBaseScale(boxW: number, boxH: number, imgW: number, imgH: number) {
  // Base scale that ensures the image covers the preview frame.
  // This makes "zoom" behave like a real cropper (no stretchy/contain feel).
  return Math.max(boxW / imgW, boxH / imgH);
}

export function getDefaultCropBox(frameW: number, frameH: number, aspect: number, meta: ImgMeta) {
  // Keep the crop box comfortably inside the frame.
  // (Image coverage/clamping is handled separately in clampCropToBounds.)
  const maxW = frameW * 0.88;
  const maxH = frameH * 0.88;

  let w = maxW;
  let h = w / aspect;
  if (h > maxH) {
    h = maxH;
    w = h * aspect;
  }

  return { w, h };
}

export function clampCropToBounds(
  crop: CropState,
  frameW: number,
  frameH: number,
  meta: ImgMeta,
  aspect: number,
  maxZoom = 4
) {
  const zoom = clamp(crop.zoom, 1, maxZoom);

  // Crop window stays inside the preview frame.
  const box = getDefaultCropBox(frameW, frameH, aspect, meta);
  const maxPanX = Math.max(0, (frameW - box.w) / 2);
  const maxPanY = Math.max(0, (frameH - box.h) / 2);

  // Also ensure the crop window never leaves the image bounds when zoomed.
  // Since the image is centered and not pannable, the available image area shrinks as zoom decreases.
  const base = coverBaseScale(box.w, box.h, meta.w, meta.h);
  const dispW = meta.w * base * zoom;
  const dispH = meta.h * base * zoom;
  const imgMaxPanX = Math.max(0, (dispW - box.w) / 2);
  const imgMaxPanY = Math.max(0, (dispH - box.h) / 2);

  const limX = Math.min(maxPanX, imgMaxPanX);
  const limY = Math.min(maxPanY, imgMaxPanY);

  return {
    zoom,
    panX: clamp(crop.panX, -limX, limX),
    panY: clamp(crop.panY, -limY, limY),
  } satisfies CropState;
}

export async function getImageMetaFromUrl(url: string): Promise<ImgMeta> {
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });
  return { w: img.naturalWidth, h: img.naturalHeight };
}

export async function getImageMetaFromFile(file: File): Promise<ImgMeta> {
  const url = URL.createObjectURL(file);
  try {
    return await getImageMetaFromUrl(url);
  } finally {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }
}

export async function renderCroppedJpeg(opts: {
  file: File;
  meta: ImgMeta;
  frameW: number;
  frameH: number;
  crop: CropState;
  maxSize: number;
  aspect: number;
  quality?: number;
  maxZoom?: number;
}): Promise<Blob> {
  const {
    file,
    meta,
    frameW,
    frameH,
    crop,
    maxSize,
    aspect,
    quality = 0.86,
    maxZoom = 4,
  } = opts;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = "async";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = url;
  });

  // Output dimensions are driven by width; height derived from aspect.
  const outW = Math.min(maxSize, Math.max(1, Math.round(frameW)));
  const outH = Math.max(1, Math.round(outW / aspect));

  const safe = clampCropToBounds(crop, frameW, frameH, meta, aspect, maxZoom);
  const box = getDefaultCropBox(frameW, frameH, aspect, meta);
  const base = coverBaseScale(box.w, box.h, meta.w, meta.h);
  const scale = base * safe.zoom;

  // Convert from crop-window space (CSS px) to image-space (source px)
  const srcW = box.w / scale;
  const srcH = box.h / scale;

  const shiftX = safe.panX / scale;
  const shiftY = safe.panY / scale;

  // Moving the crop window right/down selects farther right/down portions of the image.
  let sx = meta.w / 2 - srcW / 2 + shiftX;
  let sy = meta.h / 2 - srcH / 2 + shiftY;

  sx = clamp(sx, 0, Math.max(0, meta.w - srcW));
  sy = clamp(sy, 0, Math.max(0, meta.h - srcH));

  const canvas = document.createElement("canvas");
  canvas.width = outW;
  canvas.height = outH;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Failed to get canvas context");

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, sx, sy, srcW, srcH, 0, 0, outW, outH);

  try {
    URL.revokeObjectURL(url);
  } catch {
    // ignore
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("Failed to create JPEG blob"))),
      "image/jpeg",
      quality
    );
  });
}
