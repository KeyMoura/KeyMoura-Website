"use client";

import { useEffect, useMemo, useState } from "react";
import { ImageCropper } from "@/components/ImageCropper";
import {
  DEFAULT_CROP,
  getImageMetaFromUrl,
  renderCroppedJpeg,
  type CropState,
  type ImgMeta,
} from "@/lib/imageCrop";

type Props = {
  open: boolean;
  title?: string;
  file: File | null;
  aspect: number;
  maxSize: number;
  quality?: number;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
  confirmLabel?: string;
  hint?: string;
};

export function ImageCropModal({
  open,
  title = "Crop image",
  file,
  aspect,
  maxSize,
  quality,
  onCancel,
  onConfirm,
  confirmLabel = "Use crop",
  hint,
}: Props) {
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [meta, setMeta] = useState<ImgMeta | null>(null);
  const [crop, setCrop] = useState<CropState>(DEFAULT_CROP);
  const [frame, setFrame] = useState<{ w: number; h: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !file) return;

    setError(null);
    setBusy(false);
    setCrop(DEFAULT_CROP);
    setMeta(null);

    const url = URL.createObjectURL(file);
    setSrcUrl(url);

    getImageMetaFromUrl(url)
      .then((m) => setMeta(m))
      .catch(() => setMeta(null));

    return () => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        // ignore
      }
    };
  }, [open, file]);

  const canConfirm = useMemo(() => {
    return !!file && !!meta && !!frame && !busy;
  }, [file, meta, frame, busy]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-950 p-4 text-brand-text">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-1 text-xs text-brand-textMuted">
              Move the crop box. Use the slider (or trackpad/mouse wheel) to zoom.
            </p>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-brand-textMuted hover:border-zinc-500"
            disabled={busy}
          >
            Close
          </button>
        </div>

        {error ? (
          <p className="mt-3 rounded-md border border-rose-500/60 bg-rose-950/40 px-3 py-2 text-[12px] text-rose-200">
            {error}
          </p>
        ) : null}

        <div className="mt-4">
          {srcUrl && meta ? (
            <ImageCropper
              srcUrl={srcUrl}
              meta={meta}
              aspect={aspect}
              crop={crop}
              onCropChange={setCrop}
              onFrameChange={setFrame}
              disabled={busy}
              hint={hint}
            />
          ) : (
            <div className="rounded-lg border border-zinc-800 bg-black/30 p-4 text-sm text-brand-textMuted">
              Loading preview…
            </div>
          )}
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-zinc-700 px-3 py-2 text-xs text-brand-textMuted hover:border-zinc-500"
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={async () => {
              if (!file || !meta || !frame) return;
              setBusy(true);
              setError(null);
              try {
                const blob = await renderCroppedJpeg({
                  file,
                  meta,
                  frameW: frame.w,
                  frameH: frame.h,
                  crop,
                  maxSize,
                  aspect,
                  quality,
                });
                onConfirm(blob);
              } catch (e) {
                console.error("Failed to crop image", e);
                setError("Failed to crop image. Please try a different file.");
              } finally {
                setBusy(false);
              }
            }}
            className="rounded-lg border border-amber-400/70 bg-amber-500/15 px-3 py-2 text-xs font-medium text-amber-100 hover:bg-amber-500/25 disabled:opacity-60"
          >
            {busy ? "Working…" : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
