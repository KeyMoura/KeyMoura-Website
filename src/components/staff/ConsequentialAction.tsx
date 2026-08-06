"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Notice, cx } from "@/components/ui/DesignSystem";
import type { ActionResult, ConflictState } from "@/lib/staff/actionResult";

export { resultFromResponse } from "@/lib/staff/actionResult";
export type { ActionResult, ConflictState } from "@/lib/staff/actionResult";

/**
 * One confirmation surface for every consequential staff action.
 *
 * This replaces `window.confirm`, which was doing the whole job across the
 * order workspace. `confirm` was not merely ugly — it could not do four things
 * the brief requires:
 *
 * 1. **Show the effects as separate facts.** A staff member deciding whether to
 *    approve a cancellation needs to read the money, the stock, the email and
 *    the customer-visible state as four lines, not as one paragraph they skim.
 * 2. **Collect the reason inside the confirmation.** The order page was using
 *    `window.prompt` for the cancellation reason — a second modal, dismissible
 *    independently, with no validation and no way to say the text is what the
 *    customer will read.
 * 3. **Hold a conflict.** `confirm` closes and the error lands somewhere else on
 *    the page. A 409 needs to be shown *where the decision was made*, with the
 *    retry withheld, because a stale consequential action must never be retried
 *    automatically.
 * 4. **Be usable.** `confirm` is not stylable, not screen-reader-labelled the
 *    way a dialog is, and on mobile it is a browser chrome sheet that does not
 *    show what the page is about to do.
 *
 * Deliberately *not* an abstraction over the business rules. The dialog knows
 * how to ask; it knows nothing about what is legal. The server decides, and
 * every caller still posts to a route that re-checks everything. Hiding a button
 * is a courtesy, and this component is the courtesy's front end.
 */

/** How one of the four effect axes reads. `null` means "no effect on this axis". */
export type ActionEffects = {
  /** What the customer sees on their own order page afterwards. */
  customer?: string | null;
  /** Money that moves, in words a person can check. */
  financial?: string | null;
  /** Stock that moves. */
  inventory?: string | null;
  /** The email or notification that goes out, named. */
  notification?: string | null;
};

export type ActionSubmission = {
  /** Free-text reason, when `reason` was requested. */
  reason: string;
  /** Text the customer will read, when `customerNote` was offered. */
  customerNote: string;
  /** Text the customer will never read, when `internalNote` was offered. */
  internalNote: string;
};

export type ConsequentialActionProps = {
  /** Button label. Also the dialog's confirm label unless `confirmLabel` says otherwise. */
  label: string;
  /** Dialog heading — the action stated as a question or an imperative. */
  title: string;
  /** One or two sentences of plain language. No jargon, no status codes. */
  summary: ReactNode;
  /** Where the order is now, in staff words. */
  currentState?: string | null;
  /** Where it will be, in staff words. */
  nextState?: string | null;
  effects?: ActionEffects;
  /** Exactly what the customer would receive, shown verbatim. */
  notificationPreview?: ReactNode;

  /** Ask for a reason. `required` refuses to submit without `minLength` characters. */
  reason?: { label: string; placeholder?: string; required?: boolean; minLength?: number; help?: string };
  /** Offer a note the customer will read. Always labelled as customer-visible. */
  customerNote?: { label: string; placeholder?: string; help?: string };
  /** Offer a note the customer will never read. Always labelled as private. */
  internalNote?: { label: string; placeholder?: string; defaultValue?: string; help?: string };

  confirmLabel?: string;
  /** `danger` for destructive, `money` for anything that moves funds. */
  tone?: "default" | "danger" | "money";
  disabled?: boolean;
  /** Why the button is disabled, shown under it. */
  disabledReason?: string | null;
  className?: string;
  buttonClassName?: string;

  onConfirm: (submission: ActionSubmission) => Promise<ActionResult>;
};

const TONE_BUTTON: Record<NonNullable<ConsequentialActionProps["tone"]>, string> = {
  default: "ui-btn-primary",
  danger: "ui-btn-danger",
  money: "ui-btn-danger",
};

/** Elements that can hold focus inside the dialog, for the tab trap. */
const FOCUSABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

/**
 * The four effect lines.
 *
 * Rendered as a description list so a screen reader reads "Customer: …" rather
 * than a run-on sentence, and so an axis with no effect can be stated as "None"
 * instead of being silently absent — "this changes no stock" is information.
 */
function EffectList({ effects }: { effects: ActionEffects }) {
  const rows: Array<[string, string | null | undefined]> = [
    ["Customer sees", effects.customer],
    ["Money", effects.financial],
    ["Stock", effects.inventory],
    ["Email", effects.notification],
  ];
  const present = rows.filter(([, value]) => value !== undefined);
  if (!present.length) return null;
  return (
    <dl className="mt-4 grid gap-2 rounded-xl border border-zinc-700 bg-black/30 p-3 text-sm">
      {present.map(([label, value]) => (
        <div key={label} className="grid grid-cols-[7.5rem_1fr] gap-2">
          <dt className="text-xs uppercase tracking-wider text-brand-textMuted">{label}</dt>
          <dd className={value ? "" : "text-brand-textMuted"}>{value || "No effect"}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ConsequentialAction({
  label,
  title,
  summary,
  currentState,
  nextState,
  effects,
  notificationPreview,
  reason,
  customerNote,
  internalNote,
  confirmLabel,
  tone = "default",
  disabled = false,
  disabledReason,
  className,
  buttonClassName,
  onConfirm,
}: ConsequentialActionProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [reasonText, setReasonText] = useState("");
  const [customerText, setCustomerText] = useState("");
  const [internalText, setInternalText] = useState(internalNote?.defaultValue ?? "");

  const dialogRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /**
   * Guards the submit against a second entry.
   *
   * `pending` drives the UI, but a ref is what actually stops a double call:
   * two clicks landing in the same React batch would both read the old `pending`
   * and both fire. This is checked and set synchronously.
   */
  const inFlight = useRef(false);

  const headingId = useId();
  const describedId = useId();

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    if (inFlight.current) return;
    setOpen(false);
    setError("");
    setConflict(null);
    // Focus goes back to the control that opened the dialog. Without this a
    // keyboard user lands at the top of the document after every decision.
    triggerRef.current?.focus();
  }, []);

  // Escape closes; Tab cycles inside. A confirmation that can be tabbed out of
  // into the page behind it is a confirmation somebody will approve blind.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, close]);

  // Focus the first field so the keyboard path starts inside the decision, and
  // stop the page behind from scrolling under the sheet on mobile.
  useEffect(() => {
    if (!open) return;
    const node = dialogRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    node?.focus();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  const minReason = reason?.minLength ?? 5;
  const reasonMissing = Boolean(reason?.required) && reasonText.trim().length < minReason;
  // A conflict is terminal for this dialog: the page must be reloaded before the
  // action means anything again, so the confirm button does not come back.
  const canSubmit = !pending && !reasonMissing && !conflict;

  const submit = async () => {
    if (inFlight.current || !canSubmit) return;
    inFlight.current = true;
    setPending(true);
    setError("");
    try {
      const result = await onConfirm({
        reason: reasonText.trim(),
        customerNote: customerText.trim(),
        internalNote: internalText.trim(),
      });
      if (result.ok) {
        setOpen(false);
        setReasonText("");
        setCustomerText("");
        setConflict(null);
        triggerRef.current?.focus();
        return;
      }
      if ("conflict" in result) setConflict(result.conflict);
      else setError(result.error);
    } catch {
      // A thrown fetch is a network failure, not a server refusal. Saying so
      // matters: the action may or may not have been applied, and the honest
      // instruction is to reload rather than to press the button again.
      setConflict({
        message:
          "The request did not reach the server, so it is not known whether this was applied. Reload the order before trying again.",
      });
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const dialog = !open ? null : (
    <div
      className="fixed inset-0 z-[9999] flex items-end justify-center overflow-y-auto p-0 sm:items-center sm:p-4"
      role="presentation"
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden="true"
        onClick={close}
        className="absolute inset-0 bg-black/75"
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={describedId}
        className="relative my-0 w-full max-w-lg rounded-t-2xl border border-zinc-700 bg-zinc-950 p-5 text-brand-text shadow-2xl sm:my-8 sm:rounded-2xl"
      >
        <h2 id={headingId} className="text-lg font-semibold">
          {title}
        </h2>
        <div id={describedId} className="mt-2 text-sm text-brand-textMuted">
          {summary}
        </div>

        {currentState || nextState ? (
          <p className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <span className="rounded-lg border border-zinc-700 bg-black/40 px-2 py-1 text-xs">
              Now: {currentState || "—"}
            </span>
            <span aria-hidden="true" className="text-brand-textMuted">
              →
            </span>
            <span className="rounded-lg border border-brand-primary/50 bg-brand-primary/10 px-2 py-1 text-xs font-medium">
              After: {nextState || "—"}
            </span>
          </p>
        ) : null}

        {effects ? <EffectList effects={effects} /> : null}

        {notificationPreview ? (
          <div className="mt-4 rounded-xl border border-zinc-700 bg-black/30 p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-brand-textMuted">
              What the customer receives
            </p>
            <div className="mt-2 whitespace-pre-wrap text-sm">{notificationPreview}</div>
          </div>
        ) : null}

        {reason ? (
          <label className="mt-4 block text-sm">
            {reason.label}
            {reason.required ? <span className="text-rose-300"> *</span> : null}
            <textarea
              value={reasonText}
              onChange={(event) => setReasonText(event.target.value)}
              maxLength={2000}
              disabled={pending}
              placeholder={reason.placeholder}
              className="ui-input mt-1 min-h-20 w-full"
            />
            {reason.help ? (
              <span className="mt-1 block text-xs text-brand-textMuted">{reason.help}</span>
            ) : null}
          </label>
        ) : null}

        {customerNote ? (
          <label className="mt-4 block text-sm">
            {customerNote.label}
            <textarea
              value={customerText}
              onChange={(event) => setCustomerText(event.target.value)}
              maxLength={2000}
              disabled={pending}
              placeholder={customerNote.placeholder}
              className="ui-input mt-1 min-h-16 w-full"
            />
            <span className="mt-1 block text-xs text-brand-textMuted">
              {customerNote.help ?? "The customer reads this exactly as written."}
            </span>
          </label>
        ) : null}

        {internalNote ? (
          <label className="mt-4 block text-sm">
            {internalNote.label}
            <textarea
              value={internalText}
              onChange={(event) => setInternalText(event.target.value)}
              maxLength={2000}
              disabled={pending}
              placeholder={internalNote.placeholder}
              className="ui-input mt-1 min-h-16 w-full"
            />
            <span className="mt-1 block text-xs text-brand-textMuted">
              {internalNote.help ?? "Staff only. This is never sent to the customer."}
            </span>
          </label>
        ) : null}

        {conflict ? (
          <Notice tone="warning" role="alert" className="mt-4">
            <p className="font-medium">This order changed while you were deciding.</p>
            <p className="mt-1">{conflict.message}</p>
            {conflict.currentState ? (
              <p className="mt-1 text-xs">It is now: {conflict.currentState}.</p>
            ) : null}
            <p className="mt-2 text-xs">
              Nothing was applied. Reload the order and look at it again before repeating this — the action was
              deliberately not retried for you.
            </p>
          </Notice>
        ) : null}

        {error ? (
          <Notice tone="danger" role="alert" className="mt-4">
            {error}
          </Notice>
        ) : null}

        <div className="ui-action-row mt-5 justify-end">
          <button type="button" onClick={close} disabled={pending} className="ui-btn ui-btn-secondary disabled:opacity-40">
            {conflict ? "Close" : "Cancel"}
          </button>
          {conflict ? (
            <button type="button" onClick={() => window.location.reload()} className="ui-btn ui-btn-primary">
              Reload the order
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!canSubmit}
              aria-disabled={!canSubmit}
              className={cx("ui-btn", TONE_BUTTON[tone], "disabled:cursor-not-allowed disabled:opacity-40")}
            >
              {pending ? "Working…" : confirmLabel || label}
            </button>
          )}
        </div>
        {reasonMissing ? (
          <p className="mt-2 text-right text-xs text-amber-200">
            A reason of at least {minReason} characters is required.
          </p>
        ) : null}
      </div>
    </div>
  );

  return (
    <span className={cx("inline-flex flex-col gap-1", className)}>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled || pending}
        onClick={() => {
          setError("");
          setConflict(null);
          setOpen(true);
        }}
        className={cx(
          "ui-btn",
          TONE_BUTTON[tone],
          "disabled:cursor-not-allowed disabled:opacity-40",
          buttonClassName
        )}
      >
        {pending ? "Working…" : label}
      </button>
      {disabledReason ? <span className="text-xs text-amber-200">{disabledReason}</span> : null}
      {mounted && dialog ? createPortal(dialog, document.body) : null}
    </span>
  );
}
