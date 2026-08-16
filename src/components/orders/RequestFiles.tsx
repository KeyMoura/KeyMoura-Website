"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faArrowUpFromBracket, faXmark, faRotateRight } from "@fortawesome/free-solid-svg-icons";
import { cx } from "@/components/ui/DesignSystem";
import {
  FILE_ACCEPT_ATTRIBUTE,
  FILE_KIND_LABEL,
  MAX_REQUEST_FILES,
  fileKind,
  fileProblem,
  formatBytes,
} from "@/lib/orders/customRequest";

/**
 * The reference-file area.
 *
 * ## What it replaces
 *
 * `<input type="file" multiple>` and, underneath it, the chosen filenames
 * joined with commas into one line of text. That gave a customer no way to
 * remove one file of six, no indication of which of them the shop could
 * actually open, no size until the upload failed, and — because a second use of
 * the picker *replaces* `input.files` rather than adding to it — no way to
 * attach a drawing and then a photo without losing the drawing.
 *
 * ## The rules it follows
 *
 * **The input is the control.** Drag-and-drop and clipboard paste are added on
 * top of a real, focusable, labelled `<input type="file">`; they are not a
 * replacement for it. A pointer gesture that cannot be performed with a
 * keyboard is a feature some customers do not have.
 *
 * **Nothing is uploaded here.** Files are held in memory until the request is
 * submitted, which is what makes "remove" instant and free and what keeps a
 * customer who abandons the form from leaving objects in the bucket. The
 * consequence — that a draft cannot carry its attachments — is stated on the
 * screen rather than discovered.
 *
 * **Rejections are per file and are shown, not swallowed.** Dropping six files
 * where two are unsupported keeps the four and says what happened to the other
 * two. The previous version silently truncated at ten with no message at all.
 *
 * **Thumbnails are local object URLs**, revoked when the file goes. No upload,
 * no round trip, and a CAD file gets a type badge instead — because rendering
 * something for a `.step` file would mean pretending to have parsed it.
 */

export type PendingFile = {
  /** Stable across re-renders so React keys and the retry path survive edits. */
  id: string;
  file: File;
  note: string;
  /** Set when a previous submit failed to upload this particular file. */
  error?: string;
};

export function RequestFiles({
  files,
  onChange,
  disabled = false,
  disabledReason,
}: {
  files: PendingFile[];
  onChange: (files: PendingFile[]) => void;
  /** Guests cannot upload — the storage prefix is keyed on an account. */
  disabled?: boolean;
  disabledReason?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const zoneRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [rejected, setRejected] = useState<string[]>([]);

  const remaining = MAX_REQUEST_FILES - files.length;

  /**
   * Accepts what it can and reports what it cannot, rather than taking the
   * first ten and going quiet about the rest.
   */
  const accept = (incoming: FileList | File[] | null) => {
    if (disabled || !incoming) return;
    const list = Array.from(incoming);
    if (!list.length) return;

    const problems: string[] = [];
    const kept: PendingFile[] = [];

    for (const file of list) {
      if (kept.length >= remaining) {
        problems.push(
          `${file.name} was not added — ${MAX_REQUEST_FILES} files is the limit for one request.`
        );
        continue;
      }
      const problem = fileProblem(file);
      if (problem) {
        problems.push(problem);
        continue;
      }
      // Same name and size twice is the "I clicked browse again" case, not a
      // second file. Adding it would upload the same drawing twice.
      const duplicate =
        files.some((entry) => entry.file.name === file.name && entry.file.size === file.size) ||
        kept.some((entry) => entry.file.name === file.name && entry.file.size === file.size);
      if (duplicate) {
        problems.push(`${file.name} is already attached.`);
        continue;
      }
      kept.push({ id: crypto.randomUUID(), file, note: "" });
    }

    setRejected(problems);
    if (kept.length) onChange([...files, ...kept]);
  };

  const remove = (id: string) => {
    setRejected([]);
    onChange(files.filter((entry) => entry.id !== id));
  };

  const setNote = (id: string, note: string) =>
    onChange(files.map((entry) => (entry.id === id ? { ...entry, note: note.slice(0, 200) } : entry)));

  /**
   * Paste, scoped to this area rather than the document.
   *
   * A document-level paste handler would swallow a screenshot the customer was
   * pasting into the description box. Listening on the drop zone means paste
   * only attaches a file when the customer's focus is already here.
   */
  useEffect(() => {
    const zone = zoneRef.current;
    if (!zone || disabled) return;
    const onPaste = (event: ClipboardEvent) => {
      const items = Array.from(event.clipboardData?.files ?? []);
      if (!items.length) return;
      event.preventDefault();
      accept(items);
    };
    zone.addEventListener("paste", onPaste);
    return () => zone.removeEventListener("paste", onPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [disabled, files, remaining]);

  if (disabled) {
    return (
      <div className="request-dropzone is-disabled">
        <FontAwesomeIcon icon={faArrowUpFromBracket} className="h-5 w-5 opacity-40" aria-hidden="true" />
        <p className="mt-3 text-sm font-medium">Attachments need an account</p>
        <p className="request-dropzone-hint">{disabledReason}</p>
      </div>
    );
  }

  return (
    <div>
      <div
        ref={zoneRef}
        className={cx("request-dropzone", dragging && "is-dragging")}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          // Only when the pointer really left the zone, not when it crossed
          // onto a child — otherwise the highlight strobes as it moves.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          accept(event.dataTransfer?.files ?? null);
        }}
      >
        <FontAwesomeIcon icon={faArrowUpFromBracket} className="h-5 w-5 text-brand-primary" aria-hidden="true" />

        {/*
          The label is the visible button and the input is the control it names,
          so a pointer click, a Tab-then-Enter, and a screen reader all reach the
          same thing. The input is not `display:none` — a hidden input cannot be
          focused, which would take this out of the tab order entirely.
        */}
        <label htmlFor={inputId} className="request-dropzone-button">
          Choose files
        </label>
        <input
          ref={inputRef}
          id={inputId}
          type="file"
          multiple
          className="sr-only"
          accept={FILE_ACCEPT_ATTRIBUTE}
          onChange={(event) => {
            accept(event.target.files);
            // Cleared so choosing the same file again after a removal still
            // fires `change` — the input would otherwise consider it unchanged.
            event.target.value = "";
          }}
        />

        <p className="request-dropzone-hint">
          or drag them here, or paste a screenshot
          <br />
          CAD, drawings, PDF, images, or ZIP · up to {MAX_REQUEST_FILES} files · 20 MB each
        </p>
      </div>

      {rejected.length ? (
        <ul className="request-file-rejects" role="alert">
          {rejected.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      ) : null}

      {files.length ? (
        <ul className="request-file-list">
          {files.map((entry) => (
            <FileRow key={entry.id} entry={entry} onRemove={() => remove(entry.id)} onNote={(note) => setNote(entry.id, note)} />
          ))}
        </ul>
      ) : null}

      {files.length ? (
        <p className="mt-3 text-xs text-brand-textMuted">
          {files.length} of {MAX_REQUEST_FILES} attached. Files upload when you submit, so nothing is stored
          if you change your mind.
        </p>
      ) : null}
    </div>
  );
}

function FileRow({
  entry,
  onRemove,
  onNote,
}: {
  entry: PendingFile;
  onRemove: () => void;
  onNote: (note: string) => void;
}) {
  const kind = fileKind(entry.file.name);
  const noteId = useId();

  /**
   * An object URL for images only, revoked when the row goes so a customer who
   * attaches and removes twenty photos does not leak twenty blobs.
   *
   * Derived rather than stored: creating the URL in an effect and then calling
   * `setPreview` means the row renders once without a thumbnail and again with
   * one, which is a cascading render for a value that is a pure function of the
   * file. `useMemo` computes it during the render that needs it, and the effect
   * is left doing the one thing an effect is for — cleaning up the handle when
   * the row is unmounted or the file swapped.
   */
  const preview = useMemo(
    () => (kind === "image" ? URL.createObjectURL(entry.file) : null),
    [entry.file, kind]
  );
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  return (
    <li className={cx("request-file", entry.error && "has-error")}>
      <div className="request-file-thumb" aria-hidden="true">
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="" className="request-file-image" />
        ) : (
          <span className="request-file-kind">{FILE_KIND_LABEL[kind]}</span>
        )}
      </div>

      <div className="request-file-body">
        <p className="request-file-name" title={entry.file.name}>
          {entry.file.name}
        </p>
        <p className="request-file-meta">
          {FILE_KIND_LABEL[kind]} · {formatBytes(entry.file.size)}
        </p>

        {entry.error ? (
          <p className="request-error" role="alert">
            <FontAwesomeIcon icon={faRotateRight} className="mr-1.5 h-3 w-3" aria-hidden="true" />
            {entry.error} It will be tried again when you resubmit.
          </p>
        ) : null}

        <label htmlFor={noteId} className="sr-only">
          Note about {entry.file.name}
        </label>
        <input
          id={noteId}
          className="request-file-note"
          value={entry.note}
          onChange={(event) => onNote(event.target.value)}
          placeholder="Add a note about this file (optional)"
          maxLength={200}
        />
      </div>

      <button type="button" onClick={onRemove} className="request-file-remove" aria-label={`Remove ${entry.file.name}`}>
        <FontAwesomeIcon icon={faXmark} className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </li>
  );
}
