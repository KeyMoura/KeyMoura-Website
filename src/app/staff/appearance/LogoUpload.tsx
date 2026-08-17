"use client";

import { useId, useRef, useState } from "react";

import { SLOT_POLICY, type BrandSlot } from "@/lib/brandAssets";

import { anchorId } from "./EditorChrome";

/**
 * Upload, replace, or clear one brand mark.
 *
 * ## Why the file input is a real file input
 *
 * The obvious build for this is a styled `<div>` with a drop zone and a hidden
 * input triggered by a click handler. That is how upload controls stop being
 * reachable by keyboard: a `div` is not focusable, so the only route to the
 * picker is a mouse, and the accessible name of the whole control disappears
 * with it.
 *
 * So the input is a labelled `<input type="file">` — focusable, announced, and
 * operable with Space like any other — and the drop zone is layered *around* it
 * as an enhancement. Dropping a file is never the only way to do anything.
 *
 * ## Failure is announced, not just coloured
 *
 * A rejected upload writes into a `role="status"` region and is wired to the
 * input with `aria-describedby`, because "the border went red" is not a message.
 * Nearly every rejection here is a real, correctable mistake — wrong format, too
 * large, the wrong image — and the sentence has to say which.
 */

/** A logo is judged on the near-black navbar and on a raised panel. */
const DEFAULT_SURFACES = [
  { name: "On the navbar", background: "var(--km-nav-bg)" },
  { name: "On a panel", background: "var(--km-surface-strong)" },
] as const;
export function LogoUpload({
  slot,
  anchor,
  label,
  description,
  value,
  surfaces,
  onChange,
  onNotice,
}: {
  slot: BrandSlot;
  /** The search index's id for this control, so a result can land on it. */
  anchor: string;
  label: string;
  description: string;
  /** The current stored URL, or "" when the slot is empty. */
  value: string;
  /**
   * The backgrounds to judge the image against.
   *
   * A logo is judged on the navbar and on a panel — a white mark uploaded as the
   * alternate looks like an empty box on one of them, and an owner who only ever
   * sees it on the other will not find out until a customer does. A hero
   * photograph has one background and a shape, so it gets a single wide frame
   * instead of two squares.
   */
  surfaces?: readonly { name: string; background: string }[];
  onChange: (url: string) => void;
  onNotice: (message: string) => void;
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const policy = SLOT_POLICY[slot];
  const maxMb = Math.round(policy.maxBytes / (1024 * 1024));

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  async function upload(file: File) {
    setBusy(true);
    setError("");

    // A first pass in the browser, so the obvious mistake does not cost a round
    // trip. It is not the check that matters: the route re-reads the bytes and
    // does not trust the type the browser reported. See `brandAssets.ts`.
    if (file.size > policy.maxBytes) {
      setError(`That file is over ${maxMb} MB. Please use a smaller image.`);
      setBusy(false);
      return;
    }

    const body = new FormData();
    body.append("slot", slot);
    body.append("file", file);

    try {
      const response = await fetch("/api/staff/appearance/brand-asset", { method: "POST", body });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Could not upload that image.");
      onChange(result.url as string);
      onNotice(`${label} uploaded (${result.width}×${result.height}). Publish to make it live.`);
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not upload that image.");
    } finally {
      setBusy(false);
      // The same file can be chosen twice in a row — after a failure, that is
      // the *likely* next action. Without this the input's value is unchanged
      // and no `change` event fires.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function clear() {
    const previous = value;
    onChange("");
    setError("");
    onNotice(`${label} cleared. Publish to make it live.`);
    // Best effort, and only ever for an object this site stored — the route
    // refuses anything else. A failure here leaves one orphaned file and is not
    // worth putting in front of the owner, who has already got what they asked
    // for on screen.
    await fetch("/api/staff/appearance/brand-asset", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slot, url: previous }),
    }).catch(() => {});
  }

  return (
    <div
      id={anchorId(anchor)}
      tabIndex={-1}
      className={`ui-card scroll-mt-4 ${dragging ? "!border-brand-primary" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        const file = event.dataTransfer.files?.[0];
        if (file) void upload(file);
      }}
    >
      <p className="text-sm font-semibold">{label}</p>
      <p className="mt-1 text-xs text-brand-textMuted">{description}</p>

      {/* The backgrounds this image has to survive. See the `surfaces` prop. */}
      <div className={`mt-3 grid gap-2 ${(surfaces ?? DEFAULT_SURFACES).length > 1 ? "grid-cols-2" : ""}`}>
        {(surfaces ?? DEFAULT_SURFACES).map((surface) => (
          <div
            key={surface.name}
            /* No border: these two are already told apart by the thing that
               matters — the background each one paints, which is the whole
               point of showing the mark twice. An outline on top of that was a
               third bordered box inside the section card for no information. */
            className="rounded-[var(--control-radius)] p-3"
            style={{ background: surface.background }}
          >
            <div className="flex h-12 items-center justify-center">
              {value ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={value} alt="" className="max-h-12 max-w-full object-contain" />
              ) : (
                <span className="text-[11px] text-brand-textMuted">Not set</span>
              )}
            </div>
            <p className="mt-2 text-center text-[10px] uppercase tracking-[.1em] text-brand-textMuted">
              {surface.name}
            </p>
          </div>
        ))}
      </div>

      <label htmlFor={inputId} className="ui-label mt-3 block">
        {value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
      </label>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        // A hint for the picker, not a check. The server sniffs the bytes.
        accept="image/png,image/jpeg,image/webp"
        disabled={busy}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
        className="ui-input file:mr-3 file:rounded-full file:border-0 file:bg-brand-primary/15 file:px-3 file:py-1 file:text-xs file:font-semibold file:text-brand-primary"
      />
      <p className="mt-1 text-xs text-brand-textMuted">
        PNG, JPEG or WebP, under {maxMb} MB, at least {policy.minDimension}px on each side. You can also drop a
        file on this card. SVG is not accepted.
      </p>

      {/* `role="status"` rather than `alert`: the message follows an action the
          owner just took, so it does not need to interrupt anything. */}
      <p id={errorId} role="status" className="mt-1 min-h-4 text-xs text-rose-300">
        {busy ? "Uploading…" : error}
      </p>

      {value ? (
        <button type="button" onClick={() => void clear()} className="ui-btn ui-btn-ghost mt-1 !py-1.5 text-xs">
          Remove {label.toLowerCase()}
        </button>
      ) : null}
    </div>
  );
}
